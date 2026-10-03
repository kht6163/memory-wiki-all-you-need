import { config, llmEnabled } from "./config.ts";
import { CATEGORIES, db, now, rowToEntry, transaction, type Entry } from "./db.ts";
import { entryEntitiesDroppedByEdit, entityNamesOf, entityNorm } from "./entities.ts";
import { moveLinks } from "./graph.ts";
import { searchEntries } from "./search.ts";
import { findSecrets } from "./secrets.ts";
import { ACTIVE_SQL, HttpError, NOT_SUPERSEDED_SQL, deleteEntry, entryState, getEntry, getProject, updateEntry, type ExactEditError } from "./store.ts";

// Memory review: an LLM pass over existing memories (cluster by cluster) that
// PROPOSES merges, fixes, deletions and flags conflicts. Proposals wait for a
// person; applying one re-checks that the memories did not change meanwhile.

export type ProposalKind = "merge" | "update" | "delete" | "conflict";
export type ProposalStatus = "pending" | "applied" | "dismissed" | "stale";

export interface ReviewJob {
  id: number;
  project_id: number | null;
  status: "pending" | "processing" | "done" | "skipped" | "error" | "cancelled";
  /** scheduled: queued by scheduleDueReviews (REVIEW_EVERY_DAYS), not by a person. */
  payload: { entries: number[]; scheduled?: boolean };
  /** dropped: LLM proposals that were not stored and why (first DROPPED_KEPT); dropped_count: all of them. */
  result: {
    done?: number[];
    chunks?: number;
    proposals?: number;
    dropped?: DroppedProposal[];
    dropped_count?: number;
    /** Global/user memories shown as read-only context (project reviews; summed over batches). */
    cross_scope?: number;
    /** Memories whose body was longer than the LLM was shown (first DROPPED_KEPT ids; truncated_count counts all). */
    truncated?: number[];
    truncated_count?: number;
    ms?: number;
  } | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

/** An LLM proposal that was not stored: kept on the job result so nothing is dropped silently. */
export interface DroppedProposal {
  kind: string;
  ids: number[];
  reason: string;
}
export const DROPPED_KEPT = 50;

export interface ExactEdit {
  old: string;
  new: string;
}

export interface Proposal {
  id: number;
  job_id: number;
  kind: ProposalKind;
  entry_ids: number[];
  /** merge/update: the new title/body/category; snap: each memory's latest revision id when the LLM read it. */
  data: {
    title?: string;
    body?: string;
    category?: string;
    note?: string;
    /** update only: replace these exact passages (each occurring once in the body, not overlapping) instead of rewriting the body. */
    edits?: ExactEdit[];
    /** Legacy (v0.6.0) single edit: still read and applied for proposals stored before data.edits. */
    edit?: ExactEdit;
    /** update only: the memory's new full entity list, a subset of its entities at proposal time (absent = keep). */
    entities?: string[];
    /** delete only: why a person should look twice (Korean, shown on the card); set by markReasonDeletes. */
    warning?: string;
    /**
     * delete/update of a project review only: the global/user memory (shown read-only) that already
     * states what the project memory repeats, and its version then. Apply checks it is unchanged.
     */
    covered_by?: number;
    covered_snap?: string;
    snap: Record<string, string>;
  };
  reason: string;
  status: ProposalStatus;
  created_at: string;
  decided_at: string | null;
}

type Row = Record<string, unknown>;
const toJob = (r: Row): ReviewJob => ({
  id: Number(r.id),
  project_id: r.project_id == null ? null : Number(r.project_id),
  status: r.status as ReviewJob["status"],
  payload: JSON.parse(String(r.payload ?? "{}")),
  result: r.result == null ? null : JSON.parse(String(r.result)),
  error: r.error == null ? null : String(r.error),
  created_at: String(r.created_at),
  processed_at: r.processed_at == null ? null : String(r.processed_at),
});
const toProposal = (r: Row): Proposal => ({
  id: Number(r.id),
  job_id: Number(r.job_id),
  kind: r.kind as ProposalKind,
  entry_ids: JSON.parse(String(r.entry_ids)),
  data: JSON.parse(String(r.data ?? "{}")),
  reason: String(r.reason ?? ""),
  status: r.status as ProposalStatus,
  created_at: String(r.created_at),
  decided_at: r.decided_at == null ? null : String(r.decided_at),
});

// ------------------------------------------------------------------ scope

/** Whether a memory belongs to a review scope (a project's own, or global + user for null). */
export const inScope = (e: Entry, projectId: number | null) => (projectId ? e.project_id === projectId : e.scope === "global" || e.scope === "user");

/** Memories a review covers: a project's own, or (null) global + user. Never standing instructions. */
export function reviewScopeEntries(projectId: number | null): Entry[] {
  const where = projectId ? "e.project_id = ?" : "e.scope IN ('global','user')";
  return db
    // Superseded memories are history kept on purpose; expired ones stay in (the LLM may propose deleting them).
    .prepare(
      `SELECT e.* FROM entries e WHERE e.deleted_at IS NULL AND e.category != 'standing' AND ${where}
         AND ${NOT_SUPERSEDED_SQL("e")}
       ORDER BY e.id`,
    )
    .all(...(projectId ? [projectId] : []))
    .map(rowToEntry);
}

/**
 * Group memories so likely duplicates and contradictions land in the same LLM
 * call: by shared entity first (largest entity groups first, each memory used
 * once), then the rest by scope + category. Bounded by REVIEW_CHUNK_CHARS.
 */
export function buildReviewBatches(entries: Entry[], fmt: (e: Entry) => string, budget = config.review.chunkChars): Entry[][] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const groups: Entry[][] = [];
  const used = new Set<number>();
  if (entries.length) {
    const ids = entries.map((e) => e.id);
    const rows: { entry_id: number; entity_id: number }[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const r of db.prepare(`SELECT entry_id, entity_id FROM entry_entities WHERE entry_id IN (${part.map(() => "?").join(",")})`).all(...part))
        rows.push({ entry_id: Number(r.entry_id), entity_id: Number(r.entity_id) });
    }
    const byEntity = new Map<number, number[]>();
    for (const r of rows) byEntity.set(r.entity_id, [...(byEntity.get(r.entity_id) ?? []), r.entry_id]);
    for (const members of [...byEntity.values()].sort((a, b) => b.length - a.length)) {
      const fresh = members.filter((id) => !used.has(id));
      if (fresh.length < 2) continue;
      fresh.forEach((id) => used.add(id));
      groups.push(fresh.map((id) => byId.get(id)!));
    }
  }
  const rest = new Map<string, Entry[]>();
  for (const e of entries) if (!used.has(e.id)) rest.set(`${e.scope}/${e.category}`, [...(rest.get(`${e.scope}/${e.category}`) ?? []), e]);
  groups.push(...rest.values());

  // Pack groups into batches; a group larger than the budget is split on its own.
  const batches: Entry[][] = [];
  let cur: Entry[] = [];
  let size = 0;
  const flush = () => {
    if (cur.length) batches.push(cur);
    cur = [];
    size = 0;
  };
  for (const g of groups) {
    const gsize = g.reduce((n, e) => n + fmt(e).length + 1, 0);
    if (gsize > budget) {
      flush();
      for (const e of g) {
        const n = fmt(e).length + 1;
        if (cur.length && size + n > budget) flush();
        cur.push(e);
        size += n;
      }
      flush();
      continue;
    }
    if (cur.length && size + gsize > budget) flush();
    cur.push(...g);
    size += gsize;
  }
  flush();
  return batches;
}

