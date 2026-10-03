import { db, rowToEntry, type Entry, type Scope } from "./db.ts";
import { ACTIVE_SQL, NOT_SUPERSEDED_SQL } from "./store.ts";

// Search over a trigram FTS index. Trigram cannot match terms shorter than
// three characters, which is common in Korean ("포트", "설정"), so short terms
// fall back to LIKE. Korean words also carry trailing particles ("포트를"), so
// each Hangul term is also tried with its last one or two syllables dropped.

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "what", "how", "are", "was",
  "해줘", "해주세요", "있어", "없어", "그리고", "그런데", "근데", "이거", "저거", "그거", "어떻게", "뭐야", "에서",
]);

const HANGUL = /[가-힣]/;

interface Term {
  variants: string[];
}

export function extractTerms(query: string, max = 12): Term[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.\-/]+/u)
    .map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, ""))
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
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
}

export interface SearchHit {
  entry: Entry;
  score: number;
}

export function searchEntries(query: string, opts: SearchOptions = {}): SearchHit[] {
  const terms = extractTerms(query);
  if (!terms.length) return [];
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

  // Candidate set: FTS for long variants, LIKE for short ones.
  const candidates = new Map<number, Entry>();
  const long = terms.flatMap((t) => t.variants.filter((v) => v.length >= 3));
  const short = terms.flatMap((t) => t.variants.filter((v) => v.length < 3));
  if (long.length) {
    const rows = db
      .prepare(
        `SELECT e.* FROM entries_fts f JOIN entries e ON e.id = f.rowid
         WHERE entries_fts MATCH ? AND ${where.join(" AND ")} LIMIT 300`,
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

  const hits: SearchHit[] = [];
  for (const entry of candidates.values()) {
    if (opts.excludeIds?.has(entry.id)) continue;
    const title = entry.title.toLowerCase();
    const body = entry.body.toLowerCase();
    const tags = entry.tags.join(" ").toLowerCase();
    const keywords = entry.keywords.join(" ").toLowerCase();
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      let best = 0;
      for (const v of t.variants) {
        const weight = v.length / t.variants[0].length; // full word beats a trimmed stem
        let s = 0;
        if (title.includes(v)) s += 3;
        if (tags.includes(v)) s += 2;
        // Keywords exist to bridge wording (synonyms, translations): as strong as a tag.
        else if (keywords.includes(v)) s += 2;
        if (body.includes(v)) s += 1 + Math.min(body.split(v).length - 2, 3) * 0.2;
        best = Math.max(best, s * weight);
      }
      if (best > 0) matched++;
      score += best;
    }
    if (!matched) continue;
    // Reward covering more of the query, then prefer project-specific and pinned entries.
    score *= 0.5 + matched / terms.length;
    if (entry.scope === "project") score *= 1.15;
    if (entry.pinned) score *= 1.1;
    hits.push({ entry, score });
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

function applyEntityBoost(hits: SearchHit[], entityIds: number[], projectId?: number) {
  const ents = [...new Set(entityIds)];
  const eph = ents.map(() => "?").join(",");
  const visible = projectId === undefined ? "" : "AND (e.scope != 'project' OR e.project_id = ?)";
  const counts = new Map<number, number>();
  for (const r of db
    .prepare(
      `SELECT ee.entity_id AS id, COUNT(*) AS n FROM entry_entities ee JOIN entries e ON e.id = ee.entry_id
       WHERE ee.entity_id IN (${eph}) AND e.deleted_at IS NULL AND ${ACTIVE_SQL("e")} ${visible} GROUP BY ee.entity_id`,
    )
    .all(...ents, ...(projectId === undefined ? [] : [projectId])))
    counts.set(Number(r.id), Number(r.n));
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
