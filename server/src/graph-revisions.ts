import { db, now, type Source } from "./db.ts";

// History of memory-graph edits (links and entities) so they can be undone.
// Depends only on db.ts: entities.ts and graph.ts both record into it, and the
// revert logic lives in graph.ts.
//
// Actions:
//   link:   add | remove
//   entity: update | merge | delete          — revertible
//           unmerge | restore                — written by reverting a merge /
//                                              delete; not revertible (merge or
//                                              delete again instead)
// A write made by a revert keeps its real action and carries
// snapshot.revert_of = <reverted revision id>, so reverting a revert of a link
// add/remove or an entity update works like any other revision. The automatic
// orphan-entity prune is not a user action and is not recorded.
//
// Every snapshot carries entity_ids / entry_ids (the entities and memories it
// touches) so the list can be filtered with one SQL shape. Entities are named
// by id only; that is safe because entity ids are never reused (AUTOINCREMENT,
// schema step 8).

export type GraphRevisionTarget = "link" | "entity";
export const REVERTIBLE: Record<GraphRevisionTarget, readonly string[]> = {
  link: ["add", "remove"],
  entity: ["update", "merge", "delete"],
};

export interface GraphRevision {
  id: number;
  target: GraphRevisionTarget;
  action: string;
  snapshot: Record<string, any>;
  author: Source;
  created_at: string;
  reverted_at: string | null;
  revertible: boolean;
}

const toRevision = (r: Record<string, unknown>): GraphRevision => {
  const target = r.target as GraphRevisionTarget;
  const action = String(r.action);
  const reverted_at = r.reverted_at == null ? null : String(r.reverted_at);
  return {
    id: Number(r.id),
    target,
    action,
    snapshot: JSON.parse(String(r.snapshot)),
    author: r.author as Source,
    created_at: String(r.created_at),
    reverted_at,
    revertible: !reverted_at && REVERTIBLE[target].includes(action),
  };
};

/** Record one graph edit. Call inside the transaction that made it. */
export function recordGraphRevision(r: {
  target: GraphRevisionTarget;
  action: string;
  snapshot: Record<string, unknown> & { entity_ids: number[]; entry_ids: number[] };
  author: Source;
  revertOf?: number;
}): number {
  const snapshot = r.revertOf ? { ...r.snapshot, revert_of: r.revertOf } : r.snapshot;
  const res = db
    .prepare(`INSERT INTO graph_revisions (target, action, snapshot, author) VALUES (?, ?, ?, ?)`)
    .run(r.target, r.action, JSON.stringify(snapshot), r.author);
  return Number(res.lastInsertRowid);
}

export function getGraphRevision(id: number): GraphRevision | null {
  const r = db.prepare(`SELECT * FROM graph_revisions WHERE id = ?`).get(id);
  return r ? toRevision(r) : null;
}

/** Newest first, optionally only revisions touching an entity or a memory. */
export function listGraphRevisions(f: { limit?: number; entityId?: number; entryId?: number } = {}): GraphRevision[] {
  const where: string[] = [];
  const args: number[] = [];
  if (f.entityId) {
    where.push(`EXISTS (SELECT 1 FROM json_each(snapshot, '$.entity_ids') WHERE value = ?)`);
    args.push(f.entityId);
  }
  if (f.entryId) {
    where.push(`EXISTS (SELECT 1 FROM json_each(snapshot, '$.entry_ids') WHERE value = ?)`);
    args.push(f.entryId);
  }
  args.push(Math.max(1, Math.min(f.limit ?? 50, 500)));
  return db
    .prepare(`SELECT * FROM graph_revisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...args)
    .map(toRevision);
}

/** Mark a revision reverted. Returns false when it already was (lost a race). */
export function markGraphRevisionReverted(id: number): boolean {
  return db.prepare(`UPDATE graph_revisions SET reverted_at = ? WHERE id = ? AND reverted_at IS NULL`).run(now(), id).changes > 0;
}
