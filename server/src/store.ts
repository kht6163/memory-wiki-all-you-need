import { entityNamesOf, pruneAllOrphanEntities, resolveEntityInputs, writeEntryEntities, type EntityInput } from "./entities.ts";
import {
  CATEGORIES,
  db,
  now,
  rowToEntry,
  rowToProject,
  rowToRevision,
  transaction,
  type Category,
  type Entry,
  type Project,
  type Revision,
  type Scope,
  type Source,
} from "./db.ts";
import { keywordRedundant, textWordSet } from "./words.ts";
import { findSecrets, redactSecrets } from "./secrets.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- projects

export interface ProjectRef {
  key: string;
  name?: string;
  remote?: string | null;
}

export function upsertProject(ref: ProjectRef): Project {
  const key = ref.key.trim();
  if (!key) throw new HttpError(400, "project key is required");
  const name = ref.name?.trim() || key.split("/").pop() || key;
  db.prepare(
    `INSERT INTO projects (key, name, remote, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       remote = COALESCE(excluded.remote, projects.remote),
       last_seen_at = excluded.last_seen_at`,
  ).run(key, name, ref.remote ?? null, now());
  return getProjectByKey(key)!;
}

export function getProjectByKey(key: string): Project | null {
  const row = db.prepare(`SELECT * FROM projects WHERE key = ?`).get(key);
  return row ? rowToProject(row) : null;
}

export function getProject(id: number): Project | null {
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
  return row ? rowToProject(row) : null;
}

export function listProjects(): (Project & { entry_count: number; turn_count: number })[] {
  return db
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM entries e WHERE e.project_id = p.id AND e.deleted_at IS NULL) AS entry_count,
         (SELECT COUNT(*) FROM turns t WHERE t.project_id = p.id) AS turn_count
       FROM projects p
       ORDER BY COALESCE(p.last_seen_at, p.updated_at) DESC`,
    )
    .all()
    .map((r) => ({ ...rowToProject(r), entry_count: Number(r.entry_count), turn_count: Number(r.turn_count) }));
}

/** Max length of a project description (it is injected into every prompt block). */
export const PROJECT_DESCRIPTION_MAX = 500;

/**
 * The description as it may reach a prompt. updateProject bounds and scans new writes, but rows
 * written before that check (or straight to the DB) may be long or hold credentials, so every
 * reader goes through this: secrets redacted first (so a cut cannot split one), then capped.
 */
export function promptDescription(p: Pick<Project, "description">): string {
  return redactSecrets((p.description ?? "").trim()).slice(0, PROJECT_DESCRIPTION_MAX).trim();
}

/** "name (key) — description" for LLM prompts; the description is cut to `max` characters. */
export function projectLabel(p: Project, max = 300): string {
  const d = promptDescription(p).replace(/\s+/g, " ");
  if (!d) return `${p.name} (${p.key})`;
  return `${p.name} (${p.key}) — ${d.length > max ? `${d.slice(0, max)}…` : d}`;
}

export function updateProject(id: number, patch: { name?: string; description?: string }): Project {
  const p = getProject(id);
  if (!p) throw new HttpError(404, "project not found");
  let description = p.description;
  if (patch.description != null) {
    // Human-edited framing injected into the stable prompt block (G-005), so it is bounded and scanned.
    description = String(patch.description).trim();
    if (description.length > PROJECT_DESCRIPTION_MAX) throw new HttpError(400, `description is too long (max ${PROJECT_DESCRIPTION_MAX})`);
    const secrets = findSecrets(description);
    if (secrets.length) throw new HttpError(422, `description looks like it contains secrets: ${secrets.join(", ")}`);
  }
  db.prepare(`UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?`).run(
    patch.name?.trim() || p.name,
    description,
    now(),
    id,
  );
  return getProject(id)!;
}

export function deleteProject(id: number): void {
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM curation_policies WHERE project_id = ?`).run(id);
  pruneAllOrphanEntities();
}

// ----------------------------------------------------------------- entries

export interface EntryInput {
  scope: Scope;
  project_id?: number | null;
  category?: string;
  title: string;
  body?: string;
  tags?: string[];
  pinned?: boolean;
  /** Graph: entity names (or {name, kind}) this memory mentions. */
  entities?: EntityInput[];
  keywords?: string[];
  /** YYYY-MM-DD, or null/"" for no end. */
  valid_until?: string | null;
}

