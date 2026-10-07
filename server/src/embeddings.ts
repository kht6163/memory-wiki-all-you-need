import crypto from "node:crypto";
import { config, embedEnabled } from "./config.ts";
import { db, rowToEntry, type Entry } from "./db.ts";
import { debugLog, msSince } from "./debug-log.ts";

// Semantic search (ADR-0034): one vector per memory and per wiki page from an
// optional OpenAI-compatible /embeddings endpoint, compared in JS (no native
// addon, ADR-0006 constraint kept). Vectors are unit length, so cosine = dot.
//  - Indexing runs in its own background loop (startEmbedder), never on a write
//    path: a memory without a vector yet is still found by keyword search.
//  - The query vector is fetched on the request path with a short timeout; any
//    failure means keyword-only search for that request (G-063).
//  - A row is keyed by text_hash = hash(model + embedded text), so a model change
//    re-embeds everything and vectors of two models are never compared (G-064).

export type EmbedKind = "entry" | "page";

const TABLES: Record<EmbedKind, { table: string; key: string }> = {
  entry: { table: "entry_embeddings", key: "entry_id" },
  page: { table: "wiki_embeddings", key: "page_id" },
};

/** POST /embeddings; returns one unit-length vector per input, in input order. */
export async function embedTexts(texts: string[], timeoutMs: number): Promise<Float32Array[]> {
  const res = await fetch(`${config.embed.baseUrl}/embeddings`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": "application/json",
      ...(config.embed.apiKey ? { authorization: `Bearer ${config.embed.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.embed.model, input: texts }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`embedding HTTP ${res.status}: ${text.slice(0, 300)}`);
  let data: { index?: number; embedding?: unknown }[];
  try {
    data = JSON.parse(text).data;
  } catch {
    throw new Error(`embedding endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(data) || data.length !== texts.length) throw new Error(`embedding endpoint returned ${Array.isArray(data) ? data.length : "no"} vectors for ${texts.length} inputs`);
  const out: Float32Array[] = new Array(texts.length);
  data.forEach((d, i) => {
    const at = typeof d.index === "number" ? d.index : i;
    const v = d.embedding;
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "number" && Number.isFinite(x))) throw new Error("embedding endpoint returned a malformed vector");
    if (at < 0 || at >= texts.length || out[at]) throw new Error("embedding endpoint returned a bad index");
    out[at] = unit(Float32Array.from(v as number[]));
  });
  if (out.some((v) => v.length !== out[0].length)) throw new Error("embedding endpoint returned vectors of different sizes");
  return out;
}

function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
/** Copies, so the Float32Array is aligned whatever offset SQLite's buffer has. */
export const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

// ------------------------------------------------------------------ texts

const cut = (s: string) => s.slice(0, config.embed.docMaxChars);

/** What a memory is embedded as: everything keyword search sees, title first. */
export function entryText(e: Pick<Entry, "title" | "body" | "tags" | "keywords">): string {
  return config.embed.docPrefix + cut([e.title, e.body, e.tags.join(", "), e.keywords.join(", ")].filter((s) => s.trim()).join("\n"));
}

/** A wiki page: title plus the opening of the body (pages are long; the lead says what it is about). */
export function pageText(p: { title: string; body: string }): string {
  return config.embed.docPrefix + cut(`${p.title}\n${p.body}`);
}

export const textHash = (text: string) => crypto.createHash("sha256").update(`${config.embed.model}\0${text}`).digest("hex").slice(0, 32);

// ---------------------------------------------------------------- vectors

interface Stored {
  vector: Float32Array;
  hash: string;
}
const cache: Record<EmbedKind, Map<number, Stored> | null> = { entry: null, page: null };

