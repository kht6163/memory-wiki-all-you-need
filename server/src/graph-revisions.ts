import { db, now, type Source } from "./db.ts";

// History of memory-graph edits (links and entities) so they can be undone.
// Depends only on db.ts: entities.ts and graph.ts both record into it, and the
// revert logic lives in graph.ts. The precondition check shared by the list and
// the revert (linkRevertBlock) lives here and reads entries / entry_links.
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
  /** False when already reverted, the action is never revertible, or `blocked` is set. */
  revertible: boolean;
  /** Why a revert would fail now (the revert route throws 409 with `message`). */
  blocked: RevertBlock | null;
}

export type RevertBlockCode = "endpoint_purged" | "endpoint_replaced" | "link_exists" | "link_gone" | "link_not_retiring";
export interface RevertBlock {
  code: RevertBlockCode;
  /** The memory the code is about (endpoint_*). */
  entry_id?: number;
  /** English, the same text the revert route's 409 carries. */
  message: string;
}

/**
 * The one check the list and the revert share (G-041): would reverting this
 * link revision fail because of what happened to its link or memories since?
 * - remove: both memories must still be the ones it linked. A purged memory is
 *   gone for good (unlike a memory in the trash, which can be restored first).
 *   Its id may also have been taken by a newer memory (rowid reuse in databases
 *   from before AUTOINCREMENT): the snapshot's creation times must match, and
 *   older snapshots without them fall back to "created after the removal" (the
 *   original existed when it was removed). Never links an unrelated memory.
 *   The link must not be back already (added again since): the revert would
 *   find it and refuse. A legacy informational supersedes row (retires = 0) is
 *   no obstacle to restoring a retiring one (addLink turns it on), and a
 *   "related" link counts in either direction (stored once).
 * - add: the link must still be there (purging a memory drops its links), and
 *   a legacy link the add turned on must still be retiring.
 * Entity revisions are never blocked here.
 */
export function linkRevertBlock(target: GraphRevisionTarget, action: string, s: Record<string, any>, createdAt: string): RevertBlock | null {
  if (target !== "link") return null;
  if (action === "remove") {
    for (const end of ["from", "to"] as const) {
      const id = Number(s[`${end}_id`]);
      const e = db.prepare(`SELECT created_at FROM entries WHERE id = ?`).get(id) as { created_at: string } | undefined;
      if (!e) return { code: "endpoint_purged", entry_id: id, message: `memory #${id} was permanently deleted — this link cannot be restored` };
      const stamp = s[`${end}_created_at`];
      if (stamp ? e.created_at !== stamp : e.created_at > createdAt) {
        return {
          code: "endpoint_replaced",
          entry_id: id,
          message: `memory #${id} is now a different memory (the original was permanently deleted) — this link cannot be restored`,
        };
      }
    }
    const [from, to, type] = [Number(s.from_id), Number(s.to_id), String(s.type)];
    const informational = Number(s.retires) === 0;
    const row = db.prepare(`SELECT retires FROM entry_links WHERE from_id = ? AND to_id = ? AND type = ?`).get(from, to, type) as
      | { retires: number }
      | undefined;
    const back =
      (row && (informational || type !== "supersedes" || Number(row.retires) !== 0)) ||
      (!informational && type === "related" && db.prepare(`SELECT 1 FROM entry_links WHERE from_id = ? AND to_id = ? AND type = 'related'`).get(to, from));
    if (back) return { code: "link_exists", message: "the link already exists" };
    return null;
  }
  if (action === "add") {
    const row = db
      .prepare(`SELECT retires FROM entry_links WHERE from_id = ? AND to_id = ? AND type = ?`)
      .get(Number(s.from_id), Number(s.to_id), String(s.type)) as { retires: number } | undefined;
    if (!row) return { code: "link_gone", message: "the link no longer exists" };
    if (s.prior && Number(row.retires) === 0) return { code: "link_not_retiring", message: "the link no longer retires its target" };
  }
  return null;
}

const toRevision = (r: Record<string, unknown>): GraphRevision => {
  const target = r.target as GraphRevisionTarget;
  const action = String(r.action);
  const reverted_at = r.reverted_at == null ? null : String(r.reverted_at);
  const snapshot = JSON.parse(String(r.snapshot));
  const created_at = String(r.created_at);
  const open = !reverted_at && REVERTIBLE[target].includes(action);
  const blocked = open ? linkRevertBlock(target, action, snapshot, created_at) : null;
  return {
    id: Number(r.id),
    target,
    action,
    snapshot,
    author: r.author as Source,
    created_at,
    reverted_at,
    revertible: open && !blocked,
    blocked,
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