export interface WriteMeta {
  author: Source;
  turnId?: number | null;
  reason?: string | null;
  origin?: "turn" | "agent" | "human";
}

function normalizeCategory(c: string | undefined): Category {
  const v = (c ?? "fact").trim().toLowerCase() as Category;
  return (CATEGORIES as readonly string[]).includes(v) ? v : "fact";
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
}

/**
 * Search-only words: deduplicated case-insensitively, each at most 60 chars, at most 16.
 * With `redundantIn` (title + body), keywords whose search words all already
 * occur there are dropped first — they add nothing to search (keywordRedundant) —
 * except those in `keep` (already stored; compared case-insensitively).
 */
export function normalizeKeywords(words: unknown, redundantIn?: string[], keep: string[] = []): string[] {
  if (!Array.isArray(words)) return [];
  const kept = new Set(keep.map((k) => k.toLowerCase()));
  const textWords = redundantIn ? textWordSet(...redundantIn) : null;
  const out = new Map<string, string>();
  for (const w of words) {
    const v = String(w ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!v || out.has(v.toLowerCase())) continue;
    if (textWords && !kept.has(v.toLowerCase()) && keywordRedundant(v, textWords)) continue;
    out.set(v.toLowerCase(), v);
  }
  return [...out.values()].slice(0, 16);
}

/**
 * Only machine-written keyword lists (curation LLM, agent) are filtered for
 * words already in the title/body, and only for keywords new in that write: a
 * human may want an explicit keyword, and neither a later body edit nor a
 * machine resending the stored list silently removes stored keywords.
 */
const keywordFilterText = (meta: WriteMeta, title: string, body: string) => (meta.author === "human" ? undefined : [title, body]);