/** Vectors of the configured model with the text hash they were made from, loaded once and kept in step by the indexer. */
function vectors(kind: EmbedKind): Map<number, Stored> {
  let m = cache[kind];
  if (m) return m;
  m = new Map();
  const { table, key } = TABLES[kind];
  for (const r of db.prepare(`SELECT ${key} AS id, text_hash, vector FROM ${table} WHERE model = ?`).all(config.embed.model))
    m.set(Number(r.id), { vector: fromBlob(r.vector as Uint8Array), hash: String(r.text_hash) });
  cache[kind] = m;
  return m;
}

/**
 * Hash of what the row would be embedded as now, memoized per updated_at (every
 * write path that changes the embedded text also sets updated_at).
 */
const currentHashes: Record<EmbedKind, Map<number, { at: string; hash: string }>> = { entry: new Map(), page: new Map() };
function currentHash(kind: EmbedKind, id: number, updatedAt: string): string | null {
  const memo = currentHashes[kind].get(id);
  if (memo && memo.at === updatedAt) return memo.hash;
  let text: string;
  if (kind === "entry") {
    const r = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id);
    if (!r) return null;
    text = entryText(rowToEntry(r));
  } else {
    const r = db.prepare(`SELECT title, body FROM wiki_pages WHERE id = ?`).get(id);
    if (!r) return null;
    text = pageText({ title: String(r.title), body: String(r.body) });
  }
  const hash = textHash(text);
  currentHashes[kind].set(id, { at: updatedAt, hash });
  return hash;
}

/**
 * A row's stored vector, without the current-text check: only for ids whose
 * cosine `nearest` already computed in this request (it skips stale rows).
 */
export function storedVector(kind: EmbedKind, id: number): Float32Array | undefined {
  return vectors(kind).get(id)?.vector;
}

/** Tests: forget loaded vectors (rows written behind the indexer's back). */
export function resetVectorCache() {
  cache.entry = null;
  cache.page = null;
  currentHashes.entry.clear();
  currentHashes.page.clear();
}

/**
 * Cosine of the query to each candidate (id + updated_at) that has a vector
 * made from its current text, kept when at least `min`, best first, at most
 * `max`. A row edited since it was embedded is skipped until the indexer
 * re-embeds it: never matched by what it used to say (G-064).
 */
/** Cosine spread of one query over every compared row (all of them, not only the returned ones). */
export interface SimStats {
  n: number;
  mean: number;
  sd: number;
  /** Cosine of each compared row (vector current), for z-scores of rows below the floor. */
  sims: Map<number, number>;
}

export function nearest(
  kind: EmbedKind,
  query: Float32Array,
  rows: Iterable<{ id: number; updated_at: string }>,
  min: number,
  max: number,
  stats?: SimStats,
): { id: number; sim: number }[] {
  const vs = vectors(kind);
  const out: { id: number; sim: number }[] = [];
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (const { id, updated_at } of rows) {
    const v = vs.get(id);
    if (!v || v.hash !== currentHash(kind, id, updated_at)) continue;
    const sim = dot(query, v.vector);
    if (stats) {
      stats.sims.set(id, sim);
      sum += sim;
      sq += sim * sim;
      n++;
    }
    if (sim >= min) out.push({ id, sim });
  }
  if (stats) {
    stats.n = n;
    stats.mean = n ? sum / n : 0;
    stats.sd = n ? Math.sqrt(Math.max(0, sq / n - stats.mean ** 2)) : 0;
  }
  out.sort((a, b) => b.sim - a.sim || b.id - a.id);
  return out.slice(0, max);
}

// ------------------------------------------------------------------ query

const queryCache = new Map<string, Float32Array>();
const QUERY_CACHE_MAX = 256;
// Back-off after a failure, kept apart for the request path and background
// callers: a slow /context query must not turn off curation's vector, nor the reverse.
const downUntil = { request: 0, background: 0 };
let queryWarned = false;

/**
 * The query's vector, or null (embeddings off, empty query, endpoint down or
 * slow). Never throws: callers fall back to keyword-only search (G-063).
 * After a failure the endpoint is skipped for a while (5 s after a timeout,
 * 30 s after an error) so a dead endpoint does not cost every request the timeout.
 */
