import { config } from "./config.ts";
import { db, rowToEntry, type Entry, type Scope } from "./db.ts";
import { nearest, type SimStats } from "./embeddings.ts";
import { ACTIVE_SQL, NOT_SUPERSEDED_SQL } from "./store.ts";
import { splitWords, STOPWORDS } from "./words.ts";

// Search over a trigram FTS index. Trigram cannot match terms shorter than
// three characters, which is common in Korean ("포트", "설정"), so short terms
// fall back to LIKE. Korean words also carry trailing particles ("포트를"), so
// each Hangul term is also tried with its last one or two syllables dropped.
// FTS/LIKE only gather candidates; scoring then matches short Latin/digit words (1–3
// characters) as whole words only (G-078): "pr" must not score inside "HAProxy", nor "do"
// inside "docker". Longer ones still match inside words ("gres" → PostgreSQL).

const HANGUL = /[가-힣]/;
/** Latin/digit-only query words; shorter than TOKEN_SUBSTRING_MIN they match whole words only (a dotted "0.9" still matches inside "0.9.9"). */
const TOKEN_TERM = /^[\p{Script=Latin}\p{N}]+$/u;
const TOKEN_SUBSTRING_MIN = 4;
const SCRIPT_BOUNDARY = /(?<=[가-힣])(?=[^가-힣])|(?<=[^가-힣])(?=[가-힣])/u;

/**
 * Each word of a text with the forms a short query word may match whole: the word, its
 * parts around . _ - / ("api/context" → "api", "context"), the runs on either side of a
 * Hangul boundary ("테스트db는" → "db", "pm2를" → "pm2") and a Latin plural without its s
 * ("apis" → "api").
 */
export function wordForms(text: string): string[][] {
  return splitWords(text).map((w) => {
    const forms = new Set<string>();
    const add = (t: string) => {
      if (!t) return;
      forms.add(t);
      if (/^[a-z]{2,}[a-rt-z]s$/.test(t)) forms.add(t.slice(0, -1));
    };
    for (const part of new Set([w, ...w.split(/[._\-/]+/)])) {
      add(part);
      const runs = part.split(SCRIPT_BOUNDARY);
      if (runs.length > 1) runs.forEach(add);
    }
    return [...forms];
  });
}

/** A field as scoring reads it: lower-cased text, word forms built on first use. */
class Field {
  lower: string;
  words: string[][] | null = null;
  constructor(text: string) {
    this.lower = text.toLowerCase();
  }
}

/** How often query word `v` occurs in a field: as a whole word for a short Latin/digit word, inside words otherwise. */
function occurrences(f: Field, v: string): number {
  if (v.length >= TOKEN_SUBSTRING_MIN || !TOKEN_TERM.test(v)) return f.lower.split(v).length - 1;
  if (!f.lower.includes(v)) return 0;
  f.words ??= wordForms(f.lower);
  return f.words.filter((forms) => forms.includes(v)).length;
}

/**
 * Live, current memories, for recall's common-word gate. Rebuilt when memories, retiring
 * links or the date (expiry) change; per scope, which docs a search sees and each word's count.
 */
let corpus: {
  key: string;
  docs: { field: Field; scope: string; projectId: number | null }[];
  visible: Map<string, Field[]>;
  df: Map<string, number>;
} | null = null;

