import { config } from "./config.ts";
import { CATEGORIES, db, now, rowToEntry, transaction, type Entry } from "./db.ts";
import { entityNamesOf } from "./entities.ts";
import { moveLinks } from "./graph.ts";
import { findSecrets } from "./secrets.ts";
import { HttpError, deleteEntry, getEntry, getProject, updateEntry } from "./store.ts";

// Memory review: an LLM pass over existing memories (cluster by cluster) that
// PROPOSES merges, fixes, deletions and flags conflicts. Proposals wait for a
// person; applying one re-checks that the memories did not change meanwhile.

export type ProposalKind = "merge" | "update" | "delete" | "conflict";
export type ProposalStatus = "pending" | "applied" | "dismissed" | "stale";

export interface ReviewJob {
  id: number;
  project_id: number | null;
  status: "pending" | "processing" | "done" | "skipped" | "error";
  payload: { entries: number[] };
  result: { done?: number[]; chunks?: number; proposals?: number; ms?: number } | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface Proposal {
  id: number;
  job_id: number;
  kind: ProposalKind;
  entry_ids: number[];
  /** merge/update: the new title/body/category; snap: each memory's latest revision id when the LLM read it. */
  data: { title?: string; body?: string; category?: string; note?: string; snap: Record<string, string> };
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
    .prepare(`SELECT e.* FROM entries e WHERE e.deleted_at IS NULL AND e.category != 'standing' AND ${where} ORDER BY e.id`)
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

// ------------------------------------------------------------------- jobs

let wakeWorker: (() => void) | null = null;
export function onReviewJobQueued(fn: () => void) {
  wakeWorker = fn;
}

export function enqueueReview(projectId: number | null): ReviewJob {
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
  const res = db.prepare(`INSERT INTO review_jobs (project_id, payload) VALUES (?, ?)`).run(projectId, JSON.stringify({ entries: ids }));
  wakeWorker?.();
  return getReviewJob(Number(res.lastInsertRowid))!;
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
export function claimReviewJob(): ReviewJob | null {
  const r = db.prepare(`SELECT id FROM review_jobs WHERE status = 'pending' ORDER BY id LIMIT 1`).get();
  if (!r) return null;
  const res = db.prepare(`UPDATE review_jobs SET status = 'processing' WHERE id = ? AND status = 'pending'`).run(Number(r.id));
  return res.changes ? getReviewJob(Number(r.id)) : null;
}
export function saveReviewProgress(id: number, result: unknown) {
  db.prepare(`UPDATE review_jobs SET result = ? WHERE id = ?`).run(JSON.stringify(result), id);
}
export function finishReviewJob(id: number, status: ReviewJob["status"], result: unknown, error: string | null = null) {
  db.prepare(`UPDATE review_jobs SET status = ?, result = ?, error = ?, processed_at = ? WHERE id = ?`).run(
    status, result == null ? null : JSON.stringify(result), error, now(), id,
  );
}
export function retryReviewJob(id: number): ReviewJob {
  const j = getReviewJob(id);
  if (!j) throw new HttpError(404, "job not found");
  if (j.status !== "error") throw new HttpError(409, "only failed jobs can be retried");
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

/**
 * Validate and store one LLM proposal. `allowed` = ids shown in that batch.
 * Returns null (and stores nothing) when the proposal breaks a rule.
 */
export function addProposal(jobId: number, raw: Record<string, unknown>, seen: Map<number, string>): Proposal | null {
  const kind = String(raw.kind ?? raw.op ?? "") as ProposalKind;
  if (!["merge", "update", "delete", "conflict"].includes(kind)) return null;
  const ids = [...new Set((Array.isArray(raw.ids) ? raw.ids : raw.id != null ? [raw.id] : []).map(Number))].filter((id) => seen.has(id));
  // A memory that changed while the LLM was reading it: the proposal is built on old text.
  if (ids.some((id) => versionOf(id) !== seen.get(id))) return null;
  const job = getReviewJob(jobId);
  const entries = ids
    .map((id) => getEntry(id))
    .filter((e): e is Entry => Boolean(e && !e.deleted_at && e.category !== "standing" && inScope(e, job?.project_id ?? null)));
  if (entries.length !== ids.length) return null;
  if ((kind === "merge" || kind === "conflict") && ids.length < 2) return null;
  if ((kind === "update" || kind === "delete") && ids.length !== 1) return null;
  // A merge keeps one memory, so all of them must live in the same place.
  if (kind === "merge" && new Set(entries.map((e) => `${e.scope}/${e.project_id ?? 0}`)).size > 1) return null;
  if (kind === "delete" && entries[0].pinned) return null;
  // A merge deletes every memory but the first; a pinned memory may only be the one kept.
  if (kind === "merge" && entries.slice(1).some((e) => e.pinned)) {
    const pinned = entries.filter((e) => e.pinned);
    if (pinned.length > 1) return null;
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
    const cat = text(raw.category);
    if (cat && cat !== "standing" && (CATEGORIES as readonly string[]).includes(cat)) data.category = cat;
    if (kind === "merge") {
      if (!data.title) return null;
      // No merged body from the LLM: keep every member's body rather than silently dropping the others'.
      // In final order (a pinned member may have been moved first).
      data.body ??= [...new Set(ids.map((id) => entries.find((e) => e.id === id)!.body.trim()).filter(Boolean))].join("\n\n") || undefined;
    }
    for (const k of ["title", "body", "category"] as const) if (data[k] === undefined) delete data[k];
    // Same limits the store enforces on apply, so an accepted proposal can actually be applied.
    if ((data.body?.length ?? 0) > 20_000) return null;
    if (findSecrets(`${data.title ?? ""}\n${data.body ?? ""}`).length) return null;
    if (kind === "update" && data.title === undefined && data.body === undefined && data.category === undefined) return null;
  }
  if (kind === "conflict" && raw.note != null) data.note = String(raw.note);
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
    if (same) return null;
    // An open proposal built on older versions can never apply; retire it so the fresh one counts.
    if (r.status === "pending") decide(Number(r.id), "stale");
  }
  const res = db
    .prepare(`INSERT INTO review_proposals (job_id, kind, entry_ids, data, reason) VALUES (?, ?, ?, ?, ?)`)
    .run(jobId, kind, JSON.stringify(ids), JSON.stringify(data), String(raw.reason ?? "").slice(0, 500));
  return getProposal(Number(res.lastInsertRowid));
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
        return e ? { ...e, entities: entityNamesOf(id), changed: versionOf(id) !== p.data.snap[String(id)] } : null;
      }),
    }));
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
  const changed = entries.some((e, i) => !e || e.deleted_at || versionOf(p.entry_ids[i]) !== p.data.snap[String(p.entry_ids[i])]);
  if (changed) {
    decide(id, "stale");
    throw new HttpError(409, "the memories changed since this was proposed; run the review again");
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
    else if (p.kind === "update") updateEntry(p.entry_ids[0], { title: p.data.title, body: p.data.body, category: p.data.category }, meta);
    else if (p.kind === "merge") {
      const [keep, ...rest] = p.entry_ids;
      // The kept memory gets the merged text, every entity of the group, and the others' links.
      // Entities shared by more members first, so the 12-per-memory cap drops the rarest.
      const freq = new Map<string, number>();
      for (const eid of p.entry_ids) for (const n of entityNamesOf(eid)) freq.set(n, (freq.get(n) ?? 0) + 1);
      const entities = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
      updateEntry(keep, { title: p.data.title, body: p.data.body, category: p.data.category, entities }, meta);
      for (const other of rest) {
        moveLinks(other, keep);
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
       FROM entries e WHERE e.deleted_at IS NULL AND e.category != 'standing' AND ${where}`,
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
