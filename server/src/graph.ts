import { config } from "./config.ts";
import { db, now, rowToEntry, transaction, type Entry, type Source } from "./db.ts";
import { ENTITY_KINDS, entitiesVersion, entityDisplayName, entityNorm, resolveEntityId } from "./entities.ts";
import { HttpError, getEntry } from "./store.ts";

// Memory graph: memories ⇄ entities (mentions) and memory → memory typed links.
// The curation LLM fills it as part of its normal per-turn call; people edit it
// in the web UI; recall and the memory_graph tool read it.

export const LINK_TYPES = ["depends_on", "because", "supersedes", "related"] as const;
export type LinkType = (typeof LINK_TYPES)[number];
export const isLinkType = (t: unknown): t is LinkType => (LINK_TYPES as readonly string[]).includes(String(t));

export interface Entity {
  id: number;
  name: string;
  kind: string;
  description: string;
  created_at: string;
  updated_at: string;
  count?: number;
  aliases?: string[];
}
export interface Link {
  from_id: number;
  to_id: number;
  type: LinkType;
  author: Source;
  created_at: string;
}

type Row = Record<string, unknown>;
const toEntity = (r: Row): Entity => ({
  id: Number(r.id),
  name: String(r.name),
  kind: String(r.kind),
  description: String(r.description ?? ""),
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
  ...(r.count != null ? { count: Number(r.count) } : {}),
});
const toLink = (r: Row): Link => ({
  from_id: Number(r.from_id),
  to_id: Number(r.to_id),
  type: r.type as LinkType,
  author: r.author as Source,
  created_at: String(r.created_at),
});

// ------------------------------------------------------------------ links

/** Add a typed link between two live memories. Returns false when it already existed. */
export function addLink(fromId: number, toId: number, type: LinkType, author: Source): boolean {
  if (fromId === toId) throw new HttpError(400, "a memory cannot link to itself");
  if (!isLinkType(type)) throw new HttpError(400, `link type must be one of ${LINK_TYPES.join(", ")}`);
  const a = getEntry(fromId);
  const b = getEntry(toId);
  if (!a || a.deleted_at || !b || b.deleted_at) throw new HttpError(404, "both memories must exist");
  // "related" is symmetric: store it once.
  if (type === "related" && db.prepare(`SELECT 1 FROM entry_links WHERE from_id = ? AND to_id = ? AND type = 'related'`).get(toId, fromId)) return false;
  const res = db.prepare(`INSERT OR IGNORE INTO entry_links (from_id, to_id, type, author) VALUES (?, ?, ?, ?)`).run(fromId, toId, type, author);
  return res.changes > 0;
}

export function removeLink(fromId: number, toId: number, type: LinkType): boolean {
  const res = db.prepare(`DELETE FROM entry_links WHERE from_id = ? AND to_id = ? AND type = ?`).run(fromId, toId, type);
  return res.changes > 0;
}

/** Live links touching a memory, with the other memory's title. */
export function linksOf(entryId: number) {
  const rows = db
    .prepare(
      `SELECT l.*, o.id AS other_id, o.title AS other_title, o.category AS other_category, o.scope AS other_scope,
              CASE WHEN l.from_id = ? THEN 'out' ELSE 'in' END AS dir
       FROM entry_links l JOIN entries o ON o.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
       WHERE (l.from_id = ? OR l.to_id = ?) AND o.deleted_at IS NULL
       ORDER BY l.created_at`,
    )
    .all(entryId, entryId, entryId, entryId);
  return rows.map((r) => ({
    ...toLink(r),
    dir: String(r.dir) as "out" | "in",
    other: { id: Number(r.other_id), title: String(r.other_title), category: String(r.other_category), scope: String(r.other_scope) },
  }));
}

export function entitiesOf(entryId: number): Entity[] {
  return db
    .prepare(`SELECT n.* FROM entry_entities ee JOIN entities n ON n.id = ee.entity_id WHERE ee.entry_id = ? ORDER BY n.name COLLATE NOCASE`)
    .all(entryId)
    .map(toEntity);
}

// --------------------------------------------------------------- entities

