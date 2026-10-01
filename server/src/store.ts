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
import { findSecrets } from "./secrets.ts";

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

export function updateProject(id: number, patch: { name?: string; description?: string }): Project {
  const p = getProject(id);
  if (!p) throw new HttpError(404, "project not found");
  db.prepare(`UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?`).run(
    patch.name?.trim() || p.name,
    patch.description ?? p.description,
    now(),
    id,
  );
  return getProject(id)!;
}

export function deleteProject(id: number): void {
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
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

function guardContent(title: string, body: string, author: Source, category: Category) {
  if (!title.trim()) throw new HttpError(400, "title is required");
  if (title.length > 200) throw new HttpError(400, "title is too long (max 200)");
  if (body.length > 20_000) throw new HttpError(400, "body is too long (max 20000)");
  const secrets = findSecrets(`${title}\n${body}`);
  if (secrets.length) throw new HttpError(422, `content looks like it contains secrets: ${secrets.join(", ")}`);
  if (category === "standing" && author !== "human") {
    throw new HttpError(403, "standing instructions can only be written by a human");
  }
}

function writeRevision(e: Entry, action: Revision["action"], meta: WriteMeta) {
  db.prepare(
    `INSERT INTO revisions (entry_id, action, title, body, category, tags, pinned, author, turn_id, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  guardContent(title, body, meta.author, category);
  const projectId = input.scope === "project" ? input.project_id ?? null : null;
  if (input.scope === "project" && !projectId) throw new HttpError(400, "project scope needs project_id");
  const created = transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO entries (scope, project_id, category, title, body, tags, pinned, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    const e = getEntry(Number(res.lastInsertRowid))!;
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
  const next = {
    category: patch.category !== undefined ? normalizeCategory(patch.category) : cur.category,
    title: patch.title !== undefined ? patch.title.trim() : cur.title,
    body: patch.body !== undefined ? patch.body.trim() : cur.body,
    tags: patch.tags !== undefined ? normalizeTags(patch.tags) : cur.tags,
    pinned: patch.pinned !== undefined ? Boolean(patch.pinned) : cur.pinned,
  };
  guardContent(next.title, next.body, meta.author, next.category);
  const unchanged =
    scope === cur.scope &&
    projectId === cur.project_id &&
    next.category === cur.category &&
    next.title === cur.title &&
    next.body === cur.body &&
    next.pinned === cur.pinned &&
    JSON.stringify(next.tags) === JSON.stringify(cur.tags);
  if (unchanged) return cur;
  const updated = transaction(() => {
    db.prepare(
      `UPDATE entries SET scope = ?, project_id = ?, category = ?, title = ?, body = ?, tags = ?, pinned = ?,
         source = ?, updated_at = ? WHERE id = ?`,
    ).run(
      scope,
      projectId,
      next.category,
      next.title,
      next.body,
      JSON.stringify(next.tags),
      next.pinned ? 1 : 0,
      meta.author,
      now(),
      id,
    );
    const e = getEntry(id)!;
    writeRevision(e, "update", meta);
    return e;
  });
  return updated;
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
    { title: r.title, body: r.body, category: r.category, tags: r.tags, pinned: r.pinned },
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
  args.push(f.limit ?? 1000);
  return db
    .prepare(
      `SELECT * FROM entries WHERE ${where.join(" AND ")}
       ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
    )
    .all(...args)
    .map(rowToEntry);
}

/** Entries visible from a project: global + user + that project's own. */
export function visibleEntries(projectId: number | null): Entry[] {
  return db
    .prepare(
      `SELECT * FROM entries WHERE deleted_at IS NULL
         AND (scope IN ('global','user') OR project_id = ?)
       ORDER BY pinned DESC, updated_at DESC`,
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