function currentCorpus(): NonNullable<typeof corpus> {
  const r = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM entries) AS n, (SELECT MAX(updated_at) FROM entries) AS u, (SELECT MAX(id) FROM entries) AS m,
              (SELECT COUNT(*) || ':' || IFNULL(MAX(rowid), 0) || ':' || IFNULL(SUM(retires), 0) FROM entry_links WHERE type = 'supersedes') AS l, date('now') AS d`,
    )
    .get() as Record<string, unknown>;
  const key = `${r.n}|${r.u}|${r.m}|${r.l}|${r.d}`;
  if (corpus?.key !== key) {
    const docs = db
      .prepare(`SELECT e.* FROM entries e WHERE e.deleted_at IS NULL AND ${ACTIVE_SQL("e")}`)
      .all()
      .map((row) => {
        const e = rowToEntry(row);
        return { field: new Field(`${e.title}\n${e.body}\n${e.tags.join(" ")}\n${e.keywords.join(" ")}`), scope: e.scope, projectId: e.project_id };
      });
    corpus = { key, docs, visible: new Map(), df: new Map() };
  }
  return corpus;
}

/**
 * The common-word test for one search (recall's gate): a word in more than
 * max(COMMON_MIN_DF, ratio × N) of the live, current memories the search can see (global,
 * user and this project, or every project). Reads the corpus key once; each word is
 * counted once per corpus and scope.
 */
export function commonWords(ratio: number, projectId: number | null, allProjects = false): (v: string) => boolean {
  if (ratio >= 1) return () => false;
  const c = currentCorpus();
  const scopeKey = allProjects ? "*" : String(projectId ?? -1);
  let docs = c.visible.get(scopeKey);
  if (!docs) {
    docs = (allProjects ? c.docs : c.docs.filter((d) => d.scope !== "project" || d.projectId === projectId)).map((d) => d.field);
    c.visible.set(scopeKey, docs);
  }
  const limit = Math.max(COMMON_MIN_DF, ratio * docs.length);
  const memo = new Map<string, boolean>();
  return (v) => {
    let is = memo.get(v);
    if (is === undefined) {
      const k = `${scopeKey}|${v}`;
      let df = c.df.get(k);
      if (df === undefined) {
        df = docs.filter((d) => occurrences(d, v) > 0).length;
        c.df.set(k, df);
      }
      is = df > limit;
      memo.set(v, is);
    }
    return is;
  };
}

/** Fewer compared memories than this: z-scores of cosine say little, recall's gates on meaning stay off. */
const Z_MIN_CORPUS = 30;
/** A word must be in more memories than this to count as common, however small the store. */
const COMMON_MIN_DF = 20;

interface Term {
  variants: string[];
}

export function extractTerms(query: string, max = 12): Term[] {
  const words = splitWords(query).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  const seen = new Set<string>();
  const terms: Term[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    const variants = [w];
    if (HANGUL.test(w)) {
      if (w.length >= 3) variants.push(w.slice(0, -1));
      if (w.length >= 4) variants.push(w.slice(0, -2));
    }
    terms.push({ variants: [...new Set(variants)].filter((v) => v.length >= 2) });
    if (terms.length >= max) break;
  }
  return terms;
}

const ftsQuote = (s: string) => `"${s.replace(/"/g, '""')}"`;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * How far a memory's cosine to the query stands above the query's mean cosine, in
 * standard deviations. Undefined when it was not compared (no current vector) or the
 * spread says little (fewer than Z_MIN_CORPUS compared, or no spread).
 */
export function zScore(stats: SimStats, id: number): number | undefined {
  const sim = stats.sims.get(id);
  return sim === undefined || stats.n < Z_MIN_CORPUS || !(stats.sd > 0) ? undefined : (sim - stats.mean) / stats.sd;
}