export function listEntities(f: { q?: string; projectId?: number | null; limit?: number } = {}): Entity[] {
  const where = ["e.deleted_at IS NULL"];
  const args: (string | number)[] = [];
  if (f.projectId) {
    where.push("e.project_id = ?");
    args.push(f.projectId);
  }
  if (f.q?.trim()) {
    where.push("(n.norm LIKE ? OR n.name LIKE ?)");
    args.push(`%${entityNorm(f.q)}%`, `%${f.q.trim()}%`);
  }
  args.push(f.limit ?? 500);
  return db
    .prepare(
      `SELECT n.*, COUNT(e.id) AS count FROM entities n
       JOIN entry_entities ee ON ee.entity_id = n.id JOIN entries e ON e.id = ee.entry_id
       WHERE ${where.join(" AND ")} GROUP BY n.id ORDER BY count DESC, n.name COLLATE NOCASE LIMIT ?`,
    )
    .all(...args)
    .map(toEntity);
}

export function getEntity(id: number): Entity | null {
  const r = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id);
  if (!r) return null;
  const aliases = db.prepare(`SELECT norm FROM entity_aliases WHERE entity_id = ? ORDER BY norm`).all(id).map((a) => String(a.norm));
  return { ...toEntity(r), aliases };
}

export function findEntity(name: string): Entity | null {
  const id = resolveEntityId(name);
  return id ? getEntity(id) : null;
}

/** Live memories mentioning an entity, optionally limited to what a project can see. */
export function entityEntries(entityId: number, visibleFrom?: number | null): Entry[] {
  const vis = visibleFrom === undefined ? "" : "AND (e.scope IN ('global','user') OR e.project_id = ?)";
  const args: number[] = [entityId];
  if (visibleFrom !== undefined) args.push(visibleFrom ?? -1);
  return db
    .prepare(
      `SELECT e.* FROM entry_entities ee JOIN entries e ON e.id = ee.entry_id
       WHERE ee.entity_id = ? AND e.deleted_at IS NULL ${vis} ORDER BY e.pinned DESC, e.updated_at DESC`,
    )
    .all(...args)
    .map(rowToEntry);
}

