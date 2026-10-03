import { db, now, type Source } from "./db.ts";
import { entityNorm, resolveEntityId } from "./entities.ts";

// History of memory-graph edits (links and entities) so they can be undone.
// Depends only on db.ts and entities.ts: graph.ts records into it, and the
// revert logic lives in graph.ts. The precondition checks shared by the list and
// the revert (revertBlock, and addLink's supersedesBlock) live here and read
// entries / entry_links / entities / entity_aliases with plain SQL.
//
// Actions:
//   link:   add | remove
//   entity: update | merge | delete | unmerge | restore
//           unmerge / restore are written by reverting a merge / delete;
//           reverting them merges / deletes again (recorded as a new merge /
//           delete), so every action is revertible.
// A write made by a revert keeps its real action and carries
// snapshot.revert_of = <reverted revision id>, so reverting a revert works like
// any other revision. The automatic orphan-entity prune (entities.ts) is
// recorded as a "delete" with snapshot.reason = "orphan" when the entity had
// aliases or dismissed pairs; a bare orphan is not recorded. Creating an entity
// is not recorded: it carries nothing a mention of the name would not re-create.
//
// Every snapshot carries entity_ids / entry_ids (the entities and memories it
// touches) so the list can be filtered with one SQL shape. Entities are named
// by id only; that is safe because entity ids are never reused (AUTOINCREMENT,
// schema step 8).

export type GraphRevisionTarget = "link" | "entity";
export const REVERTIBLE: Record<GraphRevisionTarget, readonly string[]> = {
  link: ["add", "remove"],
  entity: ["update", "merge", "delete", "unmerge", "restore"],
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
  /** Why a revert would fail now (the revert route throws `status` (default 409) with `message`). */
  blocked: RevertBlock | null;
}

/** addLink's 404 for a missing or trashed end, shared with endpoint_trashed (G-041). */
export const MEMORIES_MISSING = "both memories must exist";
/** The entity routes' 404, shared with entity_gone (G-041). */
export const ENTITY_NOT_FOUND = "entity not found";

export type RevertBlockCode =
  | "endpoint_purged"
  | "endpoint_replaced"
  | "endpoint_trashed"
  | "link_exists"
  | "link_gone"
  | "link_not_retiring"
  | "supersedes_cycle"
  | "cross_project"
  | "name_taken"
  | "name_moved"
  | "merge_target_gone"
  | "nothing_to_revert"
  | "entity_gone";
export interface RevertBlock {
  code: RevertBlockCode;
  /** The memory the code is about (endpoint_*). */
  entry_id?: number;
  /** The entity the code is about (name_taken / name_moved: the owner now; merge_target_gone: the target; entity_gone: the gone one). */
  entity_id?: number;
  /** HTTP status the revert answers with (default 409; cross_project keeps addLink's 400; endpoint_trashed / entity_gone 404). */
  status?: number;
  /** English, the same text the revert route's error carries. */
  message: string;
}

/**
 * addLink's checks for a retiring "supersedes" link (G-026), shared with the
 * revision list so a link-remove revert that addLink would refuse is shown as
 * blocked: a project memory may only retire memories of its own project (400),
 * and the link must not close a cycle of retiring links (409). Only retiring
 * links count in the walk: a pre-v0.6 informational one (retires = 0) retires nothing.
 */