/** What happened to one query embedding (filled when passed; for the debug log). */
export interface QueryInfo {
  result?: "off" | "empty" | "cache" | "backoff" | "ok" | "timeout" | "error";
  ms?: number;
  error?: string;
}

export async function queryVector(query: string, opts: { background?: boolean; info?: QueryInfo } = {}): Promise<Float32Array | null> {
  const info = opts.info ?? {};
  if (!embedEnabled()) {
    info.result = "off";
    return null;
  }
  // Background work (turn curation) may wait and embed more text; the request path may not.
  const text = query.trim().slice(0, opts.background ? config.embed.docMaxChars : config.embed.queryMaxChars);
  if (!text) {
    info.result = "empty";
    return null;
  }
  const hit = queryCache.get(text);
  if (hit) {
    queryCache.delete(text);
    queryCache.set(text, hit);
    info.result = "cache";
    return hit;
  }
  const lane = opts.background ? "background" : "request";
  if (Date.now() < downUntil[lane]) {
    info.result = "backoff";
    return null;
  }
  const t0 = performance.now();
  try {
    const [v] = await embedTexts([config.embed.queryPrefix + text], opts.background ? Math.min(config.embed.timeoutMs, 15_000) : config.embed.queryTimeoutMs);
    queryCache.set(text, v);
    if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value!);
    if (queryWarned) console.log("[embed] query embeddings are back");
    queryWarned = false;
    info.result = "ok";
    info.ms = msSince(t0);
    debugLog("embed.query", { lane, chars: text.length, ms: info.ms });
    return v;
  } catch (err) {
    const timeout = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
    downUntil[lane] = Date.now() + (timeout ? 5_000 : 30_000);
    info.result = timeout ? "timeout" : "error";
    info.ms = msSince(t0);
    info.error = (err as Error).message;
    debugLog("embed.query", { lane, chars: text.length, ms: info.ms, result: info.result, error: info.error });
    if (!queryWarned) console.warn(`[embed] query embedding failed, keyword search only for now: ${(err as Error).message}`);
    queryWarned = true;
    return null;
  }
}

/** Tests: clear the query cache and the failure back-off. */
export function resetQueryState() {
  queryCache.clear();
  downUntil.request = 0;
  downUntil.background = 0;
  queryWarned = false;
}

// --------------------------------------------------------------- indexing

interface Doc {
  id: number;
  text: string;
  hash: string;
}

/** Live memories (any state: history is searchable too) and live pages whose vector is missing or stale. */
function staleDocs(kind: EmbedKind): Doc[] {
  const { table, key } = TABLES[kind];
  const have = new Map<number, string>();
  for (const r of db.prepare(`SELECT ${key} AS id, text_hash FROM ${table}`).all()) have.set(Number(r.id), String(r.text_hash));
  const rows =
    kind === "entry"
      ? db.prepare(`SELECT * FROM entries WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC`).all().map((r) => {
          const e = rowToEntry(r);
          return { id: e.id, text: entryText(e) };
        })
      : db
          .prepare(`SELECT id, title, body FROM wiki_pages WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC`)
          .all()
          .map((r) => ({ id: Number(r.id), text: pageText({ title: String(r.title), body: String(r.body) }) }));
  const out: Doc[] = [];
  for (const r of rows) {
    const hash = textHash(r.text);
    if (have.get(r.id) !== hash && !skipped.has(`${kind}:${r.id}:${hash}`)) out.push({ ...r, hash });
  }
  return out;
}

/** Texts the endpoint failed on their own (id + hash) while others went through: not retried until the text changes. */
const skipped = new Set<string>();
let lastError: string | null = null;