// ------------------------------------------------------------ cross scope

/** Global/user memories shown read-only next to one project batch (count cap). */
export const CROSS_SCOPE_MAX = 8;
/** ...and their characters: at most this, and never more than a quarter of REVIEW_CHUNK_CHARS. */
export const CROSS_SCOPE_CHARS = 6000;
export const crossScopeBudget = (chunk = config.review.chunkChars) => Math.min(CROSS_SCOPE_CHARS, Math.floor(chunk / 4));

/**
 * Cross-scope context of a project review batch: the global/user memories most likely
 * to repeat what the batch says, shown to the LLM READ-ONLY (it may propose deleting or
 * trimming the project copy, never touching them). Current ones only (an expired or
 * superseded global memory must not justify deleting a project memory), never standing.
 * Ranked by shared entities first, then by keyword search on the batch's titles.
 * Bounded by `max` memories and `chars` characters of `fmt` output.
 */
/** Smallest search score for a keyword-only REFERENCE (no shared entity) — see crossScopeContext. */
export const KEYWORD_REF_MIN = 5;

export function crossScopeContext(
  batch: Entry[],
  fmt: (e: Entry) => string,
  opts: { max?: number; chars?: number } = {},
): Entry[] {
  const max = opts.max ?? CROSS_SCOPE_MAX;
  const chars = opts.chars ?? crossScopeBudget();
  if (!batch.length || max <= 0 || chars <= 0) return [];
  const ids = batch.slice(0, 500).map((e) => e.id);
  const order: number[] = [];
  const byId = new Map<number, Entry>();
  // Shared entities, each weighted down by how many global/user memories mention it: a hub
  // entity ("Git", "TypeScript") alone should not pull the same general memories into every batch.
  const pairs = db
    .prepare(
      `SELECT e.id AS id, b.entity_id AS entity,
              (SELECT COUNT(*) FROM entry_entities c JOIN entries g ON g.id = c.entry_id
                WHERE c.entity_id = b.entity_id AND g.scope IN ('global','user') AND g.deleted_at IS NULL) AS n
         FROM entry_entities a
         JOIN entry_entities b ON b.entity_id = a.entity_id
         JOIN entries e ON e.id = b.entry_id
       WHERE a.entry_id IN (${ids.map(() => "?").join(",")}) AND e.scope IN ('global','user')
         AND e.deleted_at IS NULL AND e.category != 'standing' AND ${ACTIVE_SQL("e")}
       GROUP BY e.id, b.entity_id`,
    )
    .all(...ids) as { id: number; entity: number; n: number }[];
  const weight = new Map<number, number>();
  for (const r of pairs) weight.set(Number(r.id), (weight.get(Number(r.id)) ?? 0) + 1 / Math.log2(1 + Math.max(1, Number(r.n))));
  // Equal weight: the more recently updated first, then id (as before the weighting).
  const found = [...weight.keys()].map((id) => getEntry(id)).filter((e): e is Entry => Boolean(e));
  found.sort((a, b) => weight.get(b.id)! - weight.get(a.id)! || b.updated_at.localeCompare(a.updated_at) || a.id - b.id);
  for (const e of found.slice(0, max * 3)) {
    order.push(e.id);
    byId.set(e.id, e);
  }
  // Keyword overlap: each batch memory's title (and keywords) searched in global/user, best two each.
  const score = new Map<number, number>();
  for (const m of batch) {
    // Title, keywords and the start of the body: a two-word title alone ("커밋 규칙") scores too
    // low to tell a real overlap from one shared word ("테스트", "답변 언어"); with the body the
    // gap is wide (v0.6.6 measurements: 9–24 vs ≤4).
    const query = `${m.title} ${m.keywords.join(" ")} ${m.body.slice(0, 200)}`;
    const hits = searchEntries(query, { scopes: ["global", "user"], limit: 3, excludeIds: new Set(order) });
    const best = hits[0]?.score ?? 0;
    for (const h of hits) {
      if (h.entry.category === "standing") continue;
      if (h.score < KEYWORD_REF_MIN || h.score < best * 0.3) continue;
      score.set(h.entry.id, (score.get(h.entry.id) ?? 0) + h.score);
      byId.set(h.entry.id, h.entry);
    }
  }
  order.push(...[...score.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id));
  const out: Entry[] = [];
  let size = 0;
  for (const id of order) {
    if (out.length >= max) break;
    const e = byId.get(id)!;
    const n = fmt(e).length + 1;
    if (size + n > chars) continue; // a smaller one further down may still fit
    out.push(e);
    size += n;
  }
  return out;
}

// ------------------------------------------------------------------- jobs

let wakeWorker: (() => void) | null = null;
export function onReviewJobQueued(fn: () => void) {
  wakeWorker = fn;
}

export function enqueueReview(projectId: number | null, opts: { scheduled?: boolean } = {}): ReviewJob {
  if (projectId && !getProject(projectId)) throw new HttpError(404, "project not found");
  if (db.prepare(`SELECT 1 FROM review_jobs WHERE status IN ('pending','processing') AND IFNULL(project_id, 0) = ?`).get(projectId ?? 0))
    throw new HttpError(409, "a review of this scope is already running");
  // Over the cap, the most recently changed memories are reviewed (the oldest wait for a later run).
  const all = reviewScopeEntries(projectId);
  const ids = all
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, config.review.maxEntries)
    .map((e) => e.id)
    .sort((a, b) => a - b);
  if (ids.length < 2) throw new HttpError(400, "not enough memories to review");
  const res = db.prepare(`INSERT INTO review_jobs (project_id, payload) VALUES (?, ?)`).run(projectId, JSON.stringify({ entries: ids, ...(opts.scheduled ? { scheduled: true } : {}) }));
  wakeWorker?.();
  return getReviewJob(Number(res.lastInsertRowid))!;
}