export interface SearchOptions {
  projectId?: number | null;
  /** Restrict to these scopes. Default: global + user + the project (if any). */
  scopes?: Scope[];
  category?: string;
  limit?: number;
  excludeIds?: Set<number>;
  /** When true, search every project instead of only `projectId`. */
  allProjects?: boolean;
  /** Also return superseded / expired memories (history). Default: only current ones. */
  inactive?: boolean;
  /** Only memories retired by a "supersedes" link (history with a replacement). Overrides `inactive`. */
  supersededOnly?: boolean;
  /**
   * Entity ids named in the query (graph.mentionedEntities). Hits that mention
   * one are boosted, less so for hub entities many memories mention.
   */
  boostEntities?: number[];
  /**
   * The query's embedding (embeddings.queryVector). When given, memories whose
   * vector is at least `minSimilarity` close are candidates too, even with no
   * shared word (another language, other wording), and the ranking fuses the
   * keyword and vector ranks (ADR-0034). Null/absent = keyword search only.
   */
  vector?: Float32Array | null;
  /** Cosine floor for vector candidates (default EMBED_SEARCH_MIN_SIMILARITY). */
  minSimilarity?: number;
  /**
   * Recall's gates (ADR-0046). Recall injects memories nobody asked for, so a hit must be
   * evidence, not a filler for the last slots:
   *  - commonRatio: a keyword hit needs a matched word that is in at most this share of
   *    live memories (or in at most COMMON_MIN_DF); common words only add to the score.
   *  - minZ: a vector candidate's cosine must be this many standard deviations above the
   *    query's mean cosine over every visible memory.
   *  - keywordMinZ: a keyword hit whose memory is further than this from the query in
   *    meaning is dropped (a memory without a current vector is kept).
   * The z gates need a vector and at least Z_MIN_CORPUS compared memories. 1 / 0 = off.
   */
  gate?: { commonRatio: number; minZ: number; keywordMinZ: number };
  /**
   * Filled with the query's cosine to every compared memory (vector side only): recall's
   * graph extras judge their candidates against the same prompt (zScore).
   */
  simStats?: SimStats;
  /** With a gate: counts what each gate dropped, added to this object (debug log, ADR-0050). */
  gated?: { common: number; minZ: number; keywordMinZ: number };
}

export interface SearchHit {
  entry: Entry;
  score: number;
  /** Keyword score before fusion and boosts (absent = no word matched). For the debug log. */
  keyword?: number;
  /** Cosine to the query vector (absent = not a vector candidate). For the debug log. */
  similarity?: number;
  /** With a gate: the matched query words ("*" = common) and the cosine's z-score. For the debug log. */
  terms?: string[];
  z?: number;
}

/** Reciprocal rank fusion constant: smaller = the top of each list counts more. */
const RRF_K = 20;

/** rank (0-based) of each id in a list ordered best first. */
const ranks = (ids: number[]) => new Map(ids.map((id, i) => [id, i]));

