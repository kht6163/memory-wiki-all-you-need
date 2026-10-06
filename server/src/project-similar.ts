import { db } from "./db.ts";
import { HttpError } from "./store.ts";

// Merge suggestions for projects that are probably one project split by a git
// origin change (G-007: the key is the normalized origin, so renaming,
// transferring or first adding an origin starts a new project). Deterministic,
// suggest-only (ADR-0030): nothing changes until a person merges through the
// usual preview + typed-name dialog (ADR-0029) or dismisses the pair.
//
// Signals:
//   folder   — both projects have turns from the same client (hostname) with
//              the same cwd. Equality, not a path prefix: a nested repo or a
//              dotfiles repo under $HOME would share prefixes.
//   local    — one key is local/<x> (no origin) and the other key ends in /<x>:
//              the "origin added later" split.
//   name     — same name or same last key segment, both keys with an origin.
//              A fork or another owner's repo of the same name looks exactly
//              like this, so it never suggests a pair on its own.
//   entities — Jaccard of the entity sets of the two projects' live memories,
//              counted from MIN_SHARED_ENTITIES shared entities.
// A pair is suggested when: folder, or local, or name + entities, or strong
// entities alone (J ≥ STRONG_ENTITY_JACCARD with ≥ STRONG_SHARED_ENTITIES
// shared — a repo renamed on disk and on the host at once). The score only
// orders suggestions. These thresholds were set without real data; re-tune
// them once there are real projects (roadmap).

export const MIN_SHARED_ENTITIES = 3;
export const MIN_ENTITY_JACCARD = 0.2;
export const STRONG_SHARED_ENTITIES = 5;
export const STRONG_ENTITY_JACCARD = 0.5;

export type ProjectSimilarReason = "folder" | "local" | "name" | "entities";

export interface SimilarProjectInput {
  id: number;
  key: string;
  name: string;
  last_seen_at: string | null;
  created_at: string;
  entry_count: number;
  /** `client\u0000cwd` of its turns. */
  folders: Set<string>;
  /** Entities its live memories mention. */
  entities: Set<number>;
}
export interface SimilarProjectSide {
  id: number;
  key: string;
  name: string;
  last_seen_at: string | null;
  entry_count: number;
}
export interface SimilarProjectPair {
  /** Lower id first, the same order a dismiss stores. */
  a: SimilarProjectSide;
  b: SimilarProjectSide;
  score: number;
  reasons: ProjectSimilarReason[];
  /** Entities both projects' memories mention. */
  shared_entities: number;
  /** Suggested direction: merge `from` INTO `into` — the one seen most recently keeps its key. */
  merge: { from: number; into: number };
}

const pairKey = (x: number, y: number) => (x < y ? `${x}:${y}` : `${y}:${x}`);
const tail = (key: string) => key.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
const isLocal = (key: string) => key.startsWith("local/");
const seen = (p: SimilarProjectInput) => p.last_seen_at ?? p.created_at;

/** Keys the clients give a folder outside git (home/<user>[/path], path/<path>). */
const isFolderKey = (key: string) => key.startsWith("home/") || key.startsWith("path/");

function side(p: SimilarProjectInput): SimilarProjectSide {
  return { id: p.id, key: p.key, name: p.name, last_seen_at: p.last_seen_at, entry_count: p.entry_count };
}