/**
 * Scheduled review (REVIEW_EVERY_DAYS): queue a review of every scope — global +
 * user, and each project with memories — whose last review is older than the
 * period and whose memories changed since. Only enqueues; the worker loop runs
 * it like any other job and its proposals still wait for a person.
 * Off without an LLM: the job would only end 'skipped' and still restart the scope's period.
 */
export function scheduleDueReviews(at = new Date(), everyDays = config.review.everyDays): ReviewJob[] {
  if (!(everyDays > 0) || !llmEnabled()) return [];
  const cutoff = new Date(at.getTime() - everyDays * 86_400_000).toISOString();
  const scopes: (number | null)[] = [
    null,
    ...db
      .prepare(`SELECT DISTINCT project_id FROM entries WHERE project_id IS NOT NULL AND deleted_at IS NULL AND category != 'standing' ORDER BY project_id`)
      .all()
      .map((r) => Number(r.project_id)),
  ];
  const created: ReviewJob[] = [];
  for (const pid of scopes) {
    if (db.prepare(`SELECT 1 FROM review_jobs WHERE status IN ('pending','processing') AND IFNULL(project_id, 0) = ?`).get(pid ?? 0)) continue;
    // Only a review that completed counts: an errored, cancelled or skipped run is tried
    // again on the next (hourly) check instead of silencing the scope for a whole period.
    // A run that failed or was skipped is retried; one a person cancelled counts (they chose to stop it).
    const last = db.prepare(`SELECT MAX(created_at) AS t FROM review_jobs WHERE status IN ('done','cancelled') AND IFNULL(project_id, 0) = ?`).get(pid ?? 0)?.t;
    if (last != null) {
      if (String(last) > cutoff) continue;
      // A deletion bumps updated_at too, so it counts as a change.
      const where = pid ? "project_id = ?" : "scope IN ('global','user')";
      const changed = db
        .prepare(`SELECT 1 FROM entries WHERE category != 'standing' AND ${where} AND updated_at > ? LIMIT 1`)
        .get(...(pid ? [pid] : []), String(last));
      if (!changed) continue;
    }
    try {
      created.push(enqueueReview(pid, { scheduled: true }));
    } catch (err) {
      // Too few memories in this scope (400) or a race with a person starting one (409): try next time.
      if (!(err instanceof HttpError)) throw err;
    }
  }
  return created;
}

export function getReviewJob(id: number): ReviewJob | null {
  const r = db.prepare(`SELECT * FROM review_jobs WHERE id = ?`).get(id);
  return r ? toJob(r) : null;
}
export function listReviewJobs(f: { projectId?: number | null; limit?: number } = {}) {
  const where = f.projectId === undefined ? "1=1" : "IFNULL(j.project_id, 0) = ?";
  const args: number[] = f.projectId === undefined ? [] : [f.projectId ?? 0];
  return db
    .prepare(`SELECT j.*, p.name AS project_name FROM review_jobs j LEFT JOIN projects p ON p.id = j.project_id WHERE ${where} ORDER BY j.id DESC LIMIT ?`)
    .all(...args, f.limit ?? 20)
    .map((r) => ({ ...toJob(r), project_name: r.project_name == null ? null : String(r.project_name) }));
}
/** Jobs the worker holds right now (a cancelled one stays here until its in-flight call returns). */
export const runningReviewJobs = new Set<number>();
export function claimReviewJob(): ReviewJob | null {
  const r = db.prepare(`SELECT id FROM review_jobs WHERE status = 'pending' ORDER BY id LIMIT 1`).get();
  if (!r) return null;
  const res = db.prepare(`UPDATE review_jobs SET status = 'processing' WHERE id = ? AND status = 'pending'`).run(Number(r.id));
  if (!res.changes) return null;
  runningReviewJobs.add(Number(r.id));
  return getReviewJob(Number(r.id));
}
export function saveReviewProgress(id: number, result: unknown) {
  db.prepare(`UPDATE review_jobs SET result = ? WHERE id = ?`).run(JSON.stringify(result), id);
}
export function finishReviewJob(id: number, status: ReviewJob["status"], result: unknown, error: string | null = null) {
  db.prepare(`UPDATE review_jobs SET status = ?, result = ?, error = ?, processed_at = ? WHERE id = ? AND status = 'processing'`).run(
    status, result == null ? null : JSON.stringify(result), error, now(), id,
  );
}
/** Stop a queued or running review before its next batch (see cancelJob in wiki.ts). Proposals made so far stay. */
export function cancelReviewJob(id: number): ReviewJob {
  const res = db.prepare(`UPDATE review_jobs SET status = 'cancelled', processed_at = ? WHERE id = ? AND status IN ('pending','processing')`).run(now(), id);
  if (!res.changes) {
    if (!getReviewJob(id)) throw new HttpError(404, "job not found");
    throw new HttpError(409, "only queued or running jobs can be cancelled");
  }
  return getReviewJob(id)!;
}
export function isReviewJobCancelled(id: number): boolean {
  return getReviewJob(id)?.status === "cancelled";
}
export function retryReviewJob(id: number): ReviewJob {
  const j = getReviewJob(id);
  if (!j) throw new HttpError(404, "job not found");
  if (j.status !== "error" && j.status !== "cancelled") throw new HttpError(409, "only failed or cancelled jobs can be retried");
  if (db.prepare(`SELECT 1 FROM review_jobs WHERE status IN ('pending','processing') AND IFNULL(project_id, 0) = ? AND id != ?`).get(j.project_id ?? 0, id))
    throw new HttpError(409, "a review of this scope is already running");
  if (runningReviewJobs.has(id)) throw new HttpError(409, "job is still stopping; try again in a moment");
  db.prepare(`UPDATE review_jobs SET status = 'pending', error = NULL WHERE id = ?`).run(id);
  wakeWorker?.();
  return getReviewJob(id)!;
}

// -------------------------------------------------------------- proposals

/**
 * Version of a memory for staleness checks: its latest revision id. Every
 * change (text, category, pin, entities, delete/restore) writes a revision,
 * while updated_at misses entity-only changes.
 */
export function versionOf(id: number): string {
  const r = db.prepare(`SELECT MAX(id) AS v FROM revisions WHERE entry_id = ?`).get(id);
  return String(r?.v ?? "");
}

export type EditsError = ExactEditError | "edit_overlap";