export function searchEntries(query: string, opts: SearchOptions = {}): SearchHit[] {
  const terms = extractTerms(query);
  const vector = opts.vector ?? null;
  if (!terms.length && !vector) return [];
  const limit = opts.limit ?? 20;
  const scopes = opts.scopes ?? ["global", "user", "project"];

  const where: string[] = ["e.deleted_at IS NULL", `e.scope IN (${scopes.map(() => "?").join(",")})`];
  const args: (string | number | null)[] = [...scopes];
  if (!opts.allProjects) {
    where.push("(e.scope != 'project' OR e.project_id = ?)");
    args.push(opts.projectId ?? -1);
  }
  if (opts.category) {
    where.push("e.category = ?");
    args.push(opts.category);
  }
  if (opts.supersededOnly) where.push(`NOT ${NOT_SUPERSEDED_SQL("e")}`);
  else if (!opts.inactive) where.push(ACTIVE_SQL("e"));

  // Candidate set: FTS for long variants, LIKE for short ones. Best FTS matches first
  // (bm25): a word in hundreds of memories must not crowd rarer ones out of the 300.
  const candidates = new Map<number, Entry>();
  const long = terms.flatMap((t) => t.variants.filter((v) => v.length >= 3));
  const short = terms.flatMap((t) => t.variants.filter((v) => v.length < 3));
  if (long.length) {
    const rows = db
      .prepare(
        `SELECT e.* FROM entries_fts f JOIN entries e ON e.id = f.rowid
         WHERE entries_fts MATCH ? AND ${where.join(" AND ")} ORDER BY f.rank LIMIT 300`,
      )
      .all(long.map(ftsQuote).join(" OR "), ...args);
    for (const r of rows) candidates.set(Number(r.id), rowToEntry(r));
  }
  if (short.length) {
    const likes = short.map(() => `(e.title LIKE ? ESCAPE '\\' OR e.body LIKE ? ESCAPE '\\' OR e.tags LIKE ? ESCAPE '\\' OR e.keywords LIKE ? ESCAPE '\\')`);
    const likeArgs = short.flatMap((s) => {
      const p = `%${likeEscape(s)}%`;
      return [p, p, p, p];
    });
    const rows = db
      .prepare(`SELECT e.* FROM entries e WHERE ${where.join(" AND ")} AND (${likes.join(" OR ")}) LIMIT 300`)
      .all(...args, ...likeArgs);
    for (const r of rows) candidates.set(Number(r.id), rowToEntry(r));
  }

  // Vector side first: the keyword gate needs every visible memory's cosine.
  const gate = opts.gate;
  const stats: SimStats = opts.simStats ?? { n: 0, mean: 0, sd: 0, sims: new Map() };
  const similar = new Map<number, number>();
  if (vector) {
    const rows = db
      .prepare(`SELECT e.id, e.updated_at FROM entries e WHERE ${where.join(" AND ")}`)
      .all(...args)
      .map((r) => ({ id: Number(r.id), updated_at: String(r.updated_at) }))
      .filter((r) => !opts.excludeIds?.has(r.id));
    for (const n of nearest("entry", vector, rows, opts.minSimilarity ?? config.embed.searchMinSimilarity, Math.max(limit * 3, 50), stats))
      similar.set(n.id, n.sim);
  }
  const zOf = (id: number) => zScore(stats, id);
  // Which gate kept each candidate out (counted once per memory after both sides, for the debug log).
  const dropped = new Map<number, "common" | "minZ" | "keywordMinZ">();
  if (gate && gate.minZ > 0)
    for (const id of [...similar.keys()])
      if ((zOf(id) ?? Infinity) < gate.minZ) {
        similar.delete(id);
        dropped.set(id, "minZ");
      }
  const missing = [...similar.keys()].filter((id) => !candidates.has(id));
  if (missing.length)
    for (const r of db.prepare(`SELECT * FROM entries WHERE id IN (${missing.map(() => "?").join(",")})`).all(...missing))
      candidates.set(Number(r.id), rowToEntry(r));

  // Keyword score: what every memory matching a query word gets.
  const common = gate ? commonWords(gate.commonRatio, opts.projectId ?? null, opts.allProjects) : () => false;
  const keyword = new Map<number, number>();
  const matchedWords = new Map<number, string[]>();
  for (const entry of candidates.values()) {
    if (opts.excludeIds?.has(entry.id)) continue;
    const title = new Field(entry.title);
    const body = new Field(entry.body);
    const tags = new Field(entry.tags.join(" "));
    const keywords = new Field(entry.keywords.join(" "));
    let score = 0;
    let matched = 0;
    // Without a gate any matched word counts; with one, a matched word must not be common.
    let evidence = !gate;
    const words: string[] = [];
    for (const t of terms) {
      let best = 0;
      let bestWord = "";
      for (const v of t.variants) {
        const weight = v.length / t.variants[0].length; // full word beats a trimmed stem
        let s = 0;
        if (occurrences(title, v)) s += 3;
        if (occurrences(tags, v)) s += 2;
        // Keywords exist to bridge wording (synonyms, translations): as strong as a tag.
        else if (occurrences(keywords, v)) s += 2;
        const inBody = occurrences(body, v);
        if (inBody) s += 1 + Math.min(inBody - 1, 3) * 0.2;
        if (s > 0 && !evidence && !common(v)) evidence = true;
        if (s * weight > best) {
          best = s * weight;
          bestWord = v;
        }
      }
      if (best > 0) {
        matched++;
        if (gate) words.push(common(bestWord) ? `${bestWord}*` : bestWord);
      }
      score += best;
    }
    if (!matched) continue;
    if (!evidence) {
      if (gate) dropped.set(entry.id, "common");
      continue;
    }
    if (gate && gate.keywordMinZ > 0 && (zOf(entry.id) ?? Infinity) < gate.keywordMinZ) {
      dropped.set(entry.id, "keywordMinZ");
      continue;
    }
    // Reward covering more of the query.
    keyword.set(entry.id, score * (0.5 + matched / terms.length));
    if (gate) matchedWords.set(entry.id, words);
  }

  // A memory a gate dropped on one side may still be in on the other: count only those left out.
  if (opts.gated) for (const [id, why] of dropped) if (!keyword.has(id) && !similar.has(id)) opts.gated[why]++;

  // Without a query vector the keyword score is the score (unchanged ranking).
  // With one, the two ranked lists are fused (reciprocal rank fusion): their
  // scores are on different scales, ranks are not.
  const kwRank = ranks([...keyword.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).map(([id]) => id));
  const vecRank = ranks([...similar.keys()]);
  const hits: SearchHit[] = [];
  for (const id of new Set([...keyword.keys(), ...similar.keys()])) {
    const entry = candidates.get(id);
    if (!entry) continue;
    let score: number;
    if (!vector) score = keyword.get(id)!;
    else {
      const k = kwRank.get(id);
      const v = vecRank.get(id);
      score = (k === undefined ? 0 : 1 / (RRF_K + k)) + (v === undefined ? 0 : 1 / (RRF_K + v));
    }
    // Then prefer project-specific and pinned entries.
    if (entry.scope === "project") score *= 1.15;
    if (entry.pinned) score *= 1.1;
    const kw = keyword.get(id);
    const sim = similar.get(id);
    const z = gate ? zOf(id) : undefined;
    const words = matchedWords.get(id);
    hits.push({
      entry,
      score,
      ...(kw === undefined ? {} : { keyword: kw }),
      ...(sim === undefined ? {} : { similarity: sim }),
      ...(words ? { terms: words } : {}),
      ...(z === undefined ? {} : { z: Math.round(z * 100) / 100 }),
    });
  }
  if (opts.boostEntities?.length && hits.length)
    applyEntityBoost(hits, opts.boostEntities, opts.allProjects ? undefined : (opts.projectId ?? -1));
  hits.sort((a, b) => b.score - a.score || b.entry.updated_at.localeCompare(a.entry.updated_at));
  return hits.slice(0, limit);
}

