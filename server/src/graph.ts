import { config } from "./config.ts";
import { db, now, rowToEntry, transaction, type Entry, type Source } from "./db.ts";
import { ENTITY_KINDS, entitiesVersion, entityDisplayName, entityNorm, resolveEntityId } from "./entities.ts";
import {
  ENTITY_NOT_FOUND,
  MEMORIES_MISSING,
  entityRevertBlock,
  getGraphRevision,
  markGraphRevisionReverted,
  planEntityUpdateRevert,
  recordGraphRevision,
  recreateBlock,
  supersedesBlock,
  type GraphRevision,
} from "./graph-revisions.ts";
import { ACTIVE_SQL, HttpError, getEntry } from "./store.ts";

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

/**
 * Creation times of a link's two memories, stored in link snapshots so a revert can
 * tell the original memories from newer ones that took a purged id.
 */
function endpointStamps(fromId: number, toId: number): { from_created_at: string | null; to_created_at: string | null } {
  return { from_created_at: getEntry(fromId)?.created_at ?? null, to_created_at: getEntry(toId)?.created_at ?? null };
}

/**
 * Add a typed link between two live memories. Returns false when it already existed.
 * `pending`: a supersedes link that retires nothing until a person confirms it (retires = 0;
 * the graph backfill's guesses, G-084). Confirming = adding the same link without `pending`.
 */
export function addLink(fromId: number, toId: number, type: LinkType, author: Source, opts: { revertOf?: number; pending?: boolean } = {}): boolean {
  if (fromId === toId) throw new HttpError(400, "a memory cannot link to itself");
  if (!isLinkType(type)) throw new HttpError(400, `link type must be one of ${LINK_TYPES.join(", ")}`);
  const a = getEntry(fromId);
  const b = getEntry(toId);
  if (!a || a.deleted_at || !b || b.deleted_at) throw new HttpError(404, MEMORIES_MISSING);
  if (type === "supersedes") {
    // Same project, no cycle (G-026) — shared with the revision list (G-041).
    const refused = supersedesBlock(fromId, toId);
    if (refused) throw new HttpError(refused.status ?? 409, refused.message);
  }
  // "related" is symmetric: store it once.
  if (type === "related" && db.prepare(`SELECT 1 FROM entry_links WHERE from_id = ? AND to_id = ? AND type = 'related'`).get(toId, fromId)) return false;
  return transaction(() => {
    const prior = db.prepare(`SELECT retires, author FROM entry_links WHERE from_id = ? AND to_id = ? AND type = ?`).get(fromId, toId, type);
    let changed: boolean;
    if (type === "supersedes" && opts.pending) {
      changed = db.prepare(`INSERT OR IGNORE INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', ?, 0)`).run(fromId, toId, author).changes > 0;
    } else if (type === "supersedes") {
      // Making a pre-v0.6 (informational) or pending supersedes link again turns it into a retiring one.
      const res = db
        .prepare(
          `INSERT INTO entry_links (from_id, to_id, type, author) VALUES (?, ?, 'supersedes', ?)
           ON CONFLICT(from_id, to_id, type) DO UPDATE SET retires = 1 WHERE retires = 0`,
        )
        .run(fromId, toId, author);
      changed = res.changes > 0;
    } else {
      changed = db.prepare(`INSERT OR IGNORE INTO entry_links (from_id, to_id, type, author) VALUES (?, ?, ?, ?)`).run(fromId, toId, type, author).changes > 0;
    }
    if (changed) {
      recordGraphRevision({
        target: "link",
        action: "add",
        // prior: null = the row was inserted; {retires: 0, author} = a legacy supersedes link was turned on.
        snapshot: {
          from_id: fromId, to_id: toId, type,
          prior: prior ? { retires: Number(prior.retires), author: String(prior.author) } : null,
          entity_ids: [], entry_ids: [fromId, toId],
        },
        author,
        revertOf: opts.revertOf,
      });
    }
    return changed;
  });
}

export function removeLink(fromId: number, toId: number, type: LinkType, author: Source = "human", opts: { revertOf?: number } = {}): boolean {
  return transaction(() => {
    const row = db.prepare(`SELECT * FROM entry_links WHERE from_id = ? AND to_id = ? AND type = ?`).get(fromId, toId, type);
    if (!row) return false;
    const res = db.prepare(`DELETE FROM entry_links WHERE from_id = ? AND to_id = ? AND type = ?`).run(fromId, toId, type);
    if (!res.changes) return false;
    recordGraphRevision({ target: "link", action: "remove", snapshot: removedLinkSnapshot(row), author, revertOf: opts.revertOf });
    return true;
  });
}