/**
 * Apply several exact-substring edits to one body at once (G-033). Every "old" is
 * looked up in the ORIGINAL body (never in a body already changed by an earlier
 * edit) and must occur there exactly once; the passages may not overlap. All or
 * nothing: any failure returns the error and the index of the edit that caused it.
 */
export function applyExactEdits(body: string, edits: unknown[]): { body: string } | { error: EditsError; index: number } {
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  const b = lf(body);
  const spans: { at: number; end: number; next: string; index: number }[] = [];
  for (const [index, ed] of edits.entries()) {
    const e = ed as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || typeof e.old !== "string" || typeof e.new !== "string" || !lf(e.old)) return { error: "edit_invalid", index };
    const old = lf(e.old);
    const at = b.indexOf(old);
    if (at < 0) return { error: "edit_not_found", index };
    if (b.indexOf(old, at + 1) >= 0) return { error: "edit_not_unique", index };
    spans.push({ at, end: at + old.length, next: lf(e.new), index });
  }
  spans.sort((x, y) => x.at - y.at);
  for (let i = 1; i < spans.length; i++) if (spans[i].at < spans[i - 1].end) return { error: "edit_overlap", index: Math.max(spans[i].index, spans[i - 1].index) };
  let out = b;
  for (const sp of [...spans].reverse()) out = out.slice(0, sp.at) + sp.next + out.slice(sp.end);
  return { body: out };
}

/** The edits an LLM proposal carries: "edits" (list) and/or the single "edit" it may still send. null = malformed. */
function rawEdits(raw: Record<string, unknown>): unknown[] | null {
  const out: unknown[] = [];
  if (raw.edits != null) {
    if (!Array.isArray(raw.edits)) return null;
    out.push(...raw.edits);
  }
  if (raw.edit != null) out.push(raw.edit);
  return out;
}
const editKey = (e: unknown) => {
  const r = e as Record<string, unknown> | null;
  return r && typeof r === "object" ? JSON.stringify([String(r.old ?? "").replace(/\r\n/g, "\n"), String(r.new ?? "").replace(/\r\n/g, "\n")]) : "";
};
const blank = (v: unknown) => v == null || !String(v).trim();
/** A category a review may propose: a real one, never standing (humans only). */
const proposableCategory = (v: unknown) => {
  const c = v == null ? "" : String(v).trim();
  return c && c !== "standing" && (CATEGORIES as readonly string[]).includes(c) ? c : undefined;
};

/**
 * A proposed entity list for memory `id`: only names it has now (a review never adds
 * entities), matched by entity norm and returned as the current names, deduped.
 */
function entitySubset(id: number, raw: unknown): { names: string[]; same: boolean } | { reason: string } {
  if (!Array.isArray(raw) || raw.some((n) => typeof n !== "string")) return { reason: "entities_invalid" };
  const current = new Map(entityNamesOf(id).map((n) => [entityNorm(n), n]));
  const names: string[] = [];
  for (const n of raw as string[]) {
    const name = current.get(entityNorm(n));
    if (!name) return { reason: "entities_not_subset" };
    if (!names.includes(name)) names.push(name);
  }
  // In the memory's own (name) order, so the same set always compares equal.
  return { names: [...current.values()].filter((n) => names.includes(n)), same: names.length === current.size };
}

/**
 * The entity list an edit leaves when the LLM gave none: the current names minus those
 * written only in a removed passage (entitiesDroppedByEdit). undefined = nothing dropped.
 * `after`: the title and body after the edit (a name still in the title stays).
 */
function entitiesAfterEdits(id: number, edits: unknown[], after: string): string[] | undefined {
  const gone = entryEntitiesDroppedByEdit(id, edits.map((e) => String((e as Record<string, unknown>)?.old ?? "")), after);
  return gone.length ? entityNamesOf(id).filter((n) => !gone.includes(n)) : undefined;
}

/**
 * Fold the update proposals one LLM answer makes for the same single memory into
 * one proposal (the store keeps one pending update per memory and version, so the
 * others would be dropped as duplicates). Only rewrite-free updates fold (edits,
 * title, category, entities); a full-body rewrite stays on its own. Each source
 * proposal is all-or-nothing: one whose edits clash with those already taken, or
 * whose title/category contradict them, is dropped with a reason. Entity lists are
 * intersected (each part may list only what it keeps after its own edit).
 * Order: the folded proposal sits where its first part was.
 */