function save(kind: EmbedKind, doc: Doc, v: Float32Array) {
  const { table, key } = TABLES[kind];
  // The row may have been purged while the batch was out; the FK makes the insert fail then.
  const r = db.prepare(`SELECT 1 FROM ${kind === "entry" ? "entries" : "wiki_pages"} WHERE id = ?`).get(doc.id);
  if (!r) return;
  db.prepare(
    `INSERT INTO ${table} (${key}, model, text_hash, dim, vector, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(${key}) DO UPDATE SET model = excluded.model, text_hash = excluded.text_hash, dim = excluded.dim, vector = excluded.vector, updated_at = excluded.updated_at`,
  ).run(doc.id, config.embed.model, doc.hash, v.length, toBlob(v));
  vectors(kind).set(doc.id, { vector: v, hash: doc.hash });
}

/** The endpoint answered with an HTTP error (not a network error or timeout): maybe this input's fault. */
const isHttpError = (err: unknown) => /^embedding HTTP \d/.test((err as Error).message);

/**
 * Embeds one batch of stale memories, else of stale pages. Returns how many
 * were handled (0 = nothing to do).
 * - Network errors and timeouts throw (the loop backs off and retries).
 * - An HTTP error for the batch retries its texts one by one. Texts that fail
 *   while at least one other succeeds are the input's fault and are skipped
 *   until they change. If every text fails, the endpoint is the problem (bad
 *   URL or key, rate limit, outage): nothing is skipped and the error is thrown.
 */
export async function indexOnce(): Promise<number> {
  if (!embedEnabled()) return 0;
  for (const kind of ["entry", "page"] as EmbedKind[]) {
    const docs = staleDocs(kind).slice(0, config.embed.batch);
    if (!docs.length) continue;
    const t0 = performance.now();
    try {
      const vs = await embedTexts(docs.map((d) => d.text), config.embed.timeoutMs);
      docs.forEach((d, i) => save(kind, d, vs[i]));
      debugLog("embed.index", { kind, ids: docs.map((d) => d.id), ms: msSince(t0) });
      return docs.length;
    } catch (err) {
      debugLog("embed.index", { kind, ids: docs.map((d) => d.id), ms: msSince(t0), error: (err as Error).message });
      if (!isHttpError(err) || docs.length === 1) throw err;
    }
    const failed: { doc: Doc; err: Error }[] = [];
    let ok = 0;
    for (const d of docs) {
      try {
        const [v] = await embedTexts([d.text], config.embed.timeoutMs);
        save(kind, d, v);
        ok++;
      } catch (err) {
        if (!isHttpError(err)) throw err;
        failed.push({ doc: d, err: err as Error });
      }
    }
    if (!ok) throw failed[0].err;
    for (const { doc, err } of failed) {
      skipped.add(`${kind}:${doc.id}:${doc.hash}`);
      debugLog("embed.skip", { kind, id: doc.id, error: err.message });
      console.warn(`[embed] ${kind} #${doc.id} refused, skipped until it changes: ${err.message}`);
    }
    return docs.length;
  }
  return 0;
}

/** Runs one indexing step and records its error for /health (null again once a step succeeds). */
export async function indexStep(): Promise<number> {
  try {
    const n = await indexOnce();
    lastError = null;
    return n;
  } catch (err) {
    lastError = (err as Error).message;
    throw err;
  }
}

/** Embeds until nothing is stale (tests and one-off scripts). */
export async function indexAll() {
  while ((await indexStep()) > 0);
}

export function embedStats() {
  if (!embedEnabled()) return { embed: null, embedPending: 0, embedSkipped: 0, embedError: null };
  return { embed: config.embed.model, embedPending: staleDocs("entry").length + staleDocs("page").length, embedSkipped: skipped.size, embedError: lastError };
}

export function startEmbedder() {
  if (!embedEnabled()) return;
  let failures = 0;
  const loop = async () => {
    for (;;) {
      let wait = 10_000;
      try {
        const n = await indexStep();
        if (failures) console.log("[embed] indexing is back");
        failures = 0;
        if (n > 0) wait = 0;
      } catch (err) {
        if (failures++ === 0) console.warn(`[embed] indexing failed, retrying: ${(err as Error).message}`);
        wait = Math.min(300_000, 15_000 * 2 ** Math.min(failures, 5));
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  };
  void loop();
}
