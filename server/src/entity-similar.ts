import { db } from "./db.ts";
import { HttpError } from "./store.ts";

// Merge suggestions for entities that are probably the same thing under two
// names ("Postgres" / "PostgreSQL"), so people can keep one entity per thing
// (G-020). No vectors and no LLM: name trigrams plus how often two entities
// are mentioned by the same memories. Nothing changes until a person merges
// (POST /entities/:id/merge) or dismisses a pair.
//
// Score (0..1) = max(name, COOCCUR_WEIGHT · cooccur) + BOTH_BONUS · min(name, cooccur),
// capped at 1, then × KIND_PENALTY when the kinds differ (lowered, not excluded).
//   name    — 1 for equal fuzzy names; else the larger of trigram Jaccard and
//             containment (0.5 + 0.5 · shorter/longer). Fuzzy names shorter than
//             MIN_FUZZY_LEN only count when equal or a whole word of the other name
//             (0.6): a word between separators, or the leading camelCase part of
//             one ("PgBouncer" → "pg"). A bare prefix is not enough, so "pg" never
//             pairs with "upgrade" or "pgx", nor "go" with "gold".
//   cooccur — Jaccard of the two entities' live memory sets, only when they
//             share at least MIN_SHARED memories (one shared memory is noise).
// Pairs below MIN_SCORE are dropped, so a co-occurrence-only pair needs a
// Jaccard of about 0.57 (0.7 · J ≥ 0.4) even though the reason is named at 0.5.

export const COOCCUR_WEIGHT = 0.7;
export const BOTH_BONUS = 0.3;
export const KIND_PENALTY = 0.8;
export const MIN_SCORE = 0.4;
export const MIN_NAME_JACCARD = 0.5;
export const MIN_FUZZY_LEN = 4;
export const MIN_SHARED = 2;
const SHORT_TOKEN_SCORE = 0.6;
/** Trigrams carried by more entities than this ("ing", "ver") are too common to block on. */
const MAX_POSTING = 200;

export type SimilarReason = "name" | "contains" | "cooccur";

export interface SimilarEntityInput {
  id: number;
  name: string;
  kind: string;
  /** Live memories mentioning it. */
  count: number;
}
export interface SimilarSide {
  id: number;
  name: string;
  kind: string;
  count: number;
}
export interface SimilarPair {
  /** Lower id first, the same order a dismiss stores. */
  a: SimilarSide;
  b: SimilarSide;
  score: number;
  reasons: SimilarReason[];
  /** Suggested direction: merge `from` INTO `into` (the more-mentioned one; tie → lower id kept). */
  merge: { from: number; into: number };
}

/** Lowercase, letters and digits only (Hangul included): "Node.js" → "nodejs". */
export function fuzzyName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Leading camelCase part of a word: "PgBouncer" → "Pg", "HTTPServer" → "HTTP". */
const LEADING_CAMEL = /^(?:\p{Lu}?\p{Ll}+(?=\p{Lu})|\p{Lu}+(?=\p{Lu}\p{Ll}))/u;

/**
 * Whole words of a name, fuzzy-normalized ("pg bouncer" → ["pg", "bouncer"]),
 * plus each word's leading camelCase part ("PgBouncer" → ["pgbouncer", "pg"]).
 * Only the leading part, so "SQL" is not a word of "PostgreSQL".
 */
function wordsOf(name: string): string[] {
  const out: string[] = [];
  for (const w of name.normalize("NFKC").split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    out.push(w.toLowerCase());
    const head = LEADING_CAMEL.exec(w)?.[0];
    if (head) out.push(head.toLowerCase());
  }
  return out;
}

function trigrams(s: string): Set<string> {
  const chars = [...s];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(""));
  return out;
}

const pairKey = (x: number, y: number) => (x < y ? `${x}:${y}` : `${y}:${x}`);

interface Prepared extends SimilarEntityInput {
  fuzzy: string;
  len: number;
  grams: Set<string>;
  words: string[];
}

/** Name similarity of two prepared entities: score and which name reasons apply. */
function nameSimilarity(x: Prepared, y: Prepared): { score: number; reasons: SimilarReason[] } {
  if (x.len < 2 || y.len < 2) return { score: 0, reasons: [] };
  if (x.fuzzy === y.fuzzy) return { score: 1, reasons: ["name"] };
  const [short, long] = x.len <= y.len ? [x, y] : [y, x];
  if (short.len < MIN_FUZZY_LEN) {
    // Short names ("pg", "ui") are only trusted as a whole word of the other name.
    if (long.words.includes(short.fuzzy)) return { score: SHORT_TOKEN_SCORE, reasons: ["contains"] };
    return { score: 0, reasons: [] };
  }
  let shared = 0;
  for (const g of x.grams) if (y.grams.has(g)) shared++;
  const jaccard = shared / (x.grams.size + y.grams.size - shared || 1);
  const contains = long.fuzzy.includes(short.fuzzy) ? 0.5 + (0.5 * short.len) / long.len : 0;
  const reasons: SimilarReason[] = [];
  if (jaccard >= MIN_NAME_JACCARD) reasons.push("name");
  if (contains) reasons.push("contains");
  return { score: reasons.length ? Math.max(jaccard, contains) : 0, reasons };
}

/**
 * Pure core: candidate merge pairs among `entities` (each with its live mention
 * count). `shared` maps "lowId:highId" to the number of live memories both
 * mention; `dismissed` holds "lowId:highId" keys to leave out. Candidates come
 * from a trigram / whole-word / equal-name index plus the co-occurring pairs,
 * never from comparing every pair.
 */