/**
 * Entity boost with hub dampening: score *= 1 + 0.5 / (1 + 0.001 * (n - 1)^2),
 * n = live memories mentioning the entity. A rare entity gives almost the full
 * +50%; one mentioned by hundreds of memories says little about relevance.
 * A memory naming several of the entities takes the strongest boost.
 * n counts only memories visible from the caller's project (same filter as
 * searchEntries), so another project's hub never dampens this one's boost.
 */
export function entityBoost(n: number): number {
  return 1 + 0.5 / (1 + 0.001 * Math.max(0, n - 1) ** 2);
}

/**
 * How many of an entity's newest memories recall adds as extras when the prompt
 * names it, from the same hub curve as entityBoost: 3 while the boost is still
 * strong (n ≤ 16), 1 for a mid-sized entity (n ≤ 39), none for a hub — its
 * newest memories are most likely unrelated to the request; the boost on search
 * hits already surfaces the relevant ones.
 */
export function entityExtraLimit(n: number): number {
  const f = entityBoost(n);
  return f >= 1.4 ? 3 : f >= 1.2 ? 1 : 0;
}

/**
 * Active, live memories mentioning each entity (the hub size n of entityBoost).
 * projectId limits the count to what that project can see (undefined = every
 * project; pass `projectId ?? -1` for a project-less caller). The only counting
 * path: the search boost and the per-entity recall extras both use it.
 */
export function entityMentionCounts(entityIds: number[], projectId?: number): Map<number, number> {
  const ents = [...new Set(entityIds)];
  const counts = new Map<number, number>();
  if (!ents.length) return counts;
  const eph = ents.map(() => "?").join(",");
  const visible = projectId === undefined ? "" : "AND (e.scope != 'project' OR e.project_id = ?)";
  for (const r of db
    .prepare(
      `SELECT ee.entity_id AS id, COUNT(*) AS n FROM entry_entities ee JOIN entries e ON e.id = ee.entry_id
       WHERE ee.entity_id IN (${eph}) AND e.deleted_at IS NULL AND ${ACTIVE_SQL("e")} ${visible} GROUP BY ee.entity_id`,
    )
    .all(...ents, ...(projectId === undefined ? [] : [projectId])))
    counts.set(Number(r.id), Number(r.n));
  return counts;
}