export function updateEntity(id: number, patch: { name?: string; kind?: string; description?: string }): Entity {
  const cur = getEntity(id);
  if (!cur) throw new HttpError(404, "entity not found");
  const name = patch.name !== undefined ? entityDisplayName(patch.name) : cur.name;
  if (!name) throw new HttpError(400, "name is required");
  const norm = entityNorm(name);
  const kind = patch.kind !== undefined ? patch.kind : cur.kind;
  if (!(ENTITY_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of ${ENTITY_KINDS.join(", ")}`);
  const other = resolveEntityId(name);
  if (other && other !== id) throw new HttpError(409, `"${name}" is already entity #${other} — merge instead`);
  transaction(() => {
    const oldNorm = entityNorm(cur.name);
    // Keep the old spelling as an alias so the LLM's next mention still resolves here.
    if (oldNorm !== norm) db.prepare(`INSERT OR REPLACE INTO entity_aliases (norm, entity_id) VALUES (?, ?)`).run(oldNorm, id);
    db.prepare(`DELETE FROM entity_aliases WHERE norm = ?`).run(norm);
    db.prepare(`UPDATE entities SET name = ?, norm = ?, kind = ?, description = ?, updated_at = ? WHERE id = ?`).run(
      name, norm, kind, patch.description !== undefined ? patch.description.trim().slice(0, 2000) : cur.description, now(), id,
    );
  });
  invalidateEntityNames();
  return getEntity(id)!;
}

/** Merge `fromId` into `intoId`: mentions move over, the old name becomes an alias. */
export function mergeEntities(fromId: number, intoId: number): Entity {
  if (fromId === intoId) throw new HttpError(400, "cannot merge an entity into itself");
  const from = getEntity(fromId);
  const into = getEntity(intoId);
  if (!from || !into) throw new HttpError(404, "entity not found");
  transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO entry_entities (entry_id, entity_id) SELECT entry_id, ? FROM entry_entities WHERE entity_id = ?`).run(intoId, fromId);
    db.prepare(`UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ?`).run(intoId, fromId);
    db.prepare(`INSERT OR REPLACE INTO entity_aliases (norm, entity_id) VALUES (?, ?)`).run(entityNorm(from.name), intoId);
    if (!into.description && from.description) db.prepare(`UPDATE entities SET description = ? WHERE id = ?`).run(from.description, intoId);
    db.prepare(`DELETE FROM entities WHERE id = ?`).run(fromId);
    db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(now(), intoId);
  });
  invalidateEntityNames();
  return getEntity(intoId)!;
}

export function deleteEntity(id: number) {
  if (!getEntity(id)) throw new HttpError(404, "entity not found");
  db.prepare(`DELETE FROM entities WHERE id = ?`).run(id);
  invalidateEntityNames();
}

// ------------------------------------------------------- mention detection

let nameCache: { version: number; list: { id: number; key: string; ascii: boolean }[] } | null = null;

function entityNames() {
  if (nameCache && nameCache.version === entitiesVersion) return nameCache.list;
  const rows = [
    ...db.prepare(`SELECT id, name FROM entities`).all().map((r) => ({ id: Number(r.id), name: String(r.name) })),
    // Aliases are stored normalized; still useful when the text spells them that way.
    ...db.prepare(`SELECT entity_id AS id, norm AS name FROM entity_aliases`).all().map((r) => ({ id: Number(r.id), name: String(r.name) })),
  ];
  const list = rows
    .map((r) => ({ id: r.id, key: r.name.toLowerCase(), ascii: /^[\x20-\x7e]+$/.test(r.name) }))
    // Two-character Korean words ("서버") match inside too many other words; ASCII names get word boundaries instead.
    .filter((r) => r.key.length >= (r.ascii ? 2 : 3));
  nameCache = { version: entitiesVersion, list };
  return list;
}
function invalidateEntityNames() {
  nameCache = null;
}

/** Entities whose name appears in the text (ASCII names on word boundaries, so "pi" ≠ "pip"). */
export function mentionedEntities(text: string, limit = 12): number[] {
  const t = text.toLowerCase();
  const found = new Map<number, number>();
  for (const n of entityNames()) {
    if (found.has(n.id)) continue;
    let i = t.indexOf(n.key);
    while (i >= 0) {
      const before = t[i - 1];
      const after = t[i + n.key.length];
      const ok = !n.ascii || (!/[a-z0-9]/.test(before ?? "") && !/[a-z0-9]/.test(after ?? ""));
      if (ok) {
        found.set(n.id, n.key.length);
        break;
      }
      i = t.indexOf(n.key, i + 1);
    }
  }
  // Longer names first: "pg Pool" is more specific than "pg".
  return [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

// -------------------------------------------------------------- neighbors

/** Live memories linked to any of `ids` (one hop), with how they are linked. */
export function linkedNeighbors(ids: number[], visibleFrom: number | null, types: readonly LinkType[] = LINK_TYPES) {
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  const tp = types.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT e.*, l.type AS link_type, CASE WHEN l.from_id IN (${ph}) THEN l.from_id ELSE l.to_id END AS via,
              CASE WHEN l.from_id IN (${ph}) THEN 'out' ELSE 'in' END AS dir
       FROM entry_links l JOIN entries e ON e.id = CASE WHEN l.from_id IN (${ph}) THEN l.to_id ELSE l.from_id END
       WHERE (l.from_id IN (${ph}) OR l.to_id IN (${ph})) AND l.type IN (${tp}) AND e.deleted_at IS NULL
         AND (e.scope IN ('global','user') OR e.project_id = ?)`,
    )
    .all(...ids, ...ids, ...ids, ...ids, ...ids, ...types, visibleFrom ?? -1)
    // dir "out": the known memory points at this neighbor; "in": the neighbor points at it.
    .map((r) => ({ entry: rowToEntry(r), type: String(r.link_type) as LinkType, via: Number(r.via), dir: String(r.dir) as "out" | "in" }))
    .filter((n) => !ids.includes(n.entry.id));
}

/** For the memory_graph tool / API: the neighborhood of an entity or a memory. */
export function neighborhood(center: { entity?: string; id?: number }, visibleFrom: number | null) {
  if (center.id) {
    const e = getEntry(center.id);
    if (!e || e.deleted_at) throw new HttpError(404, `memory #${center.id} not found`);
    return { kind: "memory" as const, memory: e, entities: entitiesOf(e.id), links: linksOf(e.id) };
  }
  const ent = findEntity(center.entity ?? "");
  if (!ent) {
    const close = listEntities({ q: center.entity, limit: 8 }).map((x) => x.name);
    throw new HttpError(404, `no entity "${center.entity}"${close.length ? `. Similar: ${close.join(", ")}` : ""}`);
  }
  const memories = entityEntries(ent.id, visibleFrom);
  // Entities that co-occur with this one in the same memories.
  const related = memories.length
    ? db
        .prepare(
          `SELECT n.*, COUNT(*) AS count FROM entry_entities ee JOIN entities n ON n.id = ee.entity_id
           WHERE ee.entry_id IN (${memories.map(() => "?").join(",")}) AND n.id != ?
           GROUP BY n.id ORDER BY count DESC LIMIT 15`,
        )
        .all(...memories.map((m) => m.id), ent.id)
        .map(toEntity)
    : [];
  return { kind: "entity" as const, entity: ent, memories: memories.slice(0, 40), related };
}

// ------------------------------------------------------------- full graph

export interface GraphData {
  nodes: (
    | { id: string; type: "memory"; entryId: number; label: string; category: string; scope: string; projectId: number | null }
    | { id: string; type: "entity"; entityId: number; label: string; kind: string; count: number }
  )[];
  edges: { id: string; source: string; target: string; type: LinkType | "mentions" }[];
  truncated: boolean;
  /** Memories in this view (the project's own, or all) that have no entities yet. */
  unlinked: number;
}

/**
 * Graph for the web view. project: that project's memories plus the global /
 * user memories that share an entity with them (or with each other) — so the
 * cross-project bridges stay visible. No project: every live memory.
 */
export function graphData(projectId: number | null, opts: { limit?: number } = {}): GraphData {
  const limit = opts.limit ?? 1500;
  let entries: Entry[];
  let own: Entry[];
  if (projectId) {
    own = db.prepare(`SELECT * FROM entries WHERE deleted_at IS NULL AND project_id = ? AND category != 'standing'`).all(projectId).map(rowToEntry);
    const shared = db
      .prepare(
        `SELECT DISTINCT e.* FROM entries e JOIN entry_entities ee ON ee.entry_id = e.id
         WHERE e.deleted_at IS NULL AND e.scope IN ('global','user') AND e.category != 'standing'
           AND ee.entity_id IN (SELECT ee2.entity_id FROM entry_entities ee2 JOIN entries p ON p.id = ee2.entry_id
                                WHERE p.project_id = ? AND p.deleted_at IS NULL)`,
      )
      .all(projectId)
      .map(rowToEntry);
    entries = [...own, ...shared];
  } else {
    entries = db.prepare(`SELECT * FROM entries WHERE deleted_at IS NULL AND category != 'standing' ORDER BY updated_at DESC`).all().map(rowToEntry);
    own = entries;
  }
  const truncated = entries.length > limit;
  entries = entries.slice(0, limit);
  const ids = new Set(entries.map((e) => e.id));
  const nodes: GraphData["nodes"] = entries.map((e) => ({
    id: `m${e.id}`, type: "memory", entryId: e.id, label: e.title, category: e.category, scope: e.scope, projectId: e.project_id,
  }));
  const edges: GraphData["edges"] = [];
  if (ids.size) {
    const ph = [...ids].map(() => "?").join(",");
    const mentions = db
      .prepare(`SELECT ee.entry_id, n.* FROM entry_entities ee JOIN entities n ON n.id = ee.entity_id WHERE ee.entry_id IN (${ph})`)
      .all(...ids);
    const ents = new Map<number, { e: Entity; count: number }>();
    for (const r of mentions) {
      const eid = Number(r.id);
      const cur = ents.get(eid) ?? { e: toEntity(r), count: 0 };
      cur.count++;
      ents.set(eid, cur);
      edges.push({ id: `x${r.entry_id}-${eid}`, source: `m${r.entry_id}`, target: `n${eid}`, type: "mentions" });
    }
    for (const { e, count } of ents.values()) nodes.push({ id: `n${e.id}`, type: "entity", entityId: e.id, label: e.name, kind: e.kind, count });
    for (const l of db.prepare(`SELECT * FROM entry_links WHERE from_id IN (${ph}) AND to_id IN (${ph})`).all(...ids, ...ids).map(toLink))
      edges.push({ id: `l${l.from_id}-${l.to_id}-${l.type}`, source: `m${l.from_id}`, target: `m${l.to_id}`, type: l.type });
  }
  const ownIds = own.map((e) => e.id);
  const withEntities = new Set<number>();
  for (let i = 0; i < ownIds.length; i += 500) {
    const part = ownIds.slice(i, i + 500);
    for (const r of db.prepare(`SELECT DISTINCT entry_id FROM entry_entities WHERE entry_id IN (${part.map(() => "?").join(",")})`).all(...part))
      withEntities.add(Number(r.entry_id));
  }
  const unlinked = ownIds.filter((id) => !withEntities.has(id)).length;
  return { nodes, edges, truncated, unlinked };
}

export function graphStats() {
  const one = (sql: string) => Number(Object.values(db.prepare(sql).get() ?? { n: 0 })[0]);
  return {
    entities: one(`SELECT COUNT(DISTINCT ee.entity_id) FROM entry_entities ee JOIN entries e ON e.id = ee.entry_id WHERE e.deleted_at IS NULL`),
    links: one(`SELECT COUNT(*) FROM entry_links l JOIN entries a ON a.id = l.from_id JOIN entries b ON b.id = l.to_id WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL`),
    unlinked: one(
      `SELECT COUNT(*) FROM entries e WHERE e.deleted_at IS NULL AND e.category != 'standing' AND NOT EXISTS (SELECT 1 FROM entry_entities ee WHERE ee.entry_id = e.id)`,
    ),
    graphPending: one(`SELECT COUNT(*) FROM graph_jobs WHERE status IN ('pending','processing')`),
  };
}

// -------------------------------------------------------- backfill queue

export interface GraphJob {
  id: number;
  status: "pending" | "processing" | "done" | "skipped" | "error";
  payload: { entries: number[]; projectId?: number | null };
  result: { done?: number[]; chunks?: number; entities?: number; links?: number; ms?: number } | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}
const toJob = (r: Row): GraphJob => ({
  id: Number(r.id),
  status: r.status as GraphJob["status"],
  payload: JSON.parse(String(r.payload ?? "{}")),
  result: r.result == null ? null : JSON.parse(String(r.result)),
  error: r.error == null ? null : String(r.error),
  created_at: String(r.created_at),
  processed_at: r.processed_at == null ? null : String(r.processed_at),
});

let wakeWorker: (() => void) | null = null;
export function onGraphJobQueued(fn: () => void) {
  wakeWorker = fn;
}

/** Queue a backfill over memories that have no entities yet (one project, or all). */
export function enqueueBackfill(projectId: number | null, opts: { all?: boolean } = {}): GraphJob {
  const where = ["deleted_at IS NULL", "category != 'standing'"];
  const args: number[] = [];
  if (projectId) {
    where.push("project_id = ?");
    args.push(projectId);
  }
  if (!opts.all) where.push("NOT EXISTS (SELECT 1 FROM entry_entities ee WHERE ee.entry_id = entries.id)");
  const ids = db
    .prepare(`SELECT id FROM entries WHERE ${where.join(" AND ")} ORDER BY scope, project_id, category, id LIMIT ?`)
    .all(...args, config.graph.backfillMax)
    .map((r) => Number(r.id));
  if (!ids.length) throw new HttpError(400, "no memories to backfill");
  const res = db.prepare(`INSERT INTO graph_jobs (payload) VALUES (?)`).run(JSON.stringify({ entries: ids, projectId }));
  wakeWorker?.();
  return getGraphJob(Number(res.lastInsertRowid))!;
}

export function getGraphJob(id: number): GraphJob | null {
  const r = db.prepare(`SELECT * FROM graph_jobs WHERE id = ?`).get(id);
  return r ? toJob(r) : null;
}
export function listGraphJobs(limit = 20): GraphJob[] {
  return db.prepare(`SELECT * FROM graph_jobs ORDER BY id DESC LIMIT ?`).all(limit).map(toJob);
}
export function claimGraphJob(): GraphJob | null {
  const r = db.prepare(`SELECT id FROM graph_jobs WHERE status = 'pending' ORDER BY id LIMIT 1`).get();
  if (!r) return null;
  const res = db.prepare(`UPDATE graph_jobs SET status = 'processing' WHERE id = ? AND status = 'pending'`).run(Number(r.id));
  return res.changes ? getGraphJob(Number(r.id)) : null;
}
export function saveGraphProgress(id: number, result: unknown) {
  db.prepare(`UPDATE graph_jobs SET result = ? WHERE id = ?`).run(JSON.stringify(result), id);
}
export function finishGraphJob(id: number, status: GraphJob["status"], result: unknown, error: string | null = null) {
  db.prepare(`UPDATE graph_jobs SET status = ?, result = ?, error = ?, processed_at = ? WHERE id = ?`).run(
    status, result == null ? null : JSON.stringify(result), error, now(), id,
  );
}
export function retryGraphJob(id: number): GraphJob {
  const j = getGraphJob(id);
  if (!j) throw new HttpError(404, "job not found");
  if (j.status !== "error") throw new HttpError(409, "only failed jobs can be retried");
  db.prepare(`UPDATE graph_jobs SET status = 'pending', error = NULL WHERE id = ?`).run(id);
  wakeWorker?.();
  return getGraphJob(id)!;
}
