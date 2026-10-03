import { config, llmEnabled } from "./config.ts";
import { db, rowToEntry, type Entry, type Project, type Turn, type TurnResult } from "./db.ts";
import { chatJson } from "./llm.ts";
import { searchEntries } from "./search.ts";
import {
  ACTIVE_SQL,
  createEntry,
  deleteEntry,
  getEntry,
  getProject,
  isActive,
  listEntries,
  normalizeValidUntil,
  policyPrompt,
  projectLabel,
  recordEntryTurn,
  replaceExactlyOnce,
  updateEntry,
  type WriteMeta,
} from "./store.ts";
import { ENTITY_KINDS, type EntityInput } from "./entities.ts";
import {
  addLink,
  claimGraphJob,
  entitiesOf,
  entityEntries,
  getEntity,
  isLinkType,
  linksOf,
  mentionedEntities,
  onGraphJobQueued,
} from "./graph.ts";
import { claimDueJob, nextJobDueInMs, onWikiJobQueued } from "./wiki.ts";
import { processWikiJob } from "./wiki-worker.ts";
import { processGraphJob } from "./graph-worker.ts";
import { claimReviewJob, onReviewJobQueued, scheduleDueReviews } from "./review.ts";
import { processReviewJob } from "./review-worker.ts";
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
- guesses not confirmed in the turn: a claim that appears only in the assistant's own reasoning or plan is not a fact until a tool result, the user or the code backs it (what the agent actually did and verified — "fixed X by doing Y" — does count)
- an assistant message that only repeats or acknowledges what the user said (store the user's fact once, not the echo)
- secrets, tokens, passwords, keys (never copy them, even partially)
- anything the agent already saved in this turn via memory_add/memory_replace (see tool calls) — but do give those memories entities and links (see Graph)

Scopes:
- "project": specific to the current project/repository (only allowed when a project is given)
- "global": applies across projects (e.g. server-wide conventions, environment facts)
- "user": about the user as a person (preferences, communication style, background)

Rules:
- Prefer updating an existing memory over adding a near-duplicate. Merge related facts into one entry. Memories from earlier turns of this session are among the candidates: extend them instead of repeating them.
- When the world changed (switched library, moved a path, upgraded a version, reversed a decision): add the new memory with a "supersedes" link to the old one. The old one is then kept as history and no longer injected — do not also delete it. Use update for corrections/refinements of the same fact, delete only for memories that were wrong from the start or are noise.
- Multiple values are not a contradiction: "uses PostgreSQL" and "also uses Redis" can both be true; only replace/supersede when the new fact makes the old one false.
- valid_until (YYYY-MM-DD, optional): only for facts that are true until a known date or event (a temporary workaround until a release, a freeze until a date, a sprint's branch). Leave it out for lasting facts.
- keywords (0-8, optional): other words someone might search for to find this memory and that are NOT already in title/body — synonyms, the English/Korean translation, abbreviations, alternate spellings ("Postgres", "포스트그레스"). They are only used for search, never shown to the agent.
- Only reference ids from the EXISTING MEMORIES list.
- edit: for a small change to a long body (fix a value, add or drop a line), prefer {"op":"edit","id":N,"old":"...","new":"..."} over update: "old" is copied verbatim from the body and must occur in it exactly once (include enough surrounding text to make it unique); it is replaced by "new". Nothing else changes. Use update with a full "body" only when rewriting the memory, and never drop still-true lines when you do.
- confirm: when the turn relies on or re-states an existing memory that is still accurate and needs no change, return {"op":"confirm","id":N} instead of an update (at most a few per turn). It changes nothing; it only records that the memory is still in use.
- Write titles and bodies in the same language the user writes in (Korean if the user writes Korean). Keep technical identifiers as-is.
- title: short and specific (<= 80 chars). body: concise, self-contained markdown (1-6 lines). Include the "why" when known.
- tags: 0-5 short lowercase keywords.
- Dates: memories are kept indefinitely, so never write relative times ("today", "yesterday", "recently", "last week"). Resolve them against TURN DATE (when the turn happened — not TODAY) into absolute dates (YYYY-MM-DD). Keep exact versions, paths, flags, ports and error strings as written; never generalize identifiers.
- Most turns need no change. Returning no ops is normal.

Graph (memories are also nodes of a knowledge graph):
- entities: the concrete things a memory is about — technologies, libraries, databases, services/containers, tools/CLIs, files/paths, named concepts, people. 1-6 per memory. Name them canonically WITHOUT versions ("PostgreSQL", not "PostgreSQL 16"; the version belongs in the body). Product, tool and file names as they are spelled officially; generic concepts in the language of the memory (Korean memory → "세션 캐시", not "session cache"). Reuse the exact spelling from KNOWN ENTITIES when it is the same thing. kind: ${ENTITY_KINDS.join(" | ")}.
- links: typed relations from this memory to other EXISTING MEMORIES ids:
  - "because": this memory exists because of the other (a decision because of a failure)
  - "depends_on": this only holds / works if the other holds
  - "supersedes": this replaces the other (the other then becomes history automatically)
  - "related": closely related, nothing more specific fits
  Only link when the relation is real and useful; most memories need 0-2 links.
- Give entities on every add. On update, entities REPLACE the memory's entity list (omit to keep it).
- Graph upkeep is expected even when nothing else changes: every EXISTING memory this turn is about that has "entities": [] (e.g. one the agent just saved with memory_add) MUST get an update op with only "id", "entities" and, where real, "links". Also add links between existing memories when this turn reveals a relation (op "link").
- {"op":"link"} relates two existing memories without changing them.

Respond with ONLY a JSON object:
{"ops":[
  {"op":"add","scope":"project|global|user","category":"...","title":"...","body":"...","tags":["..."],"keywords":["..."],"valid_until":"YYYY-MM-DD","entities":[{"name":"...","kind":"tech"}],"links":[{"to":123,"type":"because"}]},
  {"op":"update","id":123,"title":"...","body":"...","category":"...","tags":["..."],"keywords":["..."],"entities":[{"name":"...","kind":"..."}],"links":[{"to":45,"type":"related"}],"reason":"..."},
  {"op":"edit","id":123,"old":"exact text from the body","new":"replacement","reason":"..."},
  {"op":"delete","id":123,"reason":"..."},
  {"op":"confirm","id":123},
  {"op":"link","from":123,"to":45,"type":"depends_on"}
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
  if (project) for (const e of listEntries({ scope: "project", projectId: project.id, limit: 15, activeOnly: true })) seen.set(e.id, e);
  for (const e of listEntries({ scope: "user", limit: 10, activeOnly: true })) seen.set(e.id, e);
  // Memories written by the previous turns of this session: keyword search can
  // miss them, and they are the likeliest near-duplicates of what this turn adds.
  for (const e of sessionRecentEntries(turn, project, 10)) seen.set(e.id, e);
  // Graph: memories about the entities this turn talks about, even when the wording differs.
  let extra = 0;
  for (const entId of mentionedEntities(query, 8)) {
    for (const e of entityEntries(entId, project?.id ?? null, { activeOnly: true, limit: 4 })) {
      if (extra >= 12) break;
      if (!seen.has(e.id)) extra++;
      seen.set(e.id, e);
    }
  }
  return [...seen.values()].filter((e) => e.category !== "standing");
}

/** Live, current memories added or changed by the last few turns of the same session. */
function sessionRecentEntries(turn: Turn, project: Project | null, limit: number): Entry[] {
  return db
    .prepare(
      `SELECT DISTINCT e.* FROM revisions r JOIN entries e ON e.id = r.entry_id
       WHERE r.turn_id IN (SELECT id FROM turns WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT 5)
         AND e.deleted_at IS NULL AND (e.scope IN ('global','user') OR e.project_id = ?) AND ${ACTIVE_SQL("e")}
       ORDER BY e.updated_at DESC LIMIT ?`,
    )
    .all(turn.session_id, turn.id, project?.id ?? -1, limit)
    .map(rowToEntry);
}

function fmtCandidate(e: Entry, ids: Set<number>): string {
  const links = linksOf(e.id)
    .filter((l) => l.dir === "out" && ids.has(l.other.id))
    .map((l) => ({ to: l.other.id, type: l.type }));
  return JSON.stringify({
    id: e.id, scope: e.scope, category: e.category, title: e.title, body: e.body, tags: e.tags,
    ...(e.keywords.length ? { keywords: e.keywords } : {}),
    ...(e.valid_until ? { valid_until: e.valid_until } : {}),
    entities: entitiesOf(e.id).map((n) => n.name),
    ...(links.length ? { links } : {}),
    updated: e.updated_at.slice(0, 10),
  });
}

/** Entity names to reuse: those on the candidates plus those mentioned in the turn. */
function knownEntities(candidates: Entry[], text: string): string[] {
  const names = new Map<string, string>();
  for (const id of mentionedEntities(text, 30)) {
    const n = getEntity(id);
    if (n) names.set(n.name, `${n.name} (${n.kind})`);
  }
  for (const c of candidates) for (const n of entitiesOf(c.id)) names.set(n.name, `${n.name} (${n.kind})`);
  return [...names.values()].slice(0, 80);
}

function buildUserPrompt(turn: Turn, project: Project | null, candidates: Entry[]): string {
  const ids = new Set(candidates.map((c) => c.id));
  const known = knownEntities(candidates, turn.text);
  const policy = policyPrompt(project?.id ?? null);
  let transcript = renderTurn(turn.payload);
  if (transcript.length > 40_000) transcript = `${transcript.slice(0, 12_000)}\n\n… [middle of turn omitted] …\n\n${transcript.slice(-26_000)}`;
  return [
    `CURRENT PROJECT: ${project ? projectLabel(project) : "none — do not use scope \"project\""}`,
    // The queue can lag behind (sequential curation, restarts): relative times
    // in the turn are anchored to when it happened, not to when it is curated.
    `TURN DATE: ${localDate(turn.created_at)} (${config.timezone})`,
    `TODAY: ${localDate(new Date().toISOString())}`,
    "",
    "EXISTING MEMORIES (most relevant):",
    candidates.length ? candidates.map((c) => fmtCandidate(c, ids)).join("\n") : "(none)",
    "",
    "KNOWN ENTITIES (reuse these spellings):",
    known.length ? known.join(", ") : "(none yet)",
    "",
    "TURN TRANSCRIPT:",
    transcript,
    ...(policy ? ["", policy] : []),
  ].join("\n");
}

/** YYYY-MM-DD of an ISO timestamp in the configured time zone. */
export function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

type Op = Record<string, unknown>;

export function applyMemoryOps(
  ops: Op[],
  project: Project | null,
  allowed: Set<number>,
  meta: WriteMeta,
  label: string,
): { applied: TurnResult["applied"]; skipped: NonNullable<TurnResult["skipped"]> } {
  const applied: TurnResult["applied"] = [];
  const skipped: NonNullable<TurnResult["skipped"]> = [];
  // Links may only point at memories the LLM was shown (or just created in this batch).
  const linkable = new Set(allowed);
  const linkFrom = (from: number, raw: unknown) => {
    if (!Array.isArray(raw)) return;
    for (const l of raw.slice(0, 6) as Record<string, unknown>[]) {
      const to = Number(l?.to);
      if (!linkable.has(to) || to === from || !isLinkType(l?.type)) continue;
      try {
        addLink(from, to, l.type, meta.author);
      } catch (err) {
        console.warn(`[worker] ${label}: link rejected: ${(err as Error).message}`);
      }
    }
  };
  for (const op of ops.slice(0, 20)) {
    try {
      const kind = String(op.op ?? "");
      const category = CATEGORY_LIST.includes(String(op.category)) ? String(op.category) : undefined;
      const tags = Array.isArray(op.tags) ? op.tags.map(String) : undefined;
      const entities = Array.isArray(op.entities) ? (op.entities as EntityInput[]) : undefined;
      const keywords = Array.isArray(op.keywords) ? op.keywords.map(String) : undefined;
      // A malformed date from the LLM is dropped rather than failing the whole op.
      let validUntil: string | undefined;
      try {
        validUntil = op.valid_until ? normalizeValidUntil(op.valid_until) ?? undefined : undefined;
      } catch {
        validUntil = undefined;
      }
      if (kind === "link") {
        const from = Number(op.from);
        if (!linkable.has(from)) continue;
        linkFrom(from, [{ to: op.to, type: op.type }]);
        continue;
      }
      if (kind === "add") {
        let scope = String(op.scope ?? "project") as Entry["scope"];
        if (!["project", "global", "user"].includes(scope)) scope = project ? "project" : "global";
        if (scope === "project" && !project) scope = "global";
        const title = String(op.title ?? "");
        const dup = exactDuplicate(scope, scope === "project" ? project!.id : null, title, String(op.body ?? ""));
        if (dup) {
          // Same text already stored: nothing to add (the LLM missed it among the candidates,
          // or the agent saved it with memory_add during the turn).
          skipped.push({ op: "add", title, reason: "duplicate", entryId: dup });
          // A copy created by an earlier add of this batch is not a re-statement by a later turn.
          const sameBatch = applied.some((a) => a.op === "add" && a.entryId === dup);
          if (meta.turnId != null && !sameBatch) recordEntryTurn(dup, meta.turnId, "duplicate");
          // Standing instructions are human-only (G-002): never link from or tag one.
          if (getEntry(dup)?.category === "standing") continue;
          // The rest of the op still counts: its links (a "supersedes" retires the old fact)...
          linkable.add(dup);
          linkFrom(dup, op.links);
          // ...and its entities, when the stored copy has none yet (never replaces existing ones).
          if (entities?.length && !entitiesOf(dup).length) {
            try {
              updateEntry(dup, { entities }, { ...meta, reason: op.reason ? String(op.reason) : meta.reason ?? null });
            } catch (err) {
              console.warn(`[worker] ${label}: entities for duplicate #${dup} rejected: ${(err as Error).message}`);
            }
          }
          continue;
        }
        const e = createEntry(
          {
            scope,
            project_id: scope === "project" ? project!.id : null,
            category: category ?? "fact",
            title,
            body: String(op.body ?? ""),
            tags,
            entities,
            keywords,
            valid_until: validUntil,
          },
          { ...meta, reason: op.reason ? String(op.reason) : meta.reason ?? null },
        );
        linkable.add(e.id);
        linkFrom(e.id, op.links);
        applied.push({ op: "add", entryId: e.id, title: e.title });
        if (meta.turnId != null) recordEntryTurn(e.id, meta.turnId, "add");
      } else if (kind === "update" || kind === "edit" || kind === "delete" || kind === "confirm") {
        const id = Number(op.id);
        if (!allowed.has(id)) continue;
        const current = getEntry(id);
        if (!current) continue;
        if (kind === "confirm") {
          // Provenance only: no revision, no updated_at change, so the stable block does not move (G-005).
          // Skipped when an earlier op of this batch already touched the memory (a delete,
          // an update, a repeated confirm) or retired it (an add that supersedes it).
          if (meta.turnId == null || current.deleted_at || applied.some((a) => a.entryId === id) || !isActive(current)) continue;
          applied.push({ op: "confirm", entryId: id, title: current.title });
          recordEntryTurn(id, meta.turnId, "confirm");
        } else if (kind === "edit") {
          // Exact-substring replacement (never fuzzy): the LLM changes one passage of a long
          // body without re-emitting it, so it cannot silently drop lines it did not mean to touch.
          if (current.deleted_at || current.category === "standing") continue;
          const r = replaceExactlyOnce(current.body, op.old, op.new);
          if ("error" in r) {
            skipped.push({ op: "edit", title: current.title, reason: r.error, entryId: id });
            continue;
          }
          const e = updateEntry(id, { body: r.body }, { ...meta, reason: op.reason ? String(op.reason) : meta.reason ?? null });
          applied.push({ op: "update", entryId: e.id, title: e.title });
          if (meta.turnId != null) recordEntryTurn(e.id, meta.turnId, "update");
        } else if (kind === "update") {
          const e = updateEntry(
            id,
            {
              title: op.title != null ? String(op.title) : undefined,
              body: op.body != null ? String(op.body) : undefined,
              category,
              tags,
              entities,
              keywords,
              ...(validUntil ? { valid_until: validUntil } : {}),
            },
            { ...meta, reason: op.reason ? String(op.reason) : meta.reason ?? null },
          );
          linkFrom(e.id, op.links);
          applied.push({ op: "update", entryId: e.id, title: e.title });
          if (meta.turnId != null) recordEntryTurn(e.id, meta.turnId, "update");
        } else {
          const e = deleteEntry(id, { ...meta, reason: op.reason ? String(op.reason) : meta.reason ?? null });
          applied.push({ op: "delete", entryId: e.id, title: e.title });
        }
      }
    } catch (err) {
      console.warn(`[worker] ${label}: op rejected: ${(err as Error).message}`);
    }
  }
  return { applied, skipped };
}

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Id of a current memory in the same scope (and project) with the same title
 * and body, ignoring case and spacing. Superseded/expired copies do not count:
 * the LLM never sees them, and re-adding the fact must bring it back.
 */
function exactDuplicate(scope: string, projectId: number | null, title: string, body: string): number | null {
  const t = normText(title);
  if (!t) return null;
  const b = normText(body);
  // SQLite's lower() is ASCII-only, so compare in JS; length() bounds the rows read.
  const rows = db
    .prepare(
      `SELECT id, title, body FROM entries
       WHERE deleted_at IS NULL AND scope = ? AND IFNULL(project_id, 0) = ? AND ${ACTIVE_SQL("entries")}
         AND length(body) BETWEEN ? AND ?`,
    )
    .all(scope, projectId ?? 0, Math.floor(b.length * 0.5), b.length * 2 + 20);
  for (const r of rows) if (normText(String(r.title)) === t && normText(String(r.body)) === b) return Number(r.id);
  return null;
}

function isTrivial(turn: Turn): boolean {
  const msgs = turn.payload.messages;
  const hasTools = msgs.some((m) => m.role === "tool" || (m.toolCalls?.length ?? 0) > 0);
  const chars = msgs.filter((m) => m.role !== "tool").reduce((n, m) => n + m.text.trim().length, 0);
  return !hasTools && chars < 15;
}

export async function processTurn(turn: Turn) {
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
  const { applied, skipped } = applyMemoryOps(ops, project, new Set(candidates.map((c) => c.id)), { author: "llm", turnId: turn.id, origin: "turn" }, `turn ${turn.id}`);
  finishTurn(turn.id, "done", {
    ops,
    applied,
    ...(skipped.length ? { skipped } : {}),
    note: typeof obj.note === "string" ? obj.note : undefined,
    model: config.llm.model,
    ms: Date.now() - started,
  });
  console.log(`[worker] turn ${turn.id} done: ${applied.length} change(s) in ${Date.now() - started}ms`);
}

/** How often the idle worker checks for scheduled reviews (REVIEW_EVERY_DAYS). */
const SCHEDULE_CHECK_MS = 3_600_000;

/** Called when nothing is claimable: a wiki job waiting for its run_after is still queued work, so wait for it first. */
const scheduleReviewsIfIdle = () => (nextJobDueInMs() == null ? scheduleDueReviews() : []);

/**
 * Process every queued turn and job once, then return (tests and one-off scripts; the server uses startWorker).
 * schedule: when the queue is empty, also run the scheduled-review check once (off by default so tests stay deterministic).
 */
export async function runQueueOnce(opts: { schedule?: boolean } = {}) {
  let scheduled = !opts.schedule;
  const drain = async () => {
    for (let turn = claimNextTurn(); turn; turn = claimNextTurn()) {
      try {
        await processTurn(turn);
      } catch (err) {
        finishTurn(turn.id, "error", null, (err as Error).message);
      }
    }
  };
  for (;;) {
    await drain();
    const job = claimDueJob();
    if (job) {
      await processWikiJob(job, drain);
      continue;
    }
    const gjob = claimGraphJob();
    if (gjob) {
      await processGraphJob(gjob, drain);
      continue;
    }
    const rjob = claimReviewJob();
    if (rjob) {
      await processReviewJob(rjob, drain);
      continue;
    }
    if (!scheduled) {
      scheduled = true;
      if (scheduleReviewsIfIdle().length) continue;
    }
    return;
  }
}

export function startWorker() {
  let running = false;
  let wake: (() => void) | null = null;
  const poke = () => wake?.();
  let lastScheduleCheck = 0;
  onTurnQueued(poke);
  onWikiJobQueued(poke);
  onGraphJobQueued(poke);
  onReviewJobQueued(poke);

  // One loop for all LLM work: turn curation first (it keeps memory current
  // for the next request), then requested wiki compose, graph backfill and memory review jobs. Serial, so the
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
      const gjob = claimGraphJob();
      if (gjob) {
        await processGraphJob(gjob, drainTurns);
        continue;
      }
      const rjob = claimReviewJob();
      if (rjob) {
        await processReviewJob(rjob, drainTurns);
        continue;
      }
      // Idle: nothing claimable is queued. Scheduled reviews only enqueue; the next pass runs them.
      if (config.review.everyDays > 0 && Date.now() - lastScheduleCheck >= SCHEDULE_CHECK_MS && nextJobDueInMs() == null) {
        lastScheduleCheck = Date.now();
        try {
          if (scheduleDueReviews().length) continue;
        } catch (err) {
          console.error("[worker] scheduled review check failed:", (err as Error).message);
        }
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