function applyEntityBoost(hits: SearchHit[], entityIds: number[], projectId?: number) {
  const ents = [...new Set(entityIds)];
  const eph = ents.map(() => "?").join(",");
  const counts = entityMentionCounts(ents, projectId);
  const ids = hits.map((h) => h.entry.id);
  const best = new Map<number, number>();
  for (const r of db
    .prepare(`SELECT entry_id, entity_id FROM entry_entities WHERE entity_id IN (${eph}) AND entry_id IN (${ids.map(() => "?").join(",")})`)
    .all(...ents, ...ids)) {
    const f = entityBoost(counts.get(Number(r.entity_id)) ?? 1);
    const id = Number(r.entry_id);
    best.set(id, Math.max(best.get(id) ?? 1, f));
  }
  for (const h of hits) h.score *= best.get(h.entry.id) ?? 1;
}

export interface TurnHit {
  id: number;
  project_id: number | null;
  project_name: string | null;
  session_id: string;
  created_at: string;
  snippet: string;
}

export function searchTurns(query: string, opts: { projectId?: number | null; limit?: number } = {}): TurnHit[] {
  const terms = extractTerms(query);
  if (!terms.length) return [];
  const limit = opts.limit ?? 10;
  const long = terms.flatMap((t) => t.variants.filter((v) => v.length >= 3));
  const short = terms.flatMap((t) => t.variants.filter((v) => v.length < 3));
  const projectFilter = opts.projectId ? "AND t.project_id = ?" : "";
  const pArgs = opts.projectId ? [opts.projectId] : [];
  const rows = new Map<number, Record<string, unknown>>();
  if (long.length) {
    for (const r of db
      .prepare(
        `SELECT t.id, t.project_id, t.session_id, t.created_at, t.text, p.name AS project_name
         FROM turns_fts f JOIN turns t ON t.id = f.rowid LEFT JOIN projects p ON p.id = t.project_id
         WHERE turns_fts MATCH ? ${projectFilter} ORDER BY t.id DESC LIMIT 200`,
      )
      .all(long.map(ftsQuote).join(" OR "), ...pArgs))
      rows.set(Number(r.id), r);
  }
  if (short.length) {
    for (const r of db
      .prepare(
        `SELECT t.id, t.project_id, t.session_id, t.created_at, t.text, p.name AS project_name
         FROM turns t LEFT JOIN projects p ON p.id = t.project_id
         WHERE (${short.map(() => "t.text LIKE ? ESCAPE '\\'").join(" OR ")}) ${projectFilter}
         ORDER BY t.id DESC LIMIT 200`,
      )
      .all(...short.map((s) => `%${likeEscape(s)}%`), ...pArgs))
      rows.set(Number(r.id), r);
  }
  const scored = [...rows.values()].map((r) => {
    const text = String(r.text);
    const lower = text.toLowerCase();
    let score = 0;
    let first = -1;
    for (const t of terms) {
      for (const v of t.variants) {
        const i = lower.indexOf(v);
        if (i >= 0) {
          score += v.length / t.variants[0].length;
          if (first < 0 || i < first) first = i;
          break;
        }
      }
    }
    const start = Math.max(0, first - 120);
    const snippet = (start > 0 ? "…" : "") + text.slice(start, start + 400).replace(/\s+/g, " ") + (text.length > start + 400 ? "…" : "");
    return {
      score,
      hit: {
        id: Number(r.id),
        project_id: r.project_id == null ? null : Number(r.project_id),
        project_name: r.project_name == null ? null : String(r.project_name),
        session_id: String(r.session_id),
        created_at: String(r.created_at),
        snippet,
      },
    };
  });
  scored.sort((a, b) => b.score - a.score || b.hit.id - a.hit.id);
  return scored.slice(0, limit).map((s) => s.hit);
}
