import { config, llmEnabled } from "./config.ts";
import type { Entry, Project, Turn, TurnResult } from "./db.ts";
import { chatJson } from "./llm.ts";
import { searchEntries } from "./search.ts";
import { createEntry, deleteEntry, getEntry, getProject, listEntries, updateEntry, type WriteMeta } from "./store.ts";
import { claimDueJob, nextJobDueInMs, onWikiJobQueued } from "./wiki.ts";
import { processWikiJob } from "./wiki-worker.ts";
import { claimNextTurn, finishTurn, onTurnQueued, renderTurn } from "./turns.ts";

// Turn curation: one LLM call per finished turn decides which durable
// memories to add, update or delete, with the most relevant existing
// memories in view so it merges instead of duplicating. Turns are processed
// one at a time so two turns never race on the same entry.

const SYSTEM_PROMPT = `You are the memory curator for a coding agent ("pi"). After every conversation turn you decide what the agent should durably remember for future sessions, and you keep the memory store clean.

Remember (only if it will plausibly matter in a FUTURE session):
- user preferences, working style, and corrections the user made ("no, use pnpm") -> category "preference" or "correction"
- project conventions, architecture, layout, commands, ports, paths, deploy steps -> "convention" / "fact"
- decisions and their reasons -> "decision"
- what failed and why, so it is not retried -> "failure"
- tool / library / environment quirks -> "tool-quirk"
- non-obvious lessons -> "insight"

Do NOT remember:
- transient task progress, TODOs of this turn, or the conversation itself
- things obvious from reading the code, or generic programming knowledge
- guesses not confirmed in the turn
- secrets, tokens, passwords, keys (never copy them, even partially)
- anything the agent already saved in this turn via memory_add/memory_replace (see tool calls)

Scopes:
- "project": specific to the current project/repository (only allowed when a project is given)
- "global": applies across projects (e.g. server-wide conventions, environment facts)
- "user": about the user as a person (preferences, communication style, background)

Rules:
- Prefer updating an existing memory over adding a near-duplicate. Merge related facts into one entry.
- If the turn shows an existing memory is wrong or obsolete, update it (or delete it when nothing remains true).
- Only reference ids from the EXISTING MEMORIES list.
- Write titles and bodies in the same language the user writes in (Korean if the user writes Korean). Keep technical identifiers as-is.
- title: short and specific (<= 80 chars). body: concise, self-contained markdown (1-6 lines). Include the "why" when known.
- tags: 0-5 short lowercase keywords.
- Most turns need no change. Returning no ops is normal.

Respond with ONLY a JSON object:
{"ops":[
  {"op":"add","scope":"project|global|user","category":"...","title":"...","body":"...","tags":["..."]},
  {"op":"update","id":123,"title":"...","body":"...","category":"...","tags":["..."],"reason":"..."},
  {"op":"delete","id":123,"reason":"..."}
],"note":"one short sentence on what you did and why"}`;

export const CATEGORY_LIST = ["fact", "convention", "preference", "decision", "failure", "correction", "insight", "tool-quirk"];

function candidateEntries(turn: Turn, project: Project | null): Entry[] {
  const query = turn.payload.messages
    .filter((m) => m.role !== "tool")
    .map((m) => m.text)
    .join("\n")
    .slice(0, 4000);
  const seen = new Map<number, Entry>();
  for (const h of searchEntries(query, { projectId: project?.id ?? null, limit: 25 })) seen.set(h.entry.id, h.entry);
  // Always show the freshest memories of this project and the user profile so
  // recently learned facts get merged rather than duplicated.
  if (project) for (const e of listEntries({ scope: "project", projectId: project.id, limit: 15 })) seen.set(e.id, e);
  for (const e of listEntries({ scope: "user", limit: 10 })) seen.set(e.id, e);
  return [...seen.values()].filter((e) => e.category !== "standing");
}

function fmtCandidate(e: Entry): string {
  return JSON.stringify({ id: e.id, scope: e.scope, category: e.category, title: e.title, body: e.body, tags: e.tags, updated: e.updated_at.slice(0, 10) });
}