export function combineUpdateProposals(
  raws: Record<string, unknown>[],
  bodyOf: (id: number) => string | undefined,
  /** REFERENCE ids of this batch: a part citing one wins over a part citing a batch memory. */
  isReference: (id: number) => boolean = () => false,
): { proposals: Record<string, unknown>[]; dropped: DroppedProposal[] } {
  const idsOf = (p: Record<string, unknown>) => [...new Set((Array.isArray(p.ids) ? p.ids : p.id != null ? [p.id] : []).map(Number))];
  const foldable = (p: Record<string, unknown>) => {
    if (String(p.kind ?? p.op ?? "") !== "update" || idsOf(p).length !== 1) return false;
    const eds = rawEdits(p);
    // An edit decides the body (a "body" next to it is ignored); without edits, only a body-free update folds.
    return eds !== null && (eds.length > 0 || blank(p.body));
  };
  const groups = new Map<number, Record<string, unknown>[]>();
  for (const p of raws) if (foldable(p)) groups.set(idsOf(p)[0], [...(groups.get(idsOf(p)[0]) ?? []), p]);

  const dropped: DroppedProposal[] = [];
  const proposals: Record<string, unknown>[] = [];
  for (const p of raws) {
    if (!foldable(p)) {
      proposals.push(p);
      continue;
    }
    const id = idsOf(p)[0];
    const group = groups.get(id)!;
    if (group[0] !== p) continue; // folded into the group's first part
    const body = bodyOf(id);
    if (group.length === 1 || body === undefined) {
      proposals.push(...group); // nothing to fold, or addProposal rejects it anyway
      continue;
    }
    const edits: unknown[] = [];
    const keys = new Set<string>();
    const fields: { title?: string; category?: string; entities?: string[] } = {};
    const reasons: string[] = [];
    // A part with edits but no entity list: its dropped entities are derived after folding (below).
    let derive = false;
    // Cross-scope evidence (a global/user memory it repeats): the first part that cites one.
    let covered: unknown;
    for (const part of group) {
      // Each part is checked on its own first, so one bad part cannot sink the others.
      const drop = (reason: string) => dropped.push({ kind: "update", ids: [id], reason });
      const all = rawEdits(part) ?? [];
      // Deduped against earlier parts and within this one (as tryAddProposal dedupes a lone proposal).
      const partKeys = new Set<string>();
      const fresh = all.filter((e) => {
        const k = editKey(e);
        if (keys.has(k) || partKeys.has(k)) return false;
        partKeys.add(k);
        return true;
      });
      const own: typeof fields = {};
      if (!blank(part.title)) own.title = String(part.title).trim().slice(0, 200);
      const cat = proposableCategory(part.category);
      if (cat) own.category = cat;
      if (part.entities != null) {
        const ents = entitySubset(id, part.entities);
        if ("reason" in ents) {
          drop(ents.reason);
          continue;
        }
        own.entities = ents.names;
      }
      if (!fresh.length && !Object.keys(own).length) {
        drop(all.length ? "duplicate" : "no_change");
        continue;
      }
      // Entities never clash: each part lists what it keeps (often after only its own edit), so
      // the folded list keeps only names every part kept — the union of their removals.
      const clash = (["title", "category"] as const).find((k) => own[k] !== undefined && fields[k] !== undefined && own[k] !== fields[k]);
      if (clash) {
        drop(`conflicting_${clash}`);
        continue;
      }
      if (findSecrets(`${own.title ?? ""}\n${fresh.map((e) => String((e as Record<string, unknown>)?.new ?? "")).join("\n")}`).length) {
        drop("secret");
        continue;
      }
      if (fresh.length) {
        const r = applyExactEdits(body, [...edits, ...fresh]);
        if ("error" in r || r.body.length > 20_000) {
          drop("error" in r ? r.error : "too_long");
          continue;
        }
      }
      for (const e of fresh) {
        edits.push(e);
        keys.add(editKey(e));
      }
      const kept = own.entities && fields.entities ? fields.entities.filter((n) => own.entities!.includes(n)) : (own.entities ?? fields.entities);
      Object.assign(fields, own, kept ? { entities: kept } : {});
      if (fresh.length && part.entities == null) derive = true;
      const why = String(part.reason ?? "").trim();
      if (why && !reasons.includes(why)) reasons.push(why);
      if (part.covered_by != null && (covered == null || (!isReference(Number(covered)) && isReference(Number(part.covered_by))))) covered = part.covered_by;
    }
    // Some parts listed entities and some did not: also drop what the folded edits stop mentioning
    // (intersection = union of removals). With no list at all, tryAddProposal derives it instead.
    if (derive && fields.entities && edits.length) {
      const r = applyExactEdits(body, edits);
      const left = "body" in r ? entitiesAfterEdits(id, edits, `${fields.title ?? getEntry(id)?.title ?? ""}\n${r.body}`) : undefined;
      if (left) fields.entities = fields.entities.filter((n) => left.includes(n));
    }
    proposals.push({ kind: "update", ids: [id], ...(edits.length ? { edits } : {}), ...fields, ...(covered != null ? { covered_by: covered } : {}), reason: reasons.join("; ") });
  }
  return { proposals, dropped };
}

/**
 * addProposal, but says why a proposal was not stored (reported on the job result).
 * `context`: the other-scope memories shown read-only in that batch (cross-scope context of a
 * project review), id → version when shown. A proposal naming one in "ids" is refused —
 * a merge as "mixed_scope", anything else as "cross_scope" (they belong to their own scope's
 * review); a delete/update may cite one in "covered_by" as the memory that already states it.
 */
