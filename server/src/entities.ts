import { db, now } from "./db.ts";

// Entity storage for the memory graph. Depends only on db.ts so store.ts can
// attach entities inside its own transactions (graph.ts builds on this).

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

/** Replace (or extend) a memory's entities. Returns whether anything changed. Call inside a transaction. */
export function writeEntryEntities(entryId: number, ids: number[], mode: "replace" | "add" = "replace"): boolean {
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
  if (removed.length) pruneOrphanEntities(removed);
  return true;
}

/** Entities nobody mentions any more and nobody described are dropped so the list stays clean. */
export function pruneOrphanEntities(ids: number[]) {
  const del = db.prepare(
    `DELETE FROM entities WHERE id = ? AND description = '' AND NOT EXISTS (SELECT 1 FROM entry_entities WHERE entity_id = ?)`,
  );
  let n = 0;
  for (const id of ids) n += Number(del.run(id, id).changes);
  if (n) entitiesVersion++;
}

export function touchEntity(id: number) {
  db.prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`).run(now(), id);
}

/** Drop every orphan entity (after cascading deletes: project removal, purge). */
export function pruneAllOrphanEntities() {
  const res = db.prepare(`DELETE FROM entities WHERE description = '' AND NOT EXISTS (SELECT 1 FROM entry_entities ee WHERE ee.entity_id = entities.id)`).run();
  if (res.changes) entitiesVersion++;
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