/** Pure core (tests call it directly). */
export function findSimilarProjects(projects: SimilarProjectInput[], dismissed = new Set<string>(), limit = 50): SimilarProjectPair[] {
  const out: SimilarProjectPair[] = [];
  const sorted = [...projects].sort((x, y) => x.id - y.id);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (dismissed.has(pairKey(a.id, b.id))) continue;
      const folder = [...a.folders].some((f) => b.folders.has(f));
      const ta = tail(a.key);
      const tb = tail(b.key);
      // A folder project outside git (home/…, path/…; ADR-0044) is named after a folder, not a
      // repo: a shared last segment says nothing (docs, test, app…). Same folder or entities still count.
      const folderKeys = isFolderKey(a.key) || isFolderKey(b.key);
      const local = !folderKeys && Boolean(ta) && ta === tb && isLocal(a.key) !== isLocal(b.key);
      const name = !local && !folderKeys && !isLocal(a.key) && !isLocal(b.key) && (a.name.toLowerCase() === b.name.toLowerCase() || (Boolean(ta) && ta === tb));
      let shared = 0;
      const [small, big] = a.entities.size <= b.entities.size ? [a.entities, b.entities] : [b.entities, a.entities];
      for (const e of small) if (big.has(e)) shared++;
      const union = a.entities.size + b.entities.size - shared;
      const jaccard = shared >= MIN_SHARED_ENTITIES && union ? shared / union : 0;
      const entities = jaccard >= MIN_ENTITY_JACCARD;
      const strong = shared >= STRONG_SHARED_ENTITIES && jaccard >= STRONG_ENTITY_JACCARD;
      if (!(folder || local || (name && entities) || strong)) continue;
      const reasons: ProjectSimilarReason[] = [];
      if (folder) reasons.push("folder");
      if (local) reasons.push("local");
      if (name) reasons.push("name");
      if (entities) reasons.push("entities");
      const score = Math.min(1, (folder ? 0.6 : 0) + (local ? 0.5 : name ? 0.3 : 0) + 0.5 * jaccard);
      // The project seen last is the live one: it keeps its key, the other key becomes its alias.
      const into = seen(a) > seen(b) ? a : b; // tie → the newer project (higher id)
      const from = into === a ? b : a;
      out.push({
        a: side(a),
        b: side(b),
        score: Math.round(score * 1000) / 1000,
        reasons,
        shared_entities: shared,
        merge: { from: from.id, into: into.id },
      });
    }
  }
  out.sort((x, y) => y.score - x.score || x.a.id - y.a.id || x.b.id - y.b.id);
  return out.slice(0, Math.max(0, limit));
}

// ------------------------------------------------------------------- db

/** Merge suggestions over all projects. */
export function similarProjects(limit = 50): SimilarProjectPair[] {
  const projects = new Map<number, SimilarProjectInput>();
  for (const r of db
    .prepare(
      `SELECT p.id, p.key, p.name, p.last_seen_at, p.created_at,
         (SELECT COUNT(*) FROM entries e WHERE e.project_id = p.id AND e.deleted_at IS NULL) AS entry_count
       FROM projects p`,
    )
    .all()) {
    projects.set(Number(r.id), {
      id: Number(r.id),
      key: String(r.key),
      name: String(r.name),
      last_seen_at: r.last_seen_at == null ? null : String(r.last_seen_at),
      created_at: String(r.created_at),
      entry_count: Number(r.entry_count),
      folders: new Set(),
      entities: new Set(),
    });
  }
  for (const r of db
    .prepare(
      `SELECT DISTINCT project_id, client, cwd FROM turns
       WHERE project_id IS NOT NULL AND IFNULL(client, '') != '' AND IFNULL(cwd, '') != ''`,
    )
    .all()) {
    projects.get(Number(r.project_id))?.folders.add(`${r.client}\u0000${r.cwd}`);
  }
  for (const r of db
    .prepare(
      `SELECT DISTINCT e.project_id, ee.entity_id FROM entry_entities ee JOIN entries e ON e.id = ee.entry_id
       WHERE e.project_id IS NOT NULL AND e.deleted_at IS NULL`,
    )
    .all()) {
    projects.get(Number(r.project_id))?.entities.add(Number(r.entity_id));
  }
  const dismissed = new Set(
    db
      .prepare(`SELECT a, b FROM project_pair_dismissed`)
      .all()
      .map((r) => pairKey(Number(r.a), Number(r.b))),
  );
  return findSimilarProjects([...projects.values()], dismissed, limit);
}

/** A person said these two are different projects: stop suggesting the pair. */
export function dismissSimilarProjects(x: number, y: number) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x <= 0 || y <= 0) throw new HttpError(400, "a and b must be project ids");
  if (x === y) throw new HttpError(400, "a and b must be different projects");
  const exists = db.prepare(`SELECT 1 FROM projects WHERE id = ?`);
  if (!exists.get(x) || !exists.get(y)) throw new HttpError(404, "project not found");
  const [a, b] = x < y ? [x, y] : [y, x];
  db.prepare(`INSERT OR IGNORE INTO project_pair_dismissed (a, b) VALUES (?, ?)`).run(a, b);
}