/** A calendar date YYYY-MM-DD, or null for "no end". Anything else is a 400. */
export function normalizeValidUntil(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(`${s}T00:00:00Z`) : null;
  if (!m || !d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new HttpError(400, "valid_until must be a date (YYYY-MM-DD)");
  return s;
}

/**
 * SQL condition: the memory is current — not past its valid_until (UTC day)
 * and not replaced by a live memory through a "supersedes" link. Inactive
 * memories stay as history (search, graph, web) but are not injected.
 */
export const ACTIVE_SQL = (a = "e") =>
  `((${a}.valid_until IS NULL OR ${a}.valid_until >= date('now')) AND NOT EXISTS (
     SELECT 1 FROM entry_links sl JOIN entries sn ON sn.id = sl.from_id
     WHERE sl.type = 'supersedes' AND sl.to_id = ${a}.id AND ${SUPERSEDER_OK(a)}))`;

/** SQL condition: memory `a` is not retired by a "supersedes" link (expiry not considered). */
export const NOT_SUPERSEDED_SQL = (a = "e") =>
  `NOT EXISTS (SELECT 1 FROM entry_links sl JOIN entries sn ON sn.id = sl.from_id
               WHERE sl.type = 'supersedes' AND sl.to_id = ${a}.id AND ${SUPERSEDER_OK(a)})`;

/**
 * When a "supersedes" link (sl, from sn) actually retires memory `a`: the
 * replacement is live, visible wherever `a` is (global/user, or the same
 * project), and not itself retired by `a` (a cycle of retiring links retires
 * nobody; an informational retires = 0 link back does not count). addLink
 * refuses the other cases; this also covers links made before those checks.
 */
const SUPERSEDER_OK = (a: string) =>
  `sl.retires = 1 AND sn.deleted_at IS NULL AND (sn.scope IN ('global','user') OR sn.project_id = ${a}.project_id)
   AND NOT EXISTS (SELECT 1 FROM entry_links rl WHERE rl.type = 'supersedes' AND rl.retires = 1 AND rl.from_id = ${a}.id AND rl.to_id = sn.id)`;

export interface EntryState {
  /** Live memory that replaces this one ("supersedes" link), if any. */
  superseded_by: number | null;
  /** valid_until is in the past (UTC). */
  expired: boolean;
}

/** State of several memories at once (for lists). */
export function entryStates(entries: Entry[]): Map<number, EntryState> {
  const out = new Map<number, EntryState>();
  if (!entries.length) return out;
  const today = new Date().toISOString().slice(0, 10);
  const by = new Map<number, number>();
  for (let i = 0; i < entries.length; i += 500) {
    const part = entries.slice(i, i + 500).map((e) => e.id);
    for (const r of db
      .prepare(
        `SELECT e.id AS to_id, MAX(sl.from_id) AS from_id FROM entries e
           JOIN entry_links sl ON sl.to_id = e.id AND sl.type = 'supersedes' JOIN entries sn ON sn.id = sl.from_id
         WHERE e.id IN (${part.map(() => "?").join(",")}) AND ${SUPERSEDER_OK("e")} GROUP BY e.id`,
      )
      .all(...part))
      by.set(Number(r.to_id), Number(r.from_id));
  }
  for (const e of entries) out.set(e.id, { superseded_by: by.get(e.id) ?? null, expired: e.valid_until != null && e.valid_until < today });
  return out;
}

export function entryState(e: Entry): EntryState {
  return entryStates([e]).get(e.id)!;
}

export const isActive = (e: Entry) => {
  const s = entryState(e);
  return !s.superseded_by && !s.expired;
};

/** Entries with their state, for API lists. */
export function withStates<T extends Entry>(entries: T[]): (T & EntryState)[] {
  const st = entryStates(entries);
  return entries.map((e) => ({ ...e, ...st.get(e.id)! }));
}

const rawText = (list: unknown) => (Array.isArray(list) ? list.map((x) => String(x ?? "")).join("\n") : "");
const entityText = (list: EntityInput[] | undefined) => (list ?? []).map((x) => (typeof x === "string" ? x : String(x?.name ?? ""))).join("\n");

function guardContent(title: string, body: string, author: Source, category: Category, extra = "") {
  if (!title.trim()) throw new HttpError(400, "title is required");
  if (title.length > 200) throw new HttpError(400, "title is too long (max 200)");
  if (body.length > 20_000) throw new HttpError(400, "body is too long (max 20000)");
  // Tags and entity names are stored and shown too, so they are scanned with the text.
  const secrets = findSecrets(`${title}\n${body}\n${extra}`);
  if (secrets.length) throw new HttpError(422, `content looks like it contains secrets: ${secrets.join(", ")}`);
  if (category === "standing" && author !== "human") {
    throw new HttpError(403, "standing instructions can only be written by a human");
  }
}

function writeRevision(e: Entry, action: Revision["action"], meta: WriteMeta) {
  db.prepare(
    `INSERT INTO revisions (entry_id, action, title, body, category, tags, pinned, author, turn_id, reason, entities, keywords, valid_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    action,
    e.title,
    e.body,
    e.category,
    JSON.stringify(e.tags),
    e.pinned ? 1 : 0,
    meta.author,
    meta.turnId ?? null,
    meta.reason ?? null,
    JSON.stringify(entityNamesOf(e.id)),
    JSON.stringify(e.keywords),
    e.valid_until,
  );
}

export function getEntry(id: number): Entry | null {
  const row = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id);
  return row ? rowToEntry(row) : null;
}

export function createEntry(input: EntryInput, meta: WriteMeta): Entry {
  const category = normalizeCategory(input.category);
  const title = input.title?.trim() ?? "";
  const body = (input.body ?? "").trim();
  const keywords = normalizeKeywords(input.keywords, keywordFilterText(meta, title, body));
  const validUntil = normalizeValidUntil(input.valid_until);
  // Raw keywords are scanned: truncation could cut a secret below its detector's length.
  guardContent(title, body, meta.author, category, `${(input.tags ?? []).join("\n")}\n${entityText(input.entities)}\n${rawText(input.keywords)}`);
  const projectId = input.scope === "project" ? input.project_id ?? null : null;
  if (input.scope === "project" && !projectId) throw new HttpError(400, "project scope needs project_id");
  const created = transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO entries (scope, project_id, category, title, body, tags, pinned, source, keywords, valid_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scope,
        projectId,
        category,
        title,
        body,
        JSON.stringify(normalizeTags(input.tags)),
        input.pinned ? 1 : 0,
        meta.author,
        JSON.stringify(keywords),
        validUntil,
      );
    const e = getEntry(Number(res.lastInsertRowid))!;
    if (input.entities?.length) writeEntryEntities(e.id, resolveEntityInputs(input.entities));
    writeRevision(e, "create", meta);
    return e;
  });
  return created;
}

export interface EntryPatch {
  scope?: Scope;
  project_id?: number | null;
  category?: string;
  title?: string;
  body?: string;
  tags?: string[];
  pinned?: boolean;
  /** Replaces the memory's entities when given. */
  entities?: EntityInput[];
  keywords?: string[];
  /** null or "" clears it. */
  valid_until?: string | null;
}

export type ExactEditError = "edit_invalid" | "edit_not_found" | "edit_not_unique";

/**
 * Replace `old` with `next` in `body` only when `old` occurs exactly once
 * (overlapping occurrences count). Line endings are normalized to LF in all
 * three; nothing else is (no fuzzy matching). Empty `old` is invalid.
 */
export function replaceExactlyOnce(body: string, old: unknown, next: unknown): { body: string } | { error: ExactEditError } {
  if (typeof old !== "string" || typeof next !== "string") return { error: "edit_invalid" };
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  const b = lf(body);
  const o = lf(old);
  if (!o) return { error: "edit_invalid" };
  const at = b.indexOf(o);
  if (at < 0) return { error: "edit_not_found" };
  if (b.indexOf(o, at + 1) >= 0) return { error: "edit_not_unique" };
  return { body: b.slice(0, at) + lf(next) + b.slice(at + o.length) };
}

export function updateEntry(id: number, patch: EntryPatch, meta: WriteMeta): Entry {
  const cur = getEntry(id);
  if (!cur || cur.deleted_at) throw new HttpError(404, "entry not found");
  if (cur.category === "standing" && meta.author !== "human") {
    throw new HttpError(403, "standing instructions can only be changed by a human");
  }
  const scope = patch.scope ?? cur.scope;
  const projectId = scope === "project" ? (patch.project_id ?? cur.project_id) : null;
  if (scope === "project" && !projectId) throw new HttpError(400, "project scope needs project_id");
  const title = patch.title !== undefined ? patch.title.trim() : cur.title;
  const body = patch.body !== undefined ? patch.body.trim() : cur.body;
  const next = {
    category: patch.category !== undefined ? normalizeCategory(patch.category) : cur.category,
    title,
    body,
    tags: patch.tags !== undefined ? normalizeTags(patch.tags) : cur.tags,
    pinned: patch.pinned !== undefined ? Boolean(patch.pinned) : cur.pinned,
    keywords: patch.keywords !== undefined ? normalizeKeywords(patch.keywords, keywordFilterText(meta, title, body), cur.keywords) : cur.keywords,
    valid_until: patch.valid_until !== undefined ? normalizeValidUntil(patch.valid_until) : cur.valid_until,
  };
  guardContent(next.title, next.body, meta.author, next.category, `${next.tags.join("\n")}\n${entityText(patch.entities)}\n${patch.keywords !== undefined ? rawText(patch.keywords) : next.keywords.join("\n")}`);
  const unchanged =
    scope === cur.scope &&
    projectId === cur.project_id &&
    next.category === cur.category &&
    next.title === cur.title &&
    next.body === cur.body &&
    next.pinned === cur.pinned &&
    next.valid_until === cur.valid_until &&
    JSON.stringify(next.keywords) === JSON.stringify(cur.keywords) &&
    JSON.stringify(next.tags) === JSON.stringify(cur.tags);
  const sameNames = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return transaction(() => {
    // Entities first, so the revision below snapshots them; an entity-only change still gets a revision.
    const before = entityNamesOf(id);
    if (patch.entities !== undefined) writeEntryEntities(id, resolveEntityInputs(patch.entities));
    const entitiesChanged = !sameNames(before, entityNamesOf(id));
    if (unchanged && !entitiesChanged) return cur;
    if (unchanged) {
      writeRevision(cur, "update", meta);
      return cur;
    }
    db.prepare(
      `UPDATE entries SET scope = ?, project_id = ?, category = ?, title = ?, body = ?, tags = ?, pinned = ?,
         keywords = ?, valid_until = ?, source = ?, updated_at = ? WHERE id = ?`,
    ).run(
      scope,
      projectId,
      next.category,
      next.title,
      next.body,
      JSON.stringify(next.tags),
      next.pinned ? 1 : 0,
      JSON.stringify(next.keywords),
      next.valid_until,
      meta.author,
      now(),
      id,
    );
    const e = getEntry(id)!;
    writeRevision(e, "update", meta);
    return e;
  });
}

export function deleteEntry(id: number, meta: WriteMeta): Entry {
  const cur = getEntry(id);
  if (!cur || cur.deleted_at) throw new HttpError(404, "entry not found");
  if (cur.category === "standing" && meta.author !== "human") {
    throw new HttpError(403, "standing instructions can only be removed by a human");
  }
  const deleted = transaction(() => {
    db.prepare(`UPDATE entries SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), id);
    const e = getEntry(id)!;
    writeRevision(e, "delete", meta);
    return e;
  });
  return deleted;
}