export function tryAddProposal(
  jobId: number,
  raw: Record<string, unknown>,
  seen: Map<number, string>,
  context: Map<number, string> = new Map(),
): { proposal: Proposal } | { reason: string } {
  const kind = String(raw.kind ?? raw.op ?? "") as ProposalKind;
  if (!["merge", "update", "delete", "conflict"].includes(kind)) return { reason: "unknown_kind" };
  let rawIds = (Array.isArray(raw.ids) ? raw.ids : raw.id != null ? [raw.id] : []).map(Number);
  // A conflict between a project memory and a REFERENCE memory: the REFERENCE one is cited, never a
  // target (the LLM sometimes lists it in "ids"). Only one REFERENCE id, and the rest must be this batch's.
  if (kind === "conflict" && raw.covered_by == null) {
    const refs = rawIds.filter((id) => context.has(id) && !seen.has(id));
    if (refs.length === 1) {
      raw = { ...raw, covered_by: refs[0] };
      rawIds = rawIds.filter((id) => id !== refs[0]);
    }
  }
  // Checked before the seen filter below, which would otherwise strip them silently.
  if (rawIds.some((id) => context.has(id) && !seen.has(id))) return { reason: kind === "merge" ? "mixed_scope" : "cross_scope" };
  // The LLM often names the REFERENCE memory in its reason ("전역 메모리 #2") but leaves out
  // covered_by: take it from the reason when exactly one REFERENCE id is cited there, so the
  // apply-time check (G-055) still guards the proposal.
  if ((kind === "delete" || kind === "update") && (raw.covered_by == null || String(raw.covered_by).trim() === "") && context.size) {
    const cited = [...new Set([...String(raw.reason ?? "").matchAll(/#(\d+)/g)].map((m) => Number(m[1])))].filter((id) => context.has(id));
    if (cited.length === 1) raw = { ...raw, covered_by: cited[0] };
  }
  let coveredBy: number | undefined;
  if ((kind === "delete" || kind === "update" || kind === "conflict") && raw.covered_by != null && String(raw.covered_by).trim() !== "") {
    const cited = Number(raw.covered_by);
    // Only a REFERENCE memory makes a cross-scope proposal. One from the same batch (an ordinary
    // in-project duplicate), or any id in a review with no REFERENCE section, is just ignored.
    if (context.has(cited)) {
      coveredBy = cited;
      if (versionOf(coveredBy) !== context.get(coveredBy)) return { reason: "changed_meanwhile" };
      const ref = getEntry(coveredBy);
      if (!ref || ref.deleted_at || entryState(ref).superseded_by || entryState(ref).expired) return { reason: "covered_by_inactive" };
    } else if (context.size && !seen.has(cited)) return { reason: "covered_by_not_shown" };
  }
  const ids = [...new Set(rawIds)].filter((id) => seen.has(id));
  // A memory that changed while the LLM was reading it: the proposal is built on old text.
  if (ids.some((id) => versionOf(id) !== seen.get(id))) return { reason: "changed_meanwhile" };
  const job = getReviewJob(jobId);
  const entries = ids
    .map((id) => getEntry(id))
    .filter((e): e is Entry => Boolean(e && !e.deleted_at && e.category !== "standing" && inScope(e, job?.project_id ?? null)));
  if (entries.length !== ids.length) return { reason: "not_reviewable" };
  // Superseded since the LLM saw it (a link writes no memory revision, so the version check misses it):
  // it is history now, and a merge would hide or delete live content.
  if (entries.some((e) => entryState(e).superseded_by)) return { reason: "superseded" };
  // A conflict needs two sides: two memories here, or one here and the REFERENCE memory it contradicts.
  if (kind === "merge" && ids.length < 2) return { reason: "too_few_ids" };
  if (kind === "conflict" && ids.length < (coveredBy !== undefined ? 1 : 2)) return { reason: "too_few_ids" };
  if ((kind === "update" || kind === "delete") && ids.length !== 1) return { reason: ids.length ? "too_many_ids" : "no_ids" };
  // A merge keeps one memory, so all of them must live in the same place.
  if (kind === "merge" && new Set(entries.map((e) => `${e.scope}/${e.project_id ?? 0}`)).size > 1) return { reason: "mixed_scope" };
  if (kind === "delete" && entries[0].pinned) return { reason: "pinned" };
  // A merge deletes every memory but the first; a pinned memory may only be the one kept.
  if (kind === "merge" && entries.slice(1).some((e) => e.pinned)) {
    const pinned = entries.filter((e) => e.pinned);
    if (pinned.length > 1) return { reason: "pinned" };
    ids.splice(ids.indexOf(pinned[0].id), 1);
    ids.unshift(pinned[0].id);
  }
  // The snapshot is what the LLM saw, not what is there now.
  const data: Proposal["data"] = { snap: Object.fromEntries(ids.map((id) => [String(id), seen.get(id)!])) };
  if (kind === "merge" || kind === "update") {
    const text = (v: unknown) => (v == null ? undefined : String(v).trim() || undefined);
    data.title = text(raw.title)?.slice(0, 200);
    data.body = text(raw.body);
    // Only real categories; never promote to standing (humans only).
    data.category = proposableCategory(raw.category);
    if (kind === "merge") {
      if (!data.title) return { reason: "no_title" };
      // No merged body from the LLM: keep every member's body rather than silently dropping the others'.
      // In final order (a pinned member may have been moved first).
      data.body ??= [...new Set(ids.map((id) => entries.find((e) => e.id === id)!.body.trim()).filter(Boolean))].join("\n\n") || undefined;
    }
    // Exact-substring edits: "edits" decide the body; a full body next to them is ignored, and an
    // edit that does not match exactly once (or overlaps another) rejects the whole proposal — it
    // never falls back to the body (that body may come from a truncated view). Checked against
    // the FULL current body. Always stored as data.edits (a single "edit" from the LLM too).
    let edited: string | undefined;
    if (kind === "update") {
      const eds = rawEdits(raw);
      if (eds === null) return { reason: "edit_invalid" };
      // An edit that only changes whitespace is no change (the LLM sometimes "fixes" a space).
      const ws = (t: string) => t.replace(/\s+/g, " ").trim();
      const unique = eds
        .filter((e, i) => eds.findIndex((x) => editKey(x) === editKey(e)) === i)
        .filter((e) => ws((e as ExactEdit).old) !== ws((e as ExactEdit).new));
      if (unique.length) {
        const r = applyExactEdits(entries[0].body, unique);
        if ("error" in r) return { reason: r.error };
        edited = r.body;
        delete data.body;
        data.edits = unique.map((e) => {
          const ed = e as ExactEdit;
          return { old: ed.old.replace(/\r\n/g, "\n"), new: ed.new.replace(/\r\n/g, "\n") };
        });
      }
      // Entities: only a subset of what the memory has now (a review never adds entities), so an
      // edit that removes the only passage naming one can drop it. Matched by entity norm, stored
      // as the current names; the same set as now counts as absent.
      if (raw.entities != null) {
        const ents = entitySubset(ids[0], raw.entities);
        if ("reason" in ents) return { reason: ents.reason };
        if (!ents.same) data.entities = ents.names;
      } else if (edited !== undefined && data.edits) {
        // No list from the LLM (it often omits it): drop only the entities a removed passage was
        // the last mention of, so an edit that deletes a fixture passage takes its entity too.
        const left = entitiesAfterEdits(ids[0], data.edits, `${data.title ?? entries[0].title}\n${edited}`);
        if (left) data.entities = left;
      }
    }
    for (const k of ["title", "body", "category"] as const) if (data[k] === undefined) delete data[k];
    // Same limits the store enforces on apply, so an accepted proposal can actually be applied.
    if ((data.body?.length ?? 0) > 20_000 || (edited?.length ?? 0) > 20_000) return { reason: "too_long" };
    if (findSecrets(`${data.title ?? ""}\n${data.body ?? ""}\n${(data.edits ?? []).map((e) => e.new).join("\n")}`).length) return { reason: "secret" };
    if (kind === "update" && data.title === undefined && data.body === undefined && data.category === undefined && data.edits === undefined && data.entities === undefined)
      return { reason: "no_change" };
  }
  if (kind === "conflict" && raw.note != null) data.note = String(raw.note);
  let reason = String(raw.reason ?? "");
  if (coveredBy !== undefined) {
    data.covered_by = coveredBy;
    data.covered_snap = context.get(coveredBy);
    // The reason cites the memory it relies on, so the card and the revision note say where it is.
    if (!new RegExp(`#${coveredBy}(?!\\d)`).test(reason)) reason = `${reason.trim()} (#${coveredBy})`.trim();
  }
  // The same memories already have an open proposal of this kind: skip the duplicate.
  // entry_ids keeps the LLM's order (a merge keeps the first). Skip a duplicate of an open
  // proposal, and of a dismissed one whose memories have not changed since (no re-asking).
  const sortedKey = JSON.stringify([...ids].sort((a, b) => a - b));
  const snapKey = JSON.stringify(data.snap);
  const priorRows = db
    .prepare(`SELECT id, entry_ids, data, status FROM review_proposals WHERE kind = ? AND status IN ('pending','dismissed') AND job_id IN (SELECT id FROM review_jobs WHERE IFNULL(project_id, 0) = (SELECT IFNULL(project_id, 0) FROM review_jobs WHERE id = ?))`)
    .all(kind, jobId);
  for (const r of priorRows) {
    if (JSON.stringify((JSON.parse(String(r.entry_ids)) as number[]).sort((a, b) => a - b)) !== sortedKey) continue;
    const prevSnap = (JSON.parse(String(r.data ?? "{}")) as Proposal["data"]).snap ?? {};
    const same = JSON.stringify(Object.fromEntries(Object.keys(data.snap).map((k) => [k, prevSnap[k]]))) === snapKey;
    if (same) return { reason: r.status === "pending" ? "duplicate" : "dismissed_before" };
    // An open proposal built on older versions can never apply; retire it so the fresh one counts.
    if (r.status === "pending") decide(Number(r.id), "stale");
  }
  const res = db
    .prepare(`INSERT INTO review_proposals (job_id, kind, entry_ids, data, reason) VALUES (?, ?, ?, ?, ?)`)
    .run(jobId, kind, JSON.stringify(ids), JSON.stringify(data), reason.slice(0, 500));
  return { proposal: getProposal(Number(res.lastInsertRowid))! };
}

/**
 * Validate and store one LLM proposal. `seen` = ids shown in that batch with the version the LLM saw.
 * Returns null (and stores nothing) when the proposal breaks a rule; tryAddProposal says which.
 */
export function addProposal(jobId: number, raw: Record<string, unknown>, seen: Map<number, string>, context?: Map<number, string>): Proposal | null {
  const r = tryAddProposal(jobId, raw, seen, context);
  return "proposal" in r ? r.proposal : null;
}

/** Shown on a delete proposal that would take away the reason behind a memory a pending proposal updates. */
export const REASON_DELETE_WARNING =
  "이 메모리는 대기 중인 다른 제안이 고치려는 메모리의 결정 이유를 담고 있습니다. 둘 다 적용하면 왜 그렇게 정했는지가 사라질 수 있으니, 삭제하기 전에 그대로 두거나 합치기를 고려하세요.";

/**
 * Flag the pending delete proposals (of the job's project) whose memory holds the reason for a
 * memory a pending proposal updates (re-measure 35: "the update now states the outcome, delete the
 * decision" loses why). Kept, not dropped: the delete may still be right (expired, obsolete),
 * and a person decides (ADR-0013); data.warning tells them to look twice. A reason memory is
 * the target of a "because" link from the updated memory, or a "decision" memory linked to it
 * (any link, either way) or sharing an entity with it. Returns how many were flagged.
 */
export function markReasonDeletes(jobId: number): number {
  // Every pending delete/update of the job's project, not just this job's: a re-run skips a
  // delete still open from an earlier job as a duplicate, so the pair can span two jobs.
  const rows = db
    .prepare(
      `SELECT * FROM review_proposals WHERE status = 'pending' AND kind IN ('delete','update') AND job_id IN (SELECT id FROM review_jobs WHERE IFNULL(project_id, 0) = (SELECT IFNULL(project_id, 0) FROM review_jobs WHERE id = ?))`,
    )
    .all(jobId)
    .map(toProposal);
  const updated = [...new Set(rows.filter((p) => p.kind === "update").map((p) => p.entry_ids[0]))];
  if (!updated.length) return 0;
  const ph = updated.map(() => "?").join(",");
  const because = db.prepare(`SELECT 1 FROM entry_links WHERE to_id = ? AND type = 'because' AND from_id IN (${ph}) LIMIT 1`);
  const linked = db.prepare(`SELECT 1 FROM entry_links WHERE (from_id = ? AND to_id IN (${ph})) OR (to_id = ? AND from_id IN (${ph})) LIMIT 1`);
  const shared = db.prepare(
    `SELECT 1 FROM entry_entities a JOIN entry_entities b ON b.entity_id = a.entity_id WHERE a.entry_id = ? AND b.entry_id IN (${ph}) LIMIT 1`,
  );
  let n = 0;
  for (const p of rows) {
    if (p.kind !== "delete" || p.data.warning) continue;
    const id = p.entry_ids[0];
    const others = updated.filter((u) => u !== id);
    if (!others.length) continue;
    const args = updated.map((u) => (u === id ? -1 : u)); // never match the memory itself
    const isReason =
      because.get(id, ...args) != null ||
      (getEntry(id)?.category === "decision" && (linked.get(id, ...args, id, ...args) != null || shared.get(id, ...args) != null));
    if (!isReason) continue;
    db.prepare(`UPDATE review_proposals SET data = ? WHERE id = ?`).run(JSON.stringify({ ...p.data, warning: REASON_DELETE_WARNING }), p.id);
    n++;
  }
  return n;
}

export function getProposal(id: number): Proposal | null {
  const r = db.prepare(`SELECT * FROM review_proposals WHERE id = ?`).get(id);
  return r ? toProposal(r) : null;
}

/** Proposals with the memories they touch (current state), newest job first. */
export function listProposals(f: { status?: ProposalStatus; jobId?: number; projectId?: number | null } = {}) {
  const where = ["1=1"];
  const args: (string | number)[] = [];
  if (f.status) {
    where.push("p.status = ?");
    args.push(f.status);
  }
  if (f.jobId) {
    where.push("p.job_id = ?");
    args.push(f.jobId);
  }
  if (f.projectId !== undefined) {
    where.push("IFNULL(j.project_id, 0) = ?");
    args.push(f.projectId ?? 0);
  }
  return db
    .prepare(`SELECT p.* FROM review_proposals p JOIN review_jobs j ON j.id = p.job_id WHERE ${where.join(" AND ")} ORDER BY p.job_id DESC, p.id`)
    .all(...args)
    .map(toProposal)
    .map((p) => ({
      ...p,
      entries: p.entry_ids.map((id) => {
        const e = getEntry(id);
        return e ? { ...e, entities: entityNamesOf(id), changed: versionOf(id) !== p.data.snap[String(id)] || entryState(e).superseded_by != null } : null;
      }),
      // The global/user memory a cross-scope proposal relies on (null = gone); changed = apply would refuse.
      ...(p.data.covered_by != null
        ? (() => {
            const e = getEntry(p.data.covered_by);
            return { covered_by_entry: e ? { ...e, changed: coveredByChanged(p) } : null };
          })()
        : {}),
    }));
}

/** The memory a cross-scope proposal cites is gone, changed, superseded or expired since it was shown. */
function coveredByChanged(p: Proposal): boolean {
  if (p.data.covered_by == null) return false;
  const e = getEntry(p.data.covered_by);
  if (!e || e.deleted_at || versionOf(e.id) !== p.data.covered_snap) return true;
  const st = entryState(e);
  return st.superseded_by != null || st.expired;
}

function decide(id: number, status: ProposalStatus) {
  db.prepare(`UPDATE review_proposals SET status = ?, decided_at = ? WHERE id = ?`).run(status, now(), id);
}

export function dismissProposal(id: number): Proposal {
  const p = getProposal(id);
  if (!p) throw new HttpError(404, "proposal not found");
  if (p.status !== "pending") throw new HttpError(409, `proposal is already ${p.status}`);
  decide(id, "dismissed");
  return getProposal(id)!;
}

/**
 * Apply a pending proposal. If any memory changed or vanished since it was
 * proposed, the proposal is marked stale instead (409) — never applied blind.
 */
export function applyProposal(id: number): Proposal {
  const p = getProposal(id);
  if (!p) throw new HttpError(404, "proposal not found");
  if (p.status !== "pending") throw new HttpError(409, `proposal is already ${p.status}`);
  const entries = p.entry_ids.map((eid) => getEntry(eid));
  // Becoming superseded counts as a change too: versionOf (memory revisions) does not see a new link.
  const changed = entries.some(
    (e, i) => !e || e.deleted_at || versionOf(p.entry_ids[i]) !== p.data.snap[String(p.entry_ids[i])] || entryState(e).superseded_by != null,
  );
  if (changed) {
    decide(id, "stale");
    throw new HttpError(409, "the memories changed since this was proposed; run the review again");
  }
  // Deleting or trimming a project copy is only right while the global/user memory still says it.
  if (coveredByChanged(p)) {
    decide(id, "stale");
    throw new HttpError(409, `memory #${p.data.covered_by} this relies on changed since it was proposed; run the review again`);
  }
  const meta = { author: "llm" as const, reason: `메모리 점검 제안 #${p.id} 승인: ${p.reason}`.slice(0, 500) };
  try {
    applyInTransaction(p, meta);
  } catch (err) {
    // The store refused (limits, secrets, standing…): retire it instead of leaving it pending forever.
    decide(id, "stale");
    throw new HttpError(422, `could not apply: ${(err as Error).message}`);
  }
  return getProposal(id)!;
}

function applyInTransaction(p: Proposal, meta: { author: "llm"; reason: string }) {
  const id = p.id;
  transaction(() => {
    if (p.kind === "delete") deleteEntry(p.entry_ids[0], meta);
    else if (p.kind === "update") {
      let body = p.data.body;
      // data.edit: a proposal stored before data.edits (v0.6.0), still applied.
      const edits = p.data.edits ?? (p.data.edit ? [p.data.edit] : undefined);
      if (edits?.length) {
        // Re-check at apply time: every passage must still occur exactly once, without overlapping.
        const r = applyExactEdits(getEntry(p.entry_ids[0])!.body, edits);
        if ("error" in r)
          throw new HttpError(
            422,
            r.error === "edit_not_unique" ? "the edited passage now occurs more than once"
              : r.error === "edit_overlap" ? "the edited passages now overlap"
              : "the edited passage is no longer in the body",
          );
        body = r.body;
      }
      if (p.data.entities) {
        // Still a subset of the memory's entities (the version check normally guarantees this).
        const current = new Set(entityNamesOf(p.entry_ids[0]).map(entityNorm));
        if (p.data.entities.some((n) => !current.has(entityNorm(n)))) throw new HttpError(422, "the proposed entities are no longer on the memory");
      }
      // One updateEntry call: text and entities land in a single revision.
      updateEntry(p.entry_ids[0], { title: p.data.title, body, category: p.data.category, entities: p.data.entities }, meta);
    }
    else if (p.kind === "merge") {
      const [keep, ...rest] = p.entry_ids;
      // The kept memory gets the merged text, every entity of the group, and the others' links.
      // Entities shared by more members first, so the 12-per-memory cap drops the rarest.
      const freq = new Map<string, number>();
      for (const eid of p.entry_ids) for (const n of entityNamesOf(eid)) freq.set(n, (freq.get(n) ?? 0) + 1);
      const entities = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
      updateEntry(keep, { title: p.data.title, body: p.data.body, category: p.data.category, entities }, meta);
      for (const other of rest) {
        moveLinks(other, keep, { author: meta.author }); // recorded in graph history (revertible)
        deleteEntry(other, { ...meta, reason: `#${keep}에 합쳐짐 (점검 제안 #${p.id})` });
      }
    }
    // conflict: nothing to change automatically; applying just marks it resolved.
    decide(id, "applied");
  });
}

/** Memories nobody used, injected or edited for `days` days (deterministic, no LLM). */
export function staleEntries(projectId: number | null, days = 60): (Entry & { last_used_at: string | null })[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const where = projectId ? "e.project_id = ?" : "e.scope IN ('global','user')";
  return db
    .prepare(
      `SELECT e.*, u.last_used_at FROM entries e LEFT JOIN entry_usage u ON u.entry_id = e.id
       WHERE e.deleted_at IS NULL AND e.category != 'standing' AND e.pinned = 0 AND ${where}
         -- Superseded memories are never injected, so they always look unused; they are history, not stale.
         AND ${NOT_SUPERSEDED_SQL("e")}
         AND e.updated_at < ? AND IFNULL(u.last_used_at, '') < ? AND IFNULL(u.shown_at, '') < ?
       ORDER BY MAX(e.updated_at, IFNULL(u.last_used_at, ''), IFNULL(u.shown_at, '')) LIMIT 200`,
    )
    .all(...(projectId ? [projectId] : []), cutoff, cutoff, cutoff)
    .map((r) => ({ ...rowToEntry(r), last_used_at: r.last_used_at == null ? null : String(r.last_used_at) }));
}

/** Size of a review scope and how many of its memories have no entities (they only meet same-category memories). */
export function reviewScopeSummary(projectId: number | null) {
  const where = projectId ? "e.project_id = ?" : "e.scope IN ('global','user')";
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(NOT EXISTS (SELECT 1 FROM entry_entities ee WHERE ee.entry_id = e.id)) AS unlinked
       FROM entries e WHERE e.deleted_at IS NULL AND e.category != 'standing' AND ${where} AND ${NOT_SUPERSEDED_SQL("e")}`,
    )
    .get(...(projectId ? [projectId] : []));
  return { entries: Number(r?.n ?? 0), unlinked: Number(r?.unlinked ?? 0), staleDays: config.review.staleDays, maxEntries: config.review.maxEntries };
}

export function reviewStats() {
  const one = (sql: string) => Number(Object.values(db.prepare(sql).get() ?? { n: 0 })[0]);
  return {
    reviewProposals: one(`SELECT COUNT(*) FROM review_proposals WHERE status = 'pending'`),
    reviewRunning: one(`SELECT COUNT(*) FROM review_jobs WHERE status IN ('pending','processing')`),
  };
}
