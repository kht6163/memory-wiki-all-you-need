import { db, now, rowToTurn, type Turn, type TurnMessage, type TurnPayload, type TurnResult, type TurnStatus } from "./db.ts";
import { redactSecrets } from "./secrets.ts";
import { HttpError, type ProjectRef, upsertProject } from "./store.ts";

const MAX_TEXT = 4000;
const MAX_TOOL_TEXT = 1500;
const MAX_ARGS = 600;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… [${s.length - n} chars truncated]` : s;
}

function sanitizeMessages(input: unknown): TurnMessage[] {
  if (!Array.isArray(input)) throw new HttpError(400, "messages must be an array");
  const out: TurnMessage[] = [];
  for (const m of input.slice(0, 400)) {
    if (!m || typeof m !== "object") continue;
    const role = (m as TurnMessage).role;
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    const raw = String((m as TurnMessage).text ?? "");
    const msg: TurnMessage = { role, text: redactSecrets(clip(raw, role === "tool" ? MAX_TOOL_TEXT : MAX_TEXT)) };
    if (role === "assistant" && Array.isArray((m as TurnMessage).toolCalls)) {
      msg.toolCalls = (m as TurnMessage).toolCalls!.slice(0, 50).map((c) => ({
        name: String(c?.name ?? "?"),
        args: redactSecrets(clip(String(c?.args ?? ""), MAX_ARGS)),
      }));
    }
    if (role === "tool") {
      msg.name = String((m as TurnMessage).name ?? "?");
      msg.isError = Boolean((m as TurnMessage).isError);
    }
    out.push(msg);
  }
  return out;
}

/** Plain-text rendering used for LLM input and session search. */
export function renderTurn(payload: TurnPayload, opts: { tools?: boolean } = {}): string {
  const lines: string[] = [];
  for (const m of payload.messages) {
    if (m.role === "user") lines.push(`[user]\n${m.text}`);
    else if (m.role === "assistant") {
      if (m.text.trim()) lines.push(`[assistant]\n${m.text}`);
      for (const c of m.toolCalls ?? []) lines.push(`[tool call] ${c.name} ${c.args}`);
    } else if (opts.tools !== false) {
      lines.push(`[tool result: ${m.name}${m.isError ? " ERROR" : ""}]\n${m.text}`);
    }
  }
  return lines.join("\n\n");
}

export interface TurnInput {
  sessionId: string;
  project?: ProjectRef | null;
  client?: string;
  cwd?: string;
  messages: unknown;
}

let notify: (() => void) | null = null;
export function onTurnQueued(fn: () => void) {
  notify = fn;
}

export function enqueueTurn(input: TurnInput): Turn {
  if (!input.sessionId) throw new HttpError(400, "sessionId is required");
  const messages = sanitizeMessages(input.messages);
  if (!messages.length) throw new HttpError(400, "turn has no messages");
  const project = input.project?.key ? upsertProject(input.project) : null;
  const payload: TurnPayload = { messages };
  const res = db
    .prepare(
      `INSERT INTO turns (project_id, session_id, client, cwd, payload, text) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      project?.id ?? null,
      input.sessionId,
      input.client ?? null,
      input.cwd ?? null,
      JSON.stringify(payload),
      renderTurn(payload, { tools: false }),
    );
  notify?.();
  return getTurn(Number(res.lastInsertRowid))!;
}

export function getTurn(id: number): Turn | null {
  const row = db.prepare(`SELECT * FROM turns WHERE id = ?`).get(id);
  return row ? rowToTurn(row) : null;
}

export function listTurns(f: { projectId?: number; status?: string; limit?: number; before?: number } = {}) {
  const where: string[] = ["1=1"];
  const args: (string | number)[] = [];
  if (f.projectId) {
    where.push("t.project_id = ?");
    args.push(f.projectId);
  }
  if (f.status) {
    where.push("t.status = ?");
    args.push(f.status);
  }
  if (f.before) {
    where.push("t.id < ?");
    args.push(f.before);
  }
  args.push(f.limit ?? 50);
  return db
    .prepare(
      `SELECT t.*, p.name AS project_name FROM turns t LEFT JOIN projects p ON p.id = t.project_id
       WHERE ${where.join(" AND ")} ORDER BY t.id DESC LIMIT ?`,
    )
    .all(...args)
    .map((r) => {
      const t = rowToTurn(r);
      const firstUser = t.payload.messages.find((m) => m.role === "user")?.text ?? "";
      return {
        id: t.id,
        project_id: t.project_id,
        project_name: r.project_name == null ? null : String(r.project_name),
        session_id: t.session_id,
        client: t.client,
        status: t.status,
        error: t.error,
        created_at: t.created_at,
        processed_at: t.processed_at,
        prompt: firstUser.slice(0, 200),
        applied: t.result?.applied ?? [],
        note: t.result?.note ?? null,
      };
    });
}

export function claimNextTurn(): Turn | null {
  const row = db.prepare(`SELECT id FROM turns WHERE status = 'pending' ORDER BY id LIMIT 1`).get();
  if (!row) return null;
  const id = Number(row.id);
  const res = db.prepare(`UPDATE turns SET status = 'processing' WHERE id = ? AND status = 'pending'`).run(id);
  return res.changes ? getTurn(id) : null;
}

export function finishTurn(id: number, status: TurnStatus, result: TurnResult | null, error: string | null = null) {
  db.prepare(`UPDATE turns SET status = ?, result = ?, error = ?, processed_at = ? WHERE id = ?`).run(
    status,
    result ? JSON.stringify(result) : null,
    error,
    now(),
    id,
  );
}

export function retryTurn(id: number): Turn {
  const t = getTurn(id);
  if (!t) throw new HttpError(404, "turn not found");
  if (t.status === "processing") throw new HttpError(409, "turn is being processed");
  db.prepare(`UPDATE turns SET status = 'pending', error = NULL WHERE id = ?`).run(id);
  notify?.();
  return getTurn(id)!;
}

export function deleteTurn(id: number) {
  db.prepare(`DELETE FROM turns WHERE id = ?`).run(id);
}
