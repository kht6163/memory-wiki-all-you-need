import { db, now, transaction, type Source } from "./db.ts";

// Entity storage for the memory graph. Depends only on db.ts so store.ts can
// attach entities inside its own transactions (graph.ts builds on this). The
// orphan prune writes its graph_revisions row itself, with plain SQL.

export const ENTITY_KINDS = ["tech", "service", "tool", "file", "concept", "person"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export type EntityInput = string | { name: string; kind?: string };

export const MAX_ENTITIES_PER_ENTRY = 12;

/** Bumped whenever entities are created or pruned, so graph.ts can refresh its name cache. */
export let entitiesVersion = 0;

const VERSION_SUFFIX = /\s+v?\d+(?:\.\d+)*[a-z]?$/i;

/** Display form: trimmed, single spaces, no trailing version ("PostgreSQL 16" → "PostgreSQL"). */
export function entityDisplayName(name: string): string {
  const s = name.normalize("NFKC").replace(/\s+/g, " ").trim();
  const stripped = s.replace(VERSION_SUFFIX, "");
  return (stripped || s).slice(0, 60);
}

/**
 * Matching key: display form, lowercased, without spaces, dots, dashes or
 * underscores. Slashes are kept (repeats collapsed, a leading "./" dropped) so
 * a path ("k8s/") and a name ("k8s") stay apart, while "src / api" is still
 * "src/api". A trailing "/" counts only on a one-part path: "src/api/" is
 * "src/api". Persisted in entities.norm and entity_aliases.norm: changing the
 * rule needs a migration step that recomputes them (schema.ts, step 10, whose
 * frozen copy entityNormV10 must match this).
 */
export function entityNorm(name: string): string {
  const norm = entityDisplayName(name)
    .toLowerCase()
    .replace(/^\.\//, "")
    .replace(/[\s._\-]+/g, "")
    .replace(/\/+/g, "/");
  return /.\/.+\/$/.test(norm) ? norm.slice(0, -1) : norm;
}

const kindOf = (k: unknown): EntityKind => ((ENTITY_KINDS as readonly string[]).includes(String(k)) ? (k as EntityKind) : "concept");

export function resolveEntityId(name: string): number | null {
  const norm = entityNorm(name);
  if (!norm) return null;
  const r =
    db.prepare(`SELECT id FROM entities WHERE norm = ?`).get(norm) ??
    db.prepare(`SELECT entity_id AS id FROM entity_aliases WHERE norm = ?`).get(norm);
  return r ? Number(r.id) : null;
}

/** Find or create the entity for a name. A specific kind replaces the default "concept". */
export function upsertEntity(input: EntityInput): number | null {
  const name = entityDisplayName(typeof input === "string" ? input : String(input?.name ?? ""));
  const norm = entityNorm(name);
  if (!norm || norm.length < 2) return null;
  const kind = kindOf(typeof input === "string" ? undefined : input.kind);
  const id = resolveEntityId(name);
  if (id) {
    if (kind !== "concept") db.prepare(`UPDATE entities SET kind = ? WHERE id = ? AND kind = 'concept'`).run(kind, id);
    return id;
  }
  const res = db.prepare(`INSERT INTO entities (name, norm, kind) VALUES (?, ?, ?)`).run(name, norm, kind);
  entitiesVersion++;
  return Number(res.lastInsertRowid);
}

export function entityNamesOf(entryId: number): string[] {
  return db
    .prepare(`SELECT n.name FROM entry_entities ee JOIN entities n ON n.id = ee.entity_id WHERE ee.entry_id = ? ORDER BY n.name COLLATE NOCASE`)
    .all(entryId)
    .map((r) => String(r.name));
}

/** Entity ids an input list resolves to (deduplicated, capped). */
export function resolveEntityInputs(inputs: EntityInput[]): number[] {
  const ids: number[] = [];
  for (const i of inputs) {
    const id = upsertEntity(i);
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_ENTITIES_PER_ENTRY) break;
  }
  return ids;
}

/**
 * Replace (or extend) a memory's entities. Returns whether anything changed. Call inside a transaction.
 * `author` is who made the change, recorded on the history of an entity this prunes (pruneOrphanEntities).
 */
export function writeEntryEntities(entryId: number, ids: number[], mode: "replace" | "add" = "replace", author: Source = "llm"): boolean {
  const cur = new Set(
    db
      .prepare(`SELECT entity_id FROM entry_entities WHERE entry_id = ?`)
      .all(entryId)
      .map((r) => Number(r.entity_id)),
  );
  const merged = mode === "add" ? [...new Set([...cur, ...ids])] : ids;
  const next = new Set(merged.slice(0, Math.max(MAX_ENTITIES_PER_ENTRY, mode === "add" ? cur.size : 0)));
  const removed = [...cur].filter((id) => !next.has(id));
  const added = [...next].filter((id) => !cur.has(id));
  if (!removed.length && !added.length) return false;
  const del = db.prepare(`DELETE FROM entry_entities WHERE entry_id = ? AND entity_id = ?`);
  for (const id of removed) del.run(entryId, id);
  const ins = db.prepare(`INSERT OR IGNORE INTO entry_entities (entry_id, entity_id) VALUES (?, ?)`);
  for (const id of added) ins.run(entryId, id);
  if (removed.length) pruneOrphanEntities(removed, author);
  return true;
}

/**
 * Drop one entity if it is an orphan (no mention, no description). When it carries
 * something re-creating it by name would not bring back — aliases (old spellings
 * from a rename or merge) or "not the same" pairs — the prune is recorded in the
 * same transaction as an entity "delete" with snapshot.reason = "orphan", so it is
 * listed and reverted like a delete (graph-revisions.ts, G-034). A bare orphan is
 * not recorded: the LLM creates and drops those every few turns, and its next
 * mention of the name re-creates an equivalent entity. Returns whether it was dropped.
 */
function pruneOrphan(id: number, author: Source): boolean {
  const row = db
    .prepare(
      `SELECT id, name, norm, kind, description, created_at, updated_at FROM entities
       WHERE id = ? AND description = '' AND NOT EXISTS (SELECT 1 FROM entry_entities WHERE entity_id = ?)`,
    )
    .get(id, id);
  if (!row) return false;
  const aliases = db.prepare(`SELECT norm FROM entity_aliases WHERE entity_id = ? ORDER BY norm`).all(id).map((r) => String(r.norm));
  const dismissed = db
    .prepare(`SELECT CASE WHEN a = ? THEN b ELSE a END AS other FROM entity_pair_dismissed WHERE a = ? OR b = ?`)
    .all(id, id, id)
    .map((r) => Number(r.other));
  db.prepare(`DELETE FROM entities WHERE id = ?`).run(id);
  if (aliases.length || dismissed.length) {
    // Same row shape as recordGraphRevision / deleteEntity's snapshot (graph.ts); written
    // here because graph-revisions.ts depends on this module, not the other way round.
    const snapshot = { entity_id: id, entity: { ...row }, aliases, entries: [], dismissed, reason: "orphan", entity_ids: [id], entry_ids: [] };
    db.prepare(`INSERT INTO graph_revisions (target, action, snapshot, author) VALUES ('entity', 'delete', ?, ?)`).run(JSON.stringify(snapshot), author);
  }
  return true;
}

/** Entities nobody mentions any more and nobody described are dropped so the list stays clean. Call inside a transaction. */
export function pruneOrphanEntities(ids: number[], author: Source = "llm") {
  let n = 0;
  for (const id of ids) if (pruneOrphan(id, author)) n++;
  if (n) entitiesVersion++;
}

export function touchEntity(id: number) {
  db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(now(), id);
}

/**
 * Drop every orphan entity (after cascading deletes: project removal, purge). Recorded
 * like pruneOrphanEntities, so an orphan restored by a revert (it has its aliases back
 * but no mention) is never dropped without a trace.
 */
export function pruneAllOrphanEntities(author: Source = "human") {
  const ids = db
    .prepare(`SELECT id FROM entities WHERE description = '' AND NOT EXISTS (SELECT 1 FROM entry_entities ee WHERE ee.entity_id = entities.id)`)
    .all()
    .map((r) => Number(r.id));
  if (!ids.length) return;
  transaction(() => pruneOrphanEntities(ids, author));
}

/**
 * Entity names a body edit stops mentioning: written (case-insensitively) in one of
 * the removed passages and nowhere in the text after the edit. An edit may drop
 * only these; any other current entity stays (a one-line change must not rewrite
 * the whole list). Pure: names are display names, texts are compared as written.
 */
export function entitiesDroppedByEdit(names: string[], removed: string[], after: string): string[] {
  const gone = removed.join("\n").normalize("NFKC").toLowerCase();
  const kept = after.normalize("NFKC").toLowerCase();
  return names.filter((n) => {
    const k = entityDisplayName(n).toLowerCase();
    return k.length >= 2 && gone.includes(k) && !kept.includes(k);
  });
}

/**
 * entitiesDroppedByEdit over a memory's current entities, minus any the text after
 * the edit still names by an alias (an old name kept on rename/merge). `after` is the
 * title and body after the edit. Turn curation and review both use this, so one
 * edit drops the same entities on either path (G-046, G-049).
 */
export function entryEntitiesDroppedByEdit(entryId: number, removed: string[], after: string): string[] {
  const compact = after.normalize("NFKC").toLowerCase().replace(/[\s._-]+/g, "");
  const aliases = db.prepare(
    `SELECT a.norm FROM entry_entities ee JOIN entities n ON n.id = ee.entity_id JOIN entity_aliases a ON a.entity_id = n.id WHERE ee.entry_id = ? AND n.name = ?`,
  );
  return entitiesDroppedByEdit(entityNamesOf(entryId), removed, after).filter(
    (n) => !aliases.all(entryId, n).some((a) => String(a.norm).length >= 2 && compact.includes(String(a.norm))),
  );
}