function buildUserPrompt(turn: Turn, project: Project | null, candidates: Entry[]): string {
  let transcript = renderTurn(turn.payload);
  if (transcript.length > 40_000) transcript = `${transcript.slice(0, 12_000)}\n\n… [middle of turn omitted] …\n\n${transcript.slice(-26_000)}`;
  return [
    `CURRENT PROJECT: ${project ? `${project.name} (${project.key})` : "none — do not use scope \"project\""}`,
    `DATE: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "EXISTING MEMORIES (most relevant):",
    candidates.length ? candidates.map(fmtCandidate).join("\n") : "(none)",
    "",
    "TURN TRANSCRIPT:",
    transcript,
  ].join("\n");
}

type Op = Record<string, unknown>;

export function applyMemoryOps(
  ops: Op[],
  project: Project | null,
  allowed: Set<number>,
  meta: WriteMeta,
  label: string,
): TurnResult["applied"] {
  const applied: TurnResult["applied"] = [];
  for (const op of ops.slice(0, 20)) {
    try {
      const kind = String(op.op ?? "");
      const category = CATEGORY_LIST.includes(String(op.category)) ? String(op.category) : undefined;
      const tags = Array.isArray(op.tags) ? op.tags.map(String) : undefined;
      if (kind === "add") {
        let scope = String(op.scope ?? "project") as Entry["scope"];
        if (!["project", "global", "user"].includes(scope)) scope = project ? "project" : "global";
        if (scope === "project" && !project) scope = "global";
        const e = createEntry(
          {
            scope,
            project_id: scope === "project" ? project!.id : null,
            category: category ?? "fact",
            title: String(op.title ?? ""),
            body: String(op.body ?? ""),
            tags,
          },
          { ...meta, reason: op.reason ? String(op.reason) : meta.reason ?? null },
        );
        applied.push({ op: "add", entryId: e.id, title: e.title });
      } else if (kind === "update" || kind === "delete") {
        const id = Number(op.id);
        if (!allowed.has(id) || !getEntry(id)) continue;
        if (kind === "update") {
          const e = updateEntry(
            id,
            {
              title: op.title != null ? String(op.title) : undefined,
              body: op.body != null ? String(op.body) : undefined,
              category,
              tags,
            },
            { ...meta, reason: op.reason ? String(op.reason) : meta.reason ?? null },
          );
          applied.push({ op: "update", entryId: e.id, title: e.title });
        } else {
          const e = deleteEntry(id, { ...meta, reason: op.reason ? String(op.reason) : meta.reason ?? null });
          applied.push({ op: "delete", entryId: e.id, title: e.title });
        }
      }
    } catch (err) {
      console.warn(`[worker] ${label}: op rejected: ${(err as Error).message}`);
    }
  }
  return applied;
}

function isTrivial(turn: Turn): boolean {
  const msgs = turn.payload.messages;
  const hasTools = msgs.some((m) => m.role === "tool" || (m.toolCalls?.length ?? 0) > 0);
  const chars = msgs.filter((m) => m.role !== "tool").reduce((n, m) => n + m.text.trim().length, 0);
  return !hasTools && chars < 15;
}

async function processTurn(turn: Turn) {
  const started = Date.now();
  const project = turn.project_id ? getProject(turn.project_id) : null;
  if (!llmEnabled()) return finishTurn(turn.id, "skipped", null, "LLM is not configured (LLM_BASE_URL)");
  if (isTrivial(turn)) return finishTurn(turn.id, "skipped", { ops: [], applied: [], note: "trivial turn" });

  const candidates = candidateEntries(turn, project);
  const { data } = await chatJson([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(turn, project, candidates) },
  ]);
  const obj = (data ?? {}) as { ops?: unknown; note?: unknown };
  const ops = Array.isArray(obj.ops) ? (obj.ops as Op[]) : [];
  const applied = applyMemoryOps(ops, project, new Set(candidates.map((c) => c.id)), { author: "llm", turnId: turn.id, origin: "turn" }, `turn ${turn.id}`);
  finishTurn(turn.id, "done", {
    ops,
    applied,
    note: typeof obj.note === "string" ? obj.note : undefined,
    model: config.llm.model,
    ms: Date.now() - started,
  });
  console.log(`[worker] turn ${turn.id} done: ${applied.length} change(s) in ${Date.now() - started}ms`);
}

export function startWorker() {
  let running = false;
  let wake: (() => void) | null = null;
  const poke = () => wake?.();
  onTurnQueued(poke);
  onWikiJobQueued(poke);

  // One loop for all LLM work: turn curation first (it keeps memory current
  // for the next request), then requested wiki compose jobs. Serial, so the
  // LLM endpoint never sees more than one request from this server at a time.
  const loop = async () => {
    if (running) return;
    running = true;
    const drainTurns = async () => {
      for (let turn = claimNextTurn(); turn; turn = claimNextTurn()) {
        try {
          await processTurn(turn);
        } catch (err) {
          console.error(`[worker] turn ${turn.id} failed:`, (err as Error).message);
          finishTurn(turn.id, "error", null, (err as Error).message);
        }
      }
    };
    for (;;) {
      await drainTurns();
      const job = claimDueJob();
      if (job) {
        // Queued turns are curated between compose chunks too.
        await processWikiJob(job, drainTurns);
        continue;
      }
      const due = nextJobDueInMs();
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, Math.min(due ?? 30_000, 30_000));
      });
      wake = null;
    }
  };
  void loop();
}