/** removeLink's snapshot of a link row (also used for the links moveLinks drops or moves). */
function removedLinkSnapshot(row: Row) {
  const [from, to] = [Number(row.from_id), Number(row.to_id)];
  return {
    from_id: from, to_id: to, type: String(row.type),
    retires: Number(row.retires), link_author: String(row.author), link_created_at: String(row.created_at),
    ...endpointStamps(from, to),
    entity_ids: [], entry_ids: [from, to],
  };
}

/**
 * Re-point every link of `fromId` to `toId` (used when memories are merged); links between the two are dropped.
 * Incoming retiring "supersedes" links are dropped, not moved: they say something replaced the
 * merged-away memory's fact, not the kept memory's — moving one would retire (hide) the kept memory
 * now or once its source is restored (G-026). Unconfirmed ones (retires = 0: a backfill guess or a
 * pre-v0.6 link) are dropped too: confirming one later would hide the merged memory on a guess about
 * the old fact (G-084).
 *
 * With `author`, each change is recorded in the same transaction with the existing link actions
 * (G-034): a dropped link as a "remove", a moved one as a "remove" of the old row plus an "add" of
 * the new one. Reverting the remove puts the link back on `fromId` once it is out of the trash
 * (endpoint_trashed until then, G-041); reverting the add takes it off `toId`. Without `author`
 * nothing is recorded (callers that have not opted in yet).
 */
export function moveLinks(fromId: number, toId: number, opts: { author?: Source } = {}) {
  transaction(() => {
    if (opts.author) recordLinkMoves(fromId, toId, opts.author);
    db.prepare(`DELETE FROM entry_links WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)`).run(fromId, toId, toId, fromId);
    db.prepare(`DELETE FROM entry_links WHERE to_id = ? AND type = 'supersedes'`).run(fromId);
    db.prepare(`UPDATE OR IGNORE entry_links SET from_id = ? WHERE from_id = ?`).run(toId, fromId);
    db.prepare(`UPDATE OR IGNORE entry_links SET to_id = ? WHERE to_id = ?`).run(toId, fromId);
    // Rows that would have duplicated an existing link stay behind; drop them.
    db.prepare(`DELETE FROM entry_links WHERE from_id = ? OR to_id = ?`).run(fromId, fromId);
  });
}

/**
 * What moveLinks is about to do, worked out on the rows before it runs (its statements
 * in the same order) and recorded. Outgoing rows become (toId, x) and incoming ones
 * (y, toId); neither can collide with the other once the links between the two are
 * gone, so checking each new key against the rows as they are now is enough.
 */
function recordLinkMoves(fromId: number, toId: number, author: Source) {
  const rows = db.prepare(`SELECT * FROM entry_links WHERE from_id = ? OR to_id = ? ORDER BY rowid`).all(fromId, fromId);
  const exists = db.prepare(`SELECT 1 FROM entry_links WHERE from_id = ? AND to_id = ? AND type = ?`);
  for (const row of rows) {
    const [from, to, type] = [Number(row.from_id), Number(row.to_id), String(row.type)];
    recordGraphRevision({ target: "link", action: "remove", snapshot: removedLinkSnapshot(row), author });
    if (from === toId || to === toId) continue;
    if (to === fromId && type === "supersedes") continue;
    const [nf, nt] = from === fromId ? [toId, to] : [from, toId];
    if (exists.get(nf, nt, type)) continue;
    recordGraphRevision({
      target: "link",
      action: "add",
      snapshot: { from_id: nf, to_id: nt, type, prior: null, moved_from: fromId, entity_ids: [], entry_ids: [nf, nt] },
      author,
    });
  }
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
    // A supersedes link that retires nothing yet: waiting for a person (G-084).
    pending: r.type === "supersedes" && Number(r.retires) === 0,
    dir: String(r.dir) as "out" | "in",
    other: { id: Number(r.other_id), title: String(r.other_title), category: String(r.other_category), scope: String(r.other_scope) },
  }));
}

export interface PendingSupersede {
  from_id: number;
  to_id: number;
  author: Source;
  created_at: string;
  from: { id: number; title: string; category: string };
  to: { id: number; title: string; category: string };
}