export function supersedesBlock(fromId: number, toId: number): RevertBlock | null {
  const end = db.prepare(`SELECT scope, project_id FROM entries WHERE id = ?`);
  const a = end.get(fromId) as { scope: string; project_id: number | null } | undefined;
  const b = end.get(toId) as { scope: string; project_id: number | null } | undefined;
  // The replacement hides the old memory, so it must be visible wherever the old one is.
  if (a && b && a.scope === "project" && a.project_id !== b.project_id) {
    return { code: "cross_project", status: 400, message: "a project memory can only supersede memories of the same project" };
  }
  // A cycle (A supersedes B, B supersedes A) would retire both.
  const next = db.prepare(`SELECT to_id FROM entry_links WHERE from_id = ? AND type = 'supersedes' AND retires = 1`);
  const seen = new Set<number>([toId]);
  let frontier = [toId];
  for (let depth = 0; frontier.length && depth < 50; depth++) {
    const step: number[] = [];
    for (const id of frontier) {
      for (const r of next.all(id)) {
        const t = Number(r.to_id);
        if (t === fromId) return { code: "supersedes_cycle", message: `#${toId} already supersedes #${fromId} (directly or through others)` };
        if (!seen.has(t)) {
          seen.add(t);
          step.push(t);
        }
      }
    }
    frontier = step;
  }
  return null;
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
 *   Purged / replaced is checked on both ends before the trash, so a link with
 *   one end purged is never shown as "restore from the trash first".
 *   A memory in the trash blocks it with the 404 the revert answers
 *   (addLink / restoreInformationalLink check the trash before anything else):
 *   endpoint_trashed — restore the memory from the trash, and it is revertible again.
 *   The link must not be back already (added again since): the revert would
 *   find it and refuse. A legacy informational supersedes row (retires = 0) is
 *   no obstacle to restoring a retiring one (addLink turns it on), and a
 *   "related" link counts in either direction (stored once).
 *   A retiring link is put back with addLink, so its supersedes checks apply
 *   too (supersedesBlock).
 * - add: the link must still be there (purging a memory drops its links), and
 *   a legacy link the add turned on must still be retiring.
 * Entity revisions are checked by entityRevertBlock.
 */
export function linkRevertBlock(target: GraphRevisionTarget, action: string, s: Record<string, any>, createdAt: string): RevertBlock | null {
  if (target !== "link") return null;
  if (action === "remove") {
    const ends = (["from", "to"] as const).map((end) => {
      const id = Number(s[`${end}_id`]);
      const e = db.prepare(`SELECT created_at, deleted_at FROM entries WHERE id = ?`).get(id) as
        | { created_at: string; deleted_at: string | null }
        | undefined;
      return { end, id, e };
    });
    for (const { end, id, e } of ends) {
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
    // Same 404 as addLink / restoreInformationalLink (their first check).
    for (const { id, e } of ends) {
      if (e?.deleted_at) return { code: "endpoint_trashed", entry_id: id, status: 404, message: MEMORIES_MISSING };
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
    if (!informational && type === "supersedes") return supersedesBlock(from, to);
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

/** What reverting an entity update would change, worked out before writing anything. */
export interface EntityUpdatePlan {
  /** Alias norms of the entity to drop (the ones the update added, and the old name's). */
  remove: string[];
  /** Alias norms to give the entity (the ones the update removed, and the current name if it came from a later rename). */
  add: string[];
  block: RevertBlock | null;
}

/**
 * Plan for reverting an entity update (snapshot `s`); null when the entity is
 * gone (deleted or merged away — the revert answers 404, restore it first).
 * The revert carries out exactly this plan, so the list's "nothing to revert"
 * and the revert's agree (G-041):
 * - the old name must not be another entity's name or alias now (G-020);
 * - drop the aliases the update added and the old name's alias, if still the entity's;
 * - bring back the aliases it removed unless that norm is an entity name, the
 *   old name, or another alias now;
 * - keep the current name as an alias only if it came from a later rename;
 * - nothing to change (already back at the old values) → nothing_to_revert, so
 *   no no-op revision is recorded (G-034).
 */
export function planEntityUpdateRevert(s: Record<string, any>): EntityUpdatePlan | null {
  const id = Number(s.entity_id);
  const cur = db.prepare(`SELECT name, kind, description FROM entities WHERE id = ?`).get(id) as
    | { name: string; kind: string; description: string | null }
    | undefined;
  if (!cur) return null;
  const before = s.before as { name: string; kind: string; description: string };
  const norm = entityNorm(before.name);
  const other = resolveEntityId(before.name);
  if (other && other !== id) {
    return { remove: [], add: [], block: { code: "name_taken", entity_id: other, message: `"${before.name}" is now entity #${other} — merge instead` } };
  }
  const aliasOwner = db.prepare(`SELECT entity_id FROM entity_aliases WHERE norm = ?`);
  const ownedBy = (n: string) => (aliasOwner.get(n) as { entity_id: number } | undefined)?.entity_id;
  const remove = [...new Set([...((s.aliases_added as string[]) ?? []), norm])].filter((n) => Number(ownedBy(n)) === id);
  const add: string[] = [];
  const free = (n: string) => !add.includes(n) && (ownedBy(n) === undefined || remove.includes(n));
  const isName = db.prepare(`SELECT 1 FROM entities WHERE norm = ?`);
  for (const a of (s.aliases_removed as string[]) ?? []) if (a !== norm && !isName.get(a) && free(a)) add.push(a);
  const curNorm = entityNorm(cur.name);
  if (curNorm !== norm && curNorm !== entityNorm(String(s.after?.name ?? "")) && free(curNorm)) add.push(curNorm);
  const same = cur.name === before.name && cur.kind === before.kind && String(cur.description ?? "") === before.description;
  const block: RevertBlock | null =
    same && !add.length && !remove.length ? { code: "nothing_to_revert", message: "nothing to revert: the entity already has these values" } : null;
  return { remove, add, block };
}

/**
 * Bringing back a merged-away or deleted entity (`row` = its entities row): its
 * name must be free both as a name and as an alias (G-020). A merge revert drops
 * the target's alias of that name first, so it passes `aliasOf` = the target.
 */
export function recreateBlock(row: Record<string, any>, aliasOf?: number): RevertBlock | null {
  const norm = String(row.norm);
  const alias = db.prepare(`SELECT entity_id AS id FROM entity_aliases WHERE norm = ?`).get(norm) as { id: number } | undefined;
  const owner =
    (db.prepare(`SELECT id FROM entities WHERE norm = ?`).get(norm) as { id: number } | undefined) ??
    (alias && Number(alias.id) !== aliasOf ? alias : undefined);
  if (!owner) return null;
  return { code: "name_taken", entity_id: Number(owner.id), message: `"${row.name}" is now entity #${owner.id} — merge instead` };
}

/**
 * The entity side of the shared check (G-041), in the order the revert runs it.
 * - update: the entity must still exist (deleted or merged away → entity_gone,
 *   the revert's 404; revert that delete / merge first and it is revertible
 *   again — entity ids are never reused), then planEntityUpdateRevert (name
 *   taken, nothing to revert).
 * - merge: the target must still exist (its aliases, the merged-away name's
 *   included, would otherwise be lost — restore it first); the merged-away name
 *   must still point at the target or nowhere; no entity may carry that name.
 * - delete: the name must be free (recreateBlock).
 * - restore (a delete revert): the entity must still exist (entity_gone); the
 *   revert deletes it again like deleteEntity.
 * - unmerge (a merge revert): the entity must still exist (entity_gone), then the
 *   target (merge_target_gone); the revert merges it again like mergeEntities.
 * A merge or delete revert recreates the gone entity, so "gone" is its normal state there, not a block.
 */
export function entityRevertBlock(action: string, s: Record<string, any>): RevertBlock | null {
  if (action === "update") {
    const plan = planEntityUpdateRevert(s);
    if (!plan) return { code: "entity_gone", entity_id: Number(s.entity_id), status: 404, message: ENTITY_NOT_FOUND };
    return plan.block;
  }
  if (action === "merge") {
    const intoId = Number(s.into_id);
    if (!db.prepare(`SELECT 1 FROM entities WHERE id = ?`).get(intoId)) {
      return { code: "merge_target_gone", entity_id: intoId, message: `the merge target #${intoId} no longer exists — restore the target first` };
    }
    const aliasOwner = db.prepare(`SELECT entity_id FROM entity_aliases WHERE norm = ?`).get(String(s.name_alias)) as { entity_id: number } | undefined;
    if (aliasOwner && Number(aliasOwner.entity_id) !== intoId) {
      return {
        code: "name_moved",
        entity_id: Number(aliasOwner.entity_id),
        message: `"${s.entity.name}" now resolves to entity #${aliasOwner.entity_id} — revert that change first`,
      };
    }
    return recreateBlock(s.entity, intoId);
  }
  if (action === "delete") return recreateBlock(s.entity);
  if (action === "restore" || action === "unmerge") {
    const exists = db.prepare(`SELECT 1 FROM entities WHERE id = ?`);
    const id = Number(s.entity_id);
    if (!exists.get(id)) return { code: "entity_gone", entity_id: id, status: 404, message: ENTITY_NOT_FOUND };
    const intoId = Number(s.into_id);
    if (action === "unmerge" && !exists.get(intoId)) {
      return { code: "merge_target_gone", entity_id: intoId, message: `the merge target #${intoId} no longer exists — restore the target first` };
    }
  }
  return null;
}

/** Why reverting this (open, revertible-kind) revision would fail now, or null. */
export function revertBlock(target: GraphRevisionTarget, action: string, s: Record<string, any>, createdAt: string): RevertBlock | null {
  return target === "link" ? linkRevertBlock(target, action, s, createdAt) : entityRevertBlock(action, s);
}

const toRevision = (r: Record<string, unknown>): GraphRevision => {
  const target = r.target as GraphRevisionTarget;
  const action = String(r.action);
  const reverted_at = r.reverted_at == null ? null : String(r.reverted_at);
  const snapshot = JSON.parse(String(r.snapshot));
  const created_at = String(r.created_at);
  const open = !reverted_at && REVERTIBLE[target].includes(action);
  const blocked = open ? revertBlock(target, action, snapshot, created_at) : null;
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