export function restoreEntry(id: number, meta: WriteMeta): Entry {
  const cur = getEntry(id);
  if (!cur) throw new HttpError(404, "entry not found");
  if (!cur.deleted_at) return cur;
  const restored = transaction(() => {
    db.prepare(`UPDATE entries SET deleted_at = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
    const e = getEntry(id)!;
    writeRevision(e, "restore", meta);
    return e;
  });
  return restored;
}

export function purgeEntry(id: number): void {
  db.prepare(`DELETE FROM entries WHERE id = ? AND deleted_at IS NOT NULL`).run(id);
  pruneAllOrphanEntities();
}

export function revertEntry(id: number, revisionId: number, meta: WriteMeta): Entry {
  const rev = db.prepare(`SELECT * FROM revisions WHERE id = ? AND entry_id = ?`).get(revisionId, id);
  if (!rev) throw new HttpError(404, "revision not found");
  const r = rowToRevision(rev);
  const cur = getEntry(id);
  if (!cur) throw new HttpError(404, "entry not found");
  if (cur.deleted_at) restoreEntry(id, meta);
  return updateEntry(
    id,
    {
      title: r.title, body: r.body, category: r.category, tags: r.tags, pinned: r.pinned,
      ...(r.entities ? { entities: r.entities } : {}),
      // Revisions from before v0.6.0 have no keywords/valid_until: keep the current ones.
      ...(r.keywords ? { keywords: r.keywords, valid_until: r.valid_until } : {}),
    },
    { ...meta, reason: meta.reason ?? `revision #${revisionId} 로 되돌림` },
  );
}

export function listRevisions(entryId: number): Revision[] {
  return db.prepare(`SELECT * FROM revisions WHERE entry_id = ? ORDER BY id DESC`).all(entryId).map(rowToRevision);
}

export interface EntryFilter {
  scope?: Scope;
  projectId?: number;
  category?: string;
  deleted?: boolean;
  /** Only current memories (see ACTIVE_SQL). */
  activeOnly?: boolean;
  limit?: number;
}

export function listEntries(f: EntryFilter = {}): Entry[] {
  const where: string[] = [f.deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
  const args: (string | number)[] = [];
  if (f.scope) {
    where.push("scope = ?");
    args.push(f.scope);
  }
  if (f.projectId) {
    where.push("project_id = ?");
    args.push(f.projectId);
  }
  if (f.category) {
    where.push("category = ?");
    args.push(f.category);
  }
  if (f.activeOnly) where.push(ACTIVE_SQL("entries"));
  args.push(f.limit ?? 1000);
  return db
    .prepare(
      `SELECT * FROM entries WHERE ${where.join(" AND ")}
       ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
    )
    .all(...args)
    .map(rowToEntry);
}

/**
 * Usage day for ordering: the last day of use, except that a use TODAY does
 * not count yet — then the day of the use before it (rank_day). So the key is
 * constant all day and only moves at midnight (UTC).
 */
const USAGE_DAY = `CASE WHEN substr(IFNULL(u.last_used_at, ''), 1, 10) < date('now') THEN substr(IFNULL(u.last_used_at, ''), 1, 10) ELSE IFNULL(u.rank_day, '') END`;

/** Entries visible from a project: global + user + that project's own. */
export function visibleEntries(projectId: number | null, opts: { activeOnly?: boolean } = {}): Entry[] {
  // Recently written OR recently used first, so a memory that keeps helping
  // stays in the stable block even if nobody edits it. Usage only counts by
  // DAY, and a use only counts from the next day on (see USAGE_DAY): recall
  // bumps last_used_at on almost every request, and letting that reorder the
  // block would break the provider prompt cache turn after turn. Within a day
  // the order only changes when memory itself does.
  return db
    .prepare(
      `SELECT e.* FROM entries e LEFT JOIN entry_usage u ON u.entry_id = e.id
       WHERE e.deleted_at IS NULL AND (e.scope IN ('global','user') OR e.project_id = ?) ${opts.activeOnly ? `AND ${ACTIVE_SQL("e")}` : ""}
       ORDER BY e.pinned DESC, MAX(substr(e.updated_at, 1, 10), ${USAGE_DAY}) DESC, e.updated_at DESC`,
    )
    .all(projectId ?? -1)
    .map(rowToEntry);
}

export interface ActivityItem extends Revision {
  entry_scope: Scope;
  entry_project_id: number | null;
  project_name: string | null;
}

export function recentActivity(limit = 100, before?: number): ActivityItem[] {
  return db
    .prepare(
      `SELECT r.*, e.scope AS entry_scope, e.project_id AS entry_project_id, p.name AS project_name
       FROM revisions r JOIN entries e ON e.id = r.entry_id LEFT JOIN projects p ON p.id = e.project_id
       WHERE (? IS NULL OR r.id < ?)
       ORDER BY r.id DESC LIMIT ?`,
    )
    .all(before ?? null, before ?? null, limit)
    .map((r) => ({
      ...rowToRevision(r),
      entry_scope: r.entry_scope as Scope,
      entry_project_id: r.entry_project_id == null ? null : Number(r.entry_project_id),
      project_name: r.project_name == null ? null : String(r.project_name),
    }));
}

export interface Usage {
  recalled: number;
  searched: number;
  last_used_at: string | null;
  shown_at: string | null;
}

/** Count that memories reached the agent: "recall" (injected for a prompt) or "search" (memory_search / memory_graph). */
export function recordUsage(ids: number[], kind: "recall" | "search") {
  if (!ids.length) return;
  const col = kind === "recall" ? "recalled" : "searched";
  // In an upsert's SET every bare column is the OLD value: rank_day becomes the
  // previous use day only when this is the first use on a new day.
  const stmt = db.prepare(
    `INSERT INTO entry_usage (entry_id, ${col}, last_used_at) VALUES (?, 1, ?)
     ON CONFLICT(entry_id) DO UPDATE SET ${col} = ${col} + 1,
       rank_day = CASE WHEN substr(IFNULL(last_used_at, ''), 1, 10) < substr(excluded.last_used_at, 1, 10)
                       THEN substr(last_used_at, 1, 10) ELSE rank_day END,
       last_used_at = excluded.last_used_at`,
  );
  const t = now();
  transaction(() => {
    for (const id of new Set(ids)) if (getEntry(id)) stmt.run(id, t);
  });
}

let shownDay = "";
const shownToday = new Set<number>();
/** Mark memories as shown in the stable block (once per memory per day; it does not affect ordering). */
export function recordShown(ids: number[]) {
  const t = now();
  if (t.slice(0, 10) !== shownDay) {
    shownDay = t.slice(0, 10);
    shownToday.clear();
  }
  const fresh = ids.filter((id) => !shownToday.has(id));
  if (!fresh.length) return;
  const stmt = db.prepare(
    `INSERT INTO entry_usage (entry_id, shown_at) VALUES (?, ?) ON CONFLICT(entry_id) DO UPDATE SET shown_at = excluded.shown_at`,
  );
  transaction(() => {
    for (const id of fresh) if (getEntry(id)) stmt.run(id, t);
  });
  fresh.forEach((id) => shownToday.add(id));
}

export function usageOf(entryId: number): Usage {
  const r = db.prepare(`SELECT * FROM entry_usage WHERE entry_id = ?`).get(entryId);
  return {
    recalled: Number(r?.recalled ?? 0),
    searched: Number(r?.searched ?? 0),
    last_used_at: r?.last_used_at == null ? null : String(r.last_used_at),
    shown_at: r?.shown_at == null ? null : String(r.shown_at),
  };
}

// ------------------------------------------------------- turn provenance

export type ProvenanceKind = "add" | "update" | "confirm" | "duplicate";

export interface Provenance {
  /** Distinct turns that added, updated, re-stated or confirmed the memory. */
  count: number;
  last_at: string | null;
  recent: { turn_id: number; kind: ProvenanceKind; created_at: string; session_id: string | null }[];
}

/** Record that a turn added, updated, re-stated (exact duplicate) or confirmed a memory. Never touches the memory itself. */
export function recordEntryTurn(entryId: number, turnId: number, kind: ProvenanceKind) {
  db.prepare(`INSERT OR IGNORE INTO entry_turns (entry_id, turn_id, kind, created_at) VALUES (?, ?, ?, ?)`).run(entryId, turnId, kind, now());
}

export function provenanceOf(entryId: number, limit = 10): Provenance {
  const agg = db.prepare(`SELECT COUNT(DISTINCT turn_id) AS n, MAX(created_at) AS last FROM entry_turns WHERE entry_id = ?`).get(entryId);
  const recent = db
    .prepare(
      `SELECT et.turn_id, et.kind, et.created_at, t.session_id FROM entry_turns et LEFT JOIN turns t ON t.id = et.turn_id
       WHERE et.entry_id = ? ORDER BY et.created_at DESC, et.turn_id DESC LIMIT ?`,
    )
    .all(entryId, limit)
    .map((r) => ({
      turn_id: Number(r.turn_id),
      kind: String(r.kind) as ProvenanceKind,
      created_at: String(r.created_at),
      session_id: r.session_id == null ? null : String(r.session_id),
    }));
  return { count: Number(agg?.n ?? 0), last_at: agg?.last == null ? null : String(agg.last), recent };
}

/**
 * Distinct turns that reaffirmed the memory — confirmed it, re-stated it
 * (exact duplicate) or corrected it. A review signal; "add" does not count.
 */
export function confirmedTurns(entryId: number): number {
  const r = db
    .prepare(`SELECT COUNT(DISTINCT turn_id) AS n FROM entry_turns WHERE entry_id = ? AND kind IN ('confirm','duplicate','update')`)
    .get(entryId);
  return Number(r?.n ?? 0);
}

/**
 * When confirm tracking began: the earliest "confirm"/"duplicate" row (the
 * migration backfill only writes add/update, so these exist only for turns
 * curated since the upgrade). Null while nothing has been tracked yet.
 */
export function confirmTrackingSince(): string | null {
  const r = db.prepare(`SELECT MIN(created_at) AS t FROM entry_turns WHERE kind IN ('confirm','duplicate')`).get();
  return r?.t == null ? null : String(r.t);
}

export function stats() {
  const one = (sql: string) => Number(Object.values(db.prepare(sql).get() ?? { n: 0 })[0]);
  return {
    entries: one(`SELECT COUNT(*) FROM entries WHERE deleted_at IS NULL`),
    projects: one(`SELECT COUNT(*) FROM projects`),
    turns: one(`SELECT COUNT(*) FROM turns`),
    pending: one(`SELECT COUNT(*) FROM turns WHERE status IN ('pending','processing')`),
    errors: one(`SELECT COUNT(*) FROM turns WHERE status = 'error'`),
    trash: one(`SELECT COUNT(*) FROM entries WHERE deleted_at IS NOT NULL`),
  };
}

// ---------------------------------------------------------- curation policy

/**
 * Human-written rules for the server LLM ("don't remember fixture names",
 * "always note port numbers"). Global (project 0) and per project. Never
 * written by the LLM or the agent; read by turn curation, review and compose.
 */
export function getPolicy(projectId: number | null): { project_id: number | null; text: string; updated_at: string | null } {
  const r = db.prepare(`SELECT text, updated_at FROM curation_policies WHERE project_id = ?`).get(projectId ?? 0);
  return { project_id: projectId, text: r ? String(r.text) : "", updated_at: r ? String(r.updated_at) : null };
}

export function setPolicy(projectId: number | null, text: string) {
  if (projectId && !getProject(projectId)) throw new HttpError(404, "project not found");
  const t = String(text ?? "").trim();
  if (t.length > 4000) throw new HttpError(400, "policy is too long (max 4000)");
  const secrets = findSecrets(t);
  if (secrets.length) throw new HttpError(422, `content looks like it contains secrets: ${secrets.join(", ")}`);
  if (!t) db.prepare(`DELETE FROM curation_policies WHERE project_id = ?`).run(projectId ?? 0);
  else
    db.prepare(
      `INSERT INTO curation_policies (project_id, text, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    ).run(projectId ?? 0, t, now());
  return getPolicy(projectId);
}

/** Policy block for an LLM prompt: global rules, then the project's. Empty string when there are none. */
export function policyPrompt(projectId: number | null): string {
  const parts: string[] = [];
  const g = getPolicy(null).text;
  if (g) parts.push(`Global:\n${g}`);
  if (projectId) {
    const p = getPolicy(projectId).text;
    if (p) parts.push(`This project:\n${p}`);
  }
  return parts.length
    ? `POLICY (rules from the user for what to keep and how to write it; they override the defaults above, but never store secrets):\n${parts.join("\n\n")}`
    : "";
}