/**
 * Supersedes links that retire nothing yet (the backfill's guesses, older informational ones),
 * both memories alive, in one scope: a project's (its memories are being replaced) or, with
 * null, the global / user memories'. Oldest first. G-084.
 */
export function pendingSupersedes(projectId: number | null): PendingSupersede[] {
  const scope = projectId ? "o.project_id = ?" : "o.scope IN ('global','user')";
  return db
    .prepare(
      `SELECT l.from_id, l.to_id, l.author, l.created_at, n.title AS nt, n.category AS nc, o.title AS ot, o.category AS oc
       FROM entry_links l JOIN entries n ON n.id = l.from_id JOIN entries o ON o.id = l.to_id
       WHERE l.type = 'supersedes' AND l.retires = 0 AND n.deleted_at IS NULL AND o.deleted_at IS NULL AND ${scope}
       ORDER BY l.created_at, l.from_id`,
    )
    .all(...(projectId ? [projectId] : []))
    .map((r) => ({
      from_id: Number(r.from_id), to_id: Number(r.to_id), author: r.author as Source, created_at: String(r.created_at),
      from: { id: Number(r.from_id), title: String(r.nt), category: String(r.nc) },
      to: { id: Number(r.to_id), title: String(r.ot), category: String(r.oc) },
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

/**
 * Live memories mentioning an entity, optionally limited to what a project can
 * see. activeOnly drops superseded/expired ones in SQL, before `limit` applies
 * (so inactive newer memories never crowd out active ones).
 */
export function entityEntries(entityId: number, visibleFrom?: number | null, opts: { activeOnly?: boolean; limit?: number } = {}): Entry[] {
  const vis = visibleFrom === undefined ? "" : "AND (e.scope IN ('global','user') OR e.project_id = ?)";
  const args: number[] = [entityId];
  if (visibleFrom !== undefined) args.push(visibleFrom ?? -1);
  const active = opts.activeOnly ? `AND ${ACTIVE_SQL("e")}` : "";
  const limit = opts.limit != null ? "LIMIT ?" : "";
  if (opts.limit != null) args.push(opts.limit);
  return db
    .prepare(
      `SELECT e.* FROM entry_entities ee JOIN entries e ON e.id = ee.entry_id
       WHERE ee.entity_id = ? AND e.deleted_at IS NULL ${vis} ${active} ORDER BY e.pinned DESC, e.updated_at DESC ${limit}`,
    )
    .all(...args)
    .map(rowToEntry);
}

export function updateEntity(id: number, patch: { name?: string; kind?: string; description?: string }, author: Source = "human"): Entity {
  const cur = getEntity(id);
  if (!cur) throw new HttpError(404, ENTITY_NOT_FOUND);
  const name = patch.name !== undefined ? entityDisplayName(patch.name) : cur.name;
  if (!name) throw new HttpError(400, "name is required");
  const norm = entityNorm(name);
  const kind = patch.kind !== undefined ? patch.kind : cur.kind;
  if (!(ENTITY_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of ${ENTITY_KINDS.join(", ")}`);
  const other = resolveEntityId(name);
  if (other && other !== id) throw new HttpError(409, `"${name}" is already entity #${other} — merge instead`);
  const description = patch.description !== undefined ? patch.description.trim().slice(0, 2000) : cur.description;
  if (name === cur.name && kind === cur.kind && description === cur.description) return cur;
  transaction(() => {
    const oldNorm = entityNorm(cur.name);
    const aliasesAdded: string[] = [];
    const aliasesRemoved: string[] = [];
    // Keep the old spelling as an alias so the LLM's next mention still resolves here.
    if (oldNorm !== norm) {
      db.prepare(`INSERT OR REPLACE INTO entity_aliases (norm, entity_id) VALUES (?, ?)`).run(oldNorm, id);
      aliasesAdded.push(oldNorm);
    }
    // Renaming back to an old spelling: that alias becomes the name again.
    if (db.prepare(`DELETE FROM entity_aliases WHERE norm = ?`).run(norm).changes) aliasesRemoved.push(norm);
    db.prepare(`UPDATE entities SET name = ?, norm = ?, kind = ?, description = ?, updated_at = ? WHERE id = ?`).run(name, norm, kind, description, now(), id);
    recordGraphRevision({
      target: "entity",
      action: "update",
      snapshot: {
        entity_id: id,
        before: { name: cur.name, kind: cur.kind, description: cur.description },
        after: { name, kind, description },
        aliases_added: aliasesAdded,
        aliases_removed: aliasesRemoved,
        entity_ids: [id], entry_ids: [],
      },
      author,
    });
  });
  invalidateEntityNames();
  return getEntity(id)!;
}

const entityRow = (id: number) => db.prepare(`SELECT id, name, norm, kind, description, created_at, updated_at FROM entities WHERE id = ?`).get(id) as Row;
const aliasNorms = (id: number) => db.prepare(`SELECT norm FROM entity_aliases WHERE entity_id = ? ORDER BY norm`).all(id).map((r) => String(r.norm));
const mentionIds = (id: number) => db.prepare(`SELECT entry_id FROM entry_entities WHERE entity_id = ? ORDER BY entry_id`).all(id).map((r) => Number(r.entry_id));
/** Pairs a person dismissed as "not the same" (entity_pair_dismissed), as the other entity's id. */
const dismissedWith = (id: number) =>
  db.prepare(`SELECT CASE WHEN a = ? THEN b ELSE a END AS other FROM entity_pair_dismissed WHERE a = ? OR b = ?`).all(id, id, id).map((r) => Number(r.other));

/** Merge `fromId` into `intoId`: mentions move over, the old name becomes an alias. */
export function mergeEntities(fromId: number, intoId: number, author: Source = "human", opts: { revertOf?: number } = {}): Entity {
  if (fromId === intoId) throw new HttpError(400, "cannot merge an entity into itself");
  const from = getEntity(fromId);
  const into = getEntity(intoId);
  if (!from || !into) throw new HttpError(404, ENTITY_NOT_FOUND);
  transaction(() => {
    const row = entityRow(fromId);
    const entries = mentionIds(fromId);
    const newMentions = db
      .prepare(
        `SELECT entry_id FROM entry_entities WHERE entity_id = ?
           AND entry_id NOT IN (SELECT entry_id FROM entry_entities WHERE entity_id = ?) ORDER BY entry_id`,
      )
      .all(fromId, intoId)
      .map((r) => Number(r.entry_id));
    const aliases = aliasNorms(fromId);
    const dismissed = dismissedWith(fromId);
    const descriptionCopied = !into.description && !!from.description;
    db.prepare(`INSERT OR IGNORE INTO entry_entities (entry_id, entity_id) SELECT entry_id, ? FROM entry_entities WHERE entity_id = ?`).run(intoId, fromId);
    db.prepare(`UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ?`).run(intoId, fromId);
    db.prepare(`INSERT OR REPLACE INTO entity_aliases (norm, entity_id) VALUES (?, ?)`).run(entityNorm(from.name), intoId);
    if (descriptionCopied) db.prepare(`UPDATE entities SET description = ? WHERE id = ?`).run(from.description, intoId);
    db.prepare(`DELETE FROM entities WHERE id = ?`).run(fromId);
    db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(now(), intoId);
    recordGraphRevision({
      target: "entity",
      action: "merge",
      snapshot: {
        entity_id: fromId,
        into_id: intoId,
        entity: row,
        // Alias norms of the merged-away entity, all moved to the target; its
        // own name norm was added to the target as well.
        aliases,
        name_alias: String(row.norm),
        entries,
        // Memories that did not mention the target before (revert drops the target mention there).
        new_target_mentions: newMentions,
        description_copied: descriptionCopied,
        dismissed,
        entity_ids: [fromId, intoId], entry_ids: entries,
      },
      author,
      revertOf: opts.revertOf,
    });
  });
  invalidateEntityNames();
  return getEntity(intoId)!;
}

export function deleteEntity(id: number, author: Source = "human", opts: { revertOf?: number } = {}) {
  if (!getEntity(id)) throw new HttpError(404, ENTITY_NOT_FOUND);
  transaction(() => {
    const row = entityRow(id);
    const aliases = aliasNorms(id);
    const entries = mentionIds(id);
    const dismissed = dismissedWith(id);
    db.prepare(`DELETE FROM entities WHERE id = ?`).run(id);
    recordGraphRevision({
      target: "entity",
      action: "delete",
      snapshot: { entity_id: id, entity: row, aliases, entries, dismissed, entity_ids: [id], entry_ids: entries },
      author,
      revertOf: opts.revertOf,
    });
  });
  invalidateEntityNames();
}

// ---------------------------------------------------------- graph history

export function revertGraphRevision(id: number, author: Source = "human"): { revision: GraphRevision; revert: GraphRevision | null } {
  const rev = getGraphRevision(id);
  if (!rev) throw new HttpError(404, "revision not found");
  if (rev.reverted_at) throw new HttpError(409, "this change was already reverted");
  // Same check the revision list reports as `blocked` (G-041).
  if (rev.blocked) throw new HttpError(rev.blocked.status ?? 409, rev.blocked.message);
  if (!rev.revertible) throw new HttpError(409, `a ${rev.target} "${rev.action}" cannot be reverted`);
  const s = rev.snapshot;
  const newId = transaction(() => {
    let written: number | null = null;
    if (rev.target === "link" && rev.action === "add") written = revertLinkAdd(s, author, id);
    else if (rev.target === "link" && rev.action === "remove") {
      if (Number(s.retires) === 0) written = restoreInformationalLink(s, author, id);
      else {
        if (!addLink(Number(s.from_id), Number(s.to_id), s.type, author, { revertOf: id })) {
          throw new HttpError(409, "the link already exists");
        }
        written = lastRevisionId();
      }
    } else if (rev.action === "update") written = revertEntityUpdate(s, author, id);
    else if (rev.action === "merge") written = revertEntityMerge(s, author, id);
    else if (rev.action === "delete") written = revertEntityDelete(s, author, id);
    // A merge / delete revert's own revert merges / deletes again (checked by entityRevertBlock above).
    else if (rev.action === "unmerge") {
      mergeEntities(Number(s.entity_id), Number(s.into_id), author, { revertOf: id });
      written = lastRevisionId();
    } else if (rev.action === "restore") {
      deleteEntity(Number(s.entity_id), author, { revertOf: id });
      written = lastRevisionId();
    }
    if (!markGraphRevisionReverted(id)) throw new HttpError(409, "this change was already reverted");
    return written;
  });
  invalidateEntityNames();
  return { revision: getGraphRevision(id)!, revert: newId ? getGraphRevision(newId) : null };
}

type Snap = Record<string, any>;
/** Id of the revision just recorded by addLink / removeLink (same connection, same transaction). */
const lastRevisionId = () => Number((db.prepare(`SELECT MAX(id) AS id FROM graph_revisions`).get() as Row).id);

/**
 * Put back a removed pre-v0.6 informational supersedes link (retires = 0) as it
 * was. It retires nothing, so addLink's cycle and same-project checks (which
 * protect retiring links) do not apply: a v0.5 database may hold A⇄B pairs or
 * project → global links, and their removal must stay revertible.
 */
function restoreInformationalLink(s: Snap, author: Source, revertOf: number): number {
  const [from, to, type] = [Number(s.from_id), Number(s.to_id), s.type as LinkType];
  const a = getEntry(from);
  const b = getEntry(to);
  if (!a || a.deleted_at || !b || b.deleted_at) throw new HttpError(404, MEMORIES_MISSING);
  if (db.prepare(`SELECT 1 FROM entry_links WHERE from_id = ? AND to_id = ? AND type = ?`).get(from, to, type)) {
    throw new HttpError(409, "the link already exists");
  }
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, created_at, retires) VALUES (?, ?, ?, ?, ?, 0)`).run(
    from, to, type, String(s.link_author), String(s.link_created_at),
  );
  // prior: null → reverting this add removes the row again (removeLink snapshots retires = 0).
  return recordGraphRevision({
    target: "link",
    action: "add",
    snapshot: { from_id: from, to_id: to, type, prior: null, entity_ids: [], entry_ids: [from, to] },
    author,
    revertOf,
  });
}

function revertLinkAdd(s: Snap, author: Source, revertOf: number): number {
  const [from, to, type] = [Number(s.from_id), Number(s.to_id), s.type as LinkType];
  const row = db.prepare(`SELECT * FROM entry_links WHERE from_id = ? AND to_id = ? AND type = ?`).get(from, to, type);
  if (!row) throw new HttpError(409, "the link no longer exists");
  if (!s.prior) {
    removeLink(from, to, type, author, { revertOf });
    return lastRevisionId();
  }
  // The add turned a legacy (informational) supersedes link on: turn it off again.
  if (Number(row.retires) === 0) throw new HttpError(409, "the link no longer retires its target");
  db.prepare(`UPDATE entry_links SET retires = ? WHERE from_id = ? AND to_id = ? AND type = ?`).run(Number(s.prior.retires), from, to, type);
  // Recorded as a "remove" of the retiring link; reverting it turns it on again (addLink).
  return recordGraphRevision({
    target: "link",
    action: "remove",
    snapshot: {
      from_id: from, to_id: to, type, retires: 1, downgrade: true,
      link_author: String(row.author), link_created_at: String(row.created_at),
      ...endpointStamps(from, to),
      entity_ids: [], entry_ids: [from, to],
    },
    author,
    revertOf,
  });
}

function revertEntityUpdate(s: Snap, author: Source, revertOf: number): number {
  const id = Number(s.entity_id);
  // The list's `blocked` comes from the same plan (G-041); this runs it.
  const plan = planEntityUpdateRevert(s);
  if (!plan) throw new HttpError(404, ENTITY_NOT_FOUND);
  if (plan.block) throw new HttpError(plan.block.status ?? 409, plan.block.message);
  const cur = getEntity(id)!;
  const before = s.before as { name: string; kind: string; description: string };
  const delAlias = db.prepare(`DELETE FROM entity_aliases WHERE norm = ? AND entity_id = ?`);
  for (const a of plan.remove) delAlias.run(a, id);
  const addAlias = db.prepare(`INSERT INTO entity_aliases (norm, entity_id) VALUES (?, ?)`);
  for (const a of plan.add) addAlias.run(a, id);
  db.prepare(`UPDATE entities SET name = ?, norm = ?, kind = ?, description = ?, updated_at = ? WHERE id = ?`).run(
    before.name, entityNorm(before.name), before.kind, before.description, now(), id,
  );
  return recordGraphRevision({
    target: "entity",
    action: "update",
    snapshot: {
      entity_id: id,
      before: { name: cur.name, kind: cur.kind, description: cur.description },
      after: before,
      aliases_added: plan.add,
      aliases_removed: plan.remove,
      entity_ids: [id], entry_ids: [],
    },
    author,
    revertOf,
  });
}

/** Recreate a merged-away or deleted entity (same id when free). Returns its id. */
function recreateEntity(row: Snap): number {
  const norm = String(row.norm);
  // The name must be free both as a name and as an alias (G-020).
  const taken = recreateBlock(row);
  if (taken) throw new HttpError(taken.status ?? 409, taken.message);
  const free = !db.prepare(`SELECT 1 FROM entities WHERE id = ?`).get(row.id);
  const res = free
    ? db.prepare(`INSERT INTO entities (id, name, norm, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
        row.id, row.name, norm, row.kind, row.description, row.created_at,
      )
    : db.prepare(`INSERT INTO entities (name, norm, kind, description, created_at) VALUES (?, ?, ?, ?, ?)`).run(row.name, norm, row.kind, row.description, row.created_at);
  return free ? Number(row.id) : Number(res.lastInsertRowid);
}

function restoreMentionsAndPairs(entityId: number, entries: number[], dismissed: number[] | undefined) {
  const ins = db.prepare(`INSERT OR IGNORE INTO entry_entities (entry_id, entity_id) SELECT id, ? FROM entries WHERE id = ?`);
  for (const e of entries) ins.run(entityId, e);
  const pair = db.prepare(
    `INSERT OR IGNORE INTO entity_pair_dismissed (a, b) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM entities WHERE id = ?)`,
  );
  for (const o of dismissed ?? []) if (o !== entityId) pair.run(Math.min(o, entityId), Math.max(o, entityId), o);
}

function revertEntityMerge(s: Snap, author: Source, revertOf: number): number {
  const intoId = Number(s.into_id);
  // The target was deleted after the merge: its aliases (including the merged-away
  // entity's) went with it and live only in that delete's snapshot. Reverting the
  // merge now would lose them, and a later delete revert would hand them to the
  // target (old spelling resolving to the wrong entity, G-020). Restore it first.
  // And the merged-away name must still point at the target (or nowhere) — G-020.
  // Same check as the list's `blocked` (G-041).
  const blocked = entityRevertBlock("merge", s);
  if (blocked) throw new HttpError(blocked.status ?? 409, blocked.message);
  const nameNorm = String(s.name_alias);
  db.prepare(`DELETE FROM entity_aliases WHERE norm = ? AND entity_id = ?`).run(nameNorm, intoId);
  const id = recreateEntity(s.entity);
  // Move its aliases back from the target (ones that vanished or moved elsewhere since stay as they are).
  const move = db.prepare(`UPDATE entity_aliases SET entity_id = ? WHERE norm = ? AND entity_id = ?`);
  const restored: string[] = [];
  for (const a of s.aliases as string[]) if (move.run(id, a, intoId).changes) restored.push(a);
  restoreMentionsAndPairs(id, s.entries as number[], s.dismissed);
  const drop = db.prepare(`DELETE FROM entry_entities WHERE entry_id = ? AND entity_id = ?`);
  for (const e of s.new_target_mentions as number[]) drop.run(e, intoId);
  if (s.description_copied) db.prepare(`UPDATE entities SET description = '' WHERE id = ? AND description = ?`).run(intoId, s.entity.description);
  db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(now(), intoId);
  return recordGraphRevision({
    target: "entity",
    action: "unmerge",
    snapshot: { entity_id: id, into_id: intoId, aliases: restored, entity_ids: [id, intoId], entry_ids: s.entries },
    author,
    revertOf,
  });
}

function revertEntityDelete(s: Snap, author: Source, revertOf: number): number {
  const id = recreateEntity(s.entity);
  const add = db.prepare(`INSERT OR IGNORE INTO entity_aliases (norm, entity_id) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM entities WHERE norm = ?)`);
  const restored: string[] = [];
  for (const a of s.aliases as string[]) if (add.run(a, id, a).changes) restored.push(a);
  restoreMentionsAndPairs(id, s.entries as number[], s.dismissed);
  const entries = mentionIds(id);
  return recordGraphRevision({
    target: "entity",
    action: "restore",
    snapshot: { entity_id: id, aliases: restored, entity_ids: [id], entry_ids: entries },
    author,
    revertOf,
  });
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
         AND NOT (l.type = 'supersedes' AND l.retires = 0)
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
    | { id: string; type: "memory"; entryId: number; label: string; category: string; scope: string; projectId: number | null; active: boolean }
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
 * cross-project bridges stay visible. shared: the global / user memories only (the web's
 * "공용" scope, ADR-0048). Neither: every live memory (the web opens it only around a focus).
 */
export function graphData(projectId: number | null, opts: { limit?: number; shared?: boolean } = {}): GraphData {
  const limit = opts.limit ?? 1500;
  let entries: Entry[];
  let own: Entry[];
  if (opts.shared) {
    entries = db
      .prepare(`SELECT * FROM entries WHERE deleted_at IS NULL AND scope IN ('global','user') AND category != 'standing' ORDER BY updated_at DESC`)
      .all()
      .map(rowToEntry);
    own = entries;
  } else if (projectId) {
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
  // Superseded / expired memories are history: the web hides them unless asked (ADR-0047).
  const active = new Set<number>();
  const idList = [...ids];
  for (let i = 0; i < idList.length; i += 500) {
    const part = idList.slice(i, i + 500);
    for (const r of db.prepare(`SELECT e.id FROM entries e WHERE e.id IN (${part.map(() => "?").join(",")}) AND ${ACTIVE_SQL("e")}`).all(...part))
      active.add(Number(r.id));
  }
  const nodes: GraphData["nodes"] = entries.map((e) => ({
    id: `m${e.id}`, type: "memory", entryId: e.id, label: e.title, category: e.category, scope: e.scope, projectId: e.project_id, active: active.has(e.id),
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
    // Per entity, stop at its first live mention: a DISTINCT over every mention looked up each
    // wide entries row (615ms at 100k memories on every /api/health; this form ~10ms).
    entities: one(
      `SELECT COUNT(*) FROM entities x WHERE EXISTS (SELECT 1 FROM entry_entities ee JOIN entries e ON e.id = ee.entry_id WHERE ee.entity_id = x.id AND e.deleted_at IS NULL)`,
    ),
    links: one(`SELECT COUNT(*) FROM entry_links l JOIN entries a ON a.id = l.from_id JOIN entries b ON b.id = l.to_id WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL`),
    unlinked: one(
      `SELECT COUNT(*) FROM entries e WHERE e.deleted_at IS NULL AND e.category != 'standing' AND NOT EXISTS (SELECT 1 FROM entry_entities ee WHERE ee.entry_id = e.id)`,
    ),
    graphPending: one(`SELECT COUNT(*) FROM graph_jobs WHERE status IN ('pending','processing')`),
    // Supersedes guesses waiting for a person (G-084).
    supersedesPending: one(
      `SELECT COUNT(*) FROM entry_links l JOIN entries a ON a.id = l.from_id JOIN entries b ON b.id = l.to_id
       WHERE l.type = 'supersedes' AND l.retires = 0 AND a.deleted_at IS NULL AND b.deleted_at IS NULL`,
    ),
    // Where the oldest one waits (the home card links there): a project id, or 0 = global / user.
    supersedesPendingProject: one(
      `SELECT IFNULL(b.project_id, 0) FROM entry_links l JOIN entries a ON a.id = l.from_id JOIN entries b ON b.id = l.to_id
       WHERE l.type = 'supersedes' AND l.retires = 0 AND a.deleted_at IS NULL AND b.deleted_at IS NULL ORDER BY l.created_at LIMIT 1`,
    ),
  };
}

// -------------------------------------------------------- backfill queue

export interface GraphJob {
  id: number;
  status: "pending" | "processing" | "done" | "skipped" | "error" | "cancelled";
  payload: { entries: number[]; projectId?: number | null; shared?: boolean };
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

/** Queue a backfill over memories that have no entities yet (one project, the global / user ones, or all). */
export function enqueueBackfill(projectId: number | null, opts: { all?: boolean; shared?: boolean } = {}): GraphJob {
  const where = ["deleted_at IS NULL", "category != 'standing'"];
  const args: number[] = [];
  if (opts.shared) where.push("scope IN ('global','user')");
  else if (projectId) {
    where.push("project_id = ?");
    args.push(projectId);
  }
  if (!opts.all) where.push("NOT EXISTS (SELECT 1 FROM entry_entities ee WHERE ee.entry_id = entries.id)");
  const ids = db
    .prepare(`SELECT id FROM entries WHERE ${where.join(" AND ")} ORDER BY scope, project_id, category, id LIMIT ?`)
    .all(...args, config.graph.backfillMax)
    .map((r) => Number(r.id));
  if (!ids.length) throw new HttpError(400, "no memories to backfill");
  const payload = opts.shared ? { entries: ids, projectId: null, shared: true } : { entries: ids, projectId };
  const res = db.prepare(`INSERT INTO graph_jobs (payload) VALUES (?)`).run(JSON.stringify(payload));
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
/** Jobs the worker holds right now (a cancelled one stays here until its in-flight call returns). */
export const runningGraphJobs = new Set<number>();
export function claimGraphJob(): GraphJob | null {
  const r = db.prepare(`SELECT id FROM graph_jobs WHERE status = 'pending' ORDER BY id LIMIT 1`).get();
  if (!r) return null;
  const res = db.prepare(`UPDATE graph_jobs SET status = 'processing' WHERE id = ? AND status = 'pending'`).run(Number(r.id));
  if (!res.changes) return null;
  runningGraphJobs.add(Number(r.id));
  return getGraphJob(Number(r.id));
}
export function saveGraphProgress(id: number, result: unknown) {
  db.prepare(`UPDATE graph_jobs SET result = ? WHERE id = ?`).run(JSON.stringify(result), id);
}
export function finishGraphJob(id: number, status: GraphJob["status"], result: unknown, error: string | null = null) {
  db.prepare(`UPDATE graph_jobs SET status = ?, result = ?, error = ?, processed_at = ? WHERE id = ? AND status = 'processing'`).run(
    status, result == null ? null : JSON.stringify(result), error, now(), id,
  );
}
/** Stop a queued or running backfill before its next chunk (see cancelJob in wiki.ts). */
export function cancelGraphJob(id: number): GraphJob {
  const res = db.prepare(`UPDATE graph_jobs SET status = 'cancelled', processed_at = ? WHERE id = ? AND status IN ('pending','processing')`).run(now(), id);
  if (!res.changes) {
    if (!getGraphJob(id)) throw new HttpError(404, "job not found");
    throw new HttpError(409, "only queued or running jobs can be cancelled");
  }
  return getGraphJob(id)!;
}
export function isGraphJobCancelled(id: number): boolean {
  return getGraphJob(id)?.status === "cancelled";
}
export function retryGraphJob(id: number): GraphJob {
  const j = getGraphJob(id);
  if (!j) throw new HttpError(404, "job not found");
  if (j.status !== "error" && j.status !== "cancelled") throw new HttpError(409, "only failed or cancelled jobs can be retried");
  if (runningGraphJobs.has(id)) throw new HttpError(409, "job is still stopping; try again in a moment");
  db.prepare(`UPDATE graph_jobs SET status = 'pending', error = NULL WHERE id = ?`).run(id);
  wakeWorker?.();
  return getGraphJob(id)!;
}