export function findSimilarPairs(
  entities: SimilarEntityInput[],
  shared: Map<string, number>,
  dismissed: Set<string> = new Set(),
  limit = 50,
): SimilarPair[] {
  const byId = new Map<number, Prepared>();
  for (const e of entities) {
    const fuzzy = fuzzyName(e.name);
    const len = [...fuzzy].length;
    byId.set(e.id, { ...e, fuzzy, len, grams: len >= MIN_FUZZY_LEN ? trigrams(fuzzy) : new Set(), words: wordsOf(e.name) });
  }

  // Blocking: entities sharing a trigram, an equal fuzzy name, or a word (short names pair below).
  const postings = new Map<string, number[]>();
  const add = (key: string, id: number) => {
    const list = postings.get(key);
    if (list) list.push(id);
    else postings.set(key, [id]);
  };
  for (const p of byId.values()) {
    if (p.len < 2) continue;
    add(`=${p.fuzzy}`, p.id);
    for (const g of p.grams) add(`#${g}`, p.id);
    for (const w of new Set(p.words)) if (w !== p.fuzzy) add(`w${w}`, p.id);
  }
  const candidates = new Set<string>();
  for (const [key, ids] of postings) {
    if (ids.length < 2 || ids.length > MAX_POSTING) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) candidates.add(pairKey(ids[i], ids[j]));
  }
  // Short names: pair with the entities that have them as a whole word.
  for (const p of byId.values()) {
    if (p.len < 2 || p.len >= MIN_FUZZY_LEN) continue;
    const ids = postings.get(`w${p.fuzzy}`) ?? [];
    if (ids.length > MAX_POSTING) continue;
    for (const id of ids) if (id !== p.id) candidates.add(pairKey(p.id, id));
  }
  for (const [key, n] of shared) if (n >= MIN_SHARED) candidates.add(key);

  const out: SimilarPair[] = [];
  for (const key of candidates) {
    if (dismissed.has(key)) continue;
    const [ia, ib] = key.split(":").map(Number);
    const a = byId.get(ia);
    const b = byId.get(ib);
    if (!a || !b) continue;
    // A path and a same-letter name are kept apart on purpose (G-040: "k8s/" file vs "k8s").
    if ((a.kind === "file") !== (b.kind === "file") && a.fuzzy === b.fuzzy) continue;
    const name = nameSimilarity(a, b);
    const n = shared.get(key) ?? 0;
    const cooccur = n >= MIN_SHARED ? n / (a.count + b.count - n || 1) : 0;
    const reasons = [...name.reasons];
    if (cooccur >= MIN_NAME_JACCARD) reasons.push("cooccur");
    if (!reasons.length) continue;
    let score = Math.min(1, Math.max(name.score, COOCCUR_WEIGHT * cooccur) + BOTH_BONUS * Math.min(name.score, cooccur));
    if (a.kind !== b.kind) score *= KIND_PENALTY;
    if (score < MIN_SCORE) continue;
    const keepA = a.count > b.count || (a.count === b.count && a.id < b.id);
    const side = (p: Prepared): SimilarSide => ({ id: p.id, name: p.name, kind: p.kind, count: p.count });
    out.push({
      a: side(a),
      b: side(b),
      score: Math.round(score * 1000) / 1000,
      reasons,
      merge: keepA ? { from: b.id, into: a.id } : { from: a.id, into: b.id },
    });
  }
  out.sort((x, y) => y.score - x.score || x.a.id - y.a.id || x.b.id - y.b.id);
  return out.slice(0, Math.max(0, limit));
}

// ------------------------------------------------------------------- db

/** Merge suggestions over entities that at least one live memory mentions. */
export function similarEntities(limit = 50): SimilarPair[] {
  const entities = db
    .prepare(
      `SELECT n.id, n.name, n.kind, COUNT(*) AS count FROM entities n
       JOIN entry_entities ee ON ee.entity_id = n.id JOIN entries e ON e.id = ee.entry_id
       WHERE e.deleted_at IS NULL GROUP BY n.id`,
    )
    .all()
    .map((r) => ({ id: Number(r.id), name: String(r.name), kind: String(r.kind), count: Number(r.count) }));
  const shared = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT x.entity_id AS a, y.entity_id AS b, COUNT(*) AS n FROM entry_entities x
       JOIN entry_entities y ON y.entry_id = x.entry_id AND y.entity_id > x.entity_id
       JOIN entries e ON e.id = x.entry_id
       WHERE e.deleted_at IS NULL GROUP BY x.entity_id, y.entity_id HAVING n >= ?`,
    )
    .all(MIN_SHARED)) {
    shared.set(pairKey(Number(r.a), Number(r.b)), Number(r.n));
  }
  const dismissed = new Set(
    db
      .prepare(`SELECT a, b FROM entity_pair_dismissed`)
      .all()
      .map((r) => pairKey(Number(r.a), Number(r.b))),
  );
  return findSimilarPairs(entities, shared, dismissed, limit);
}

/** A person said these two are different things: stop suggesting the pair. */
export function dismissSimilarPair(x: number, y: number) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x <= 0 || y <= 0) throw new HttpError(400, "a and b must be entity ids");
  if (x === y) throw new HttpError(400, "a and b must be different entities");
  const exists = db.prepare(`SELECT 1 FROM entities WHERE id = ?`);
  if (!exists.get(x) || !exists.get(y)) throw new HttpError(404, "entity not found");
  const [a, b] = x < y ? [x, y] : [y, x];
  db.prepare(`INSERT OR IGNORE INTO entity_pair_dismissed (a, b) VALUES (?, ?)`).run(a, b);
}
