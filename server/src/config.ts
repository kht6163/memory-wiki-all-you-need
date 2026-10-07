import path from "node:path";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** IANA zone for dates the LLM writes (TURN DATE); invalid names fall back to UTC. */
function zone(name: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: raw });
    return raw;
  } catch {
    console.warn(`[config] ${name}=${raw} is not a known time zone; using UTC`);
    return "UTC";
  }
}

/** On/off env var: true or false when set to a known word, undefined when unset or unknown. */
function onOff(name: string): boolean | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (/^(1|true|on|yes)$/i.test(raw)) return true;
  if (/^(0|false|off|no)$/i.test(raw)) return false;
  console.warn(`[config] ${name}=${raw} is not on/off; ignoring it`);
  return undefined;
}

/** A number in [min, max] (for similarity floors); anything else falls back. */
function float(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export const config = {
  port: int("PORT", 8765),
  /** Users' local time zone, so "yesterday" at 01:00 KST resolves to the right day. */
  timezone: zone("TIMEZONE"),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir: process.env.DATA_DIR ?? path.resolve("data"),
  webDir: process.env.WEB_DIR ?? path.resolve("../web/dist"),
  extensionDir: process.env.EXTENSION_DIR ?? path.resolve("../pi-extension"),
  llm: {
    baseUrl: (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, ""),
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "gpt-6-luna",
    timeoutMs: int("LLM_TIMEOUT_MS", 180_000),
  },
  /**
   * Optional embedding endpoint (OpenAI-compatible POST /embeddings, e.g. infinity
   * or TEI serving BAAI/bge-m3). Unset EMBED_BASE_URL = keyword search only.
   * The similarity floors are tuned for bge-m3 (ADR-0034); another model needs its own.
   */
  embed: {
    baseUrl: (process.env.EMBED_BASE_URL ?? "").replace(/\/+$/, ""),
    apiKey: process.env.EMBED_API_KEY ?? "",
    model: process.env.EMBED_MODEL?.trim() || "BAAI/bge-m3",
    /** Per batch of memory/page texts (background indexing). */
    timeoutMs: int("EMBED_TIMEOUT_MS", 60_000),
    /** Per query vector on the request path (/context); on timeout the search is keyword-only. */
    queryTimeoutMs: int("EMBED_QUERY_TIMEOUT_MS", 700),
    /** Query text cut to this many characters (CPU cost grows with length). */
    queryMaxChars: int("EMBED_QUERY_MAX_CHARS", 500),
    /** Memory/page text cut to this many characters before embedding. */
    docMaxChars: int("EMBED_DOC_MAX_CHARS", 1200),
    batch: int("EMBED_BATCH", 8),
    /** A memory with no keyword match is recalled into the prompt only at or above this cosine. */
    recallMinSimilarity: float("EMBED_RECALL_MIN_SIMILARITY", 0.55, -1, 1),
    /**
     * Recall only: a memory found by meaning must also stand out from this prompt's
     * cosine to every memory — at least this many standard deviations above the mean
     * (bge-m3 puts unrelated memories anywhere from 0.33 to 0.47 on average depending
     * on the prompt, so a fixed cosine cannot tell noise from a match; ADR-0046). 0 = off.
     */
    recallMinZ: float("EMBED_RECALL_MIN_Z", 3.5, 0, 100),
    /**
     * Recall only: a memory found by words is dropped when its meaning is this far from
     * the prompt (z below this), unless it has no vector yet. 0 = off.
     */
    recallKeywordMinZ: float("EMBED_RECALL_KEYWORD_MIN_Z", 2, 0, 100),
    /** Same for memory_search / wiki search / the web (the caller judges the hits). */
    searchMinSimilarity: float("EMBED_SEARCH_MIN_SIMILARITY", 0.45, -1, 1),
    /** Prepended to queries / documents for models that need it (e5: "query: " / "passage: "). */
    queryPrefix: process.env.EMBED_QUERY_PREFIX ?? "",
    docPrefix: process.env.EMBED_DOC_PREFIX ?? "",
  },
  /**
   * Debug mode (ADR-0035): JSON lines per local day under logDir. DEBUG_MODE=1
   * forces it on; otherwise the switch in <DATA_DIR>/debug.json (web / PUT /api/debug).
   */
  debug: {
    env: /^(1|true|on|yes)$/i.test(process.env.DEBUG_MODE?.trim() ?? ""),
    logDir: process.env.DEBUG_LOG_DIR ?? path.join(process.env.DATA_DIR ?? path.resolve("data"), "logs"),
    keepDays: int("DEBUG_LOG_KEEP_DAYS", 14),
    /** A day's file stops growing at this size (one "truncated" line marks it). */
    maxBytesPerDay: int("DEBUG_LOG_MAX_MB", 200) * 1024 * 1024,
    /** Any single string in an event is cut to this many characters. */
    maxStringChars: int("DEBUG_LOG_MAX_STRING", 20_000),
  },
  /** Character budget for the stable memory block injected into the system prompt. */
  contextBudget: int("CONTEXT_BUDGET_CHARS", 8000),
  /** Character budget for per-prompt recall. */
  recallBudget: int("RECALL_BUDGET_CHARS", 3000),
  recallLimit: int("RECALL_LIMIT", 6),
  /**
   * Recall only: a word in more than this share of live memories (and in more than 20)
   * is common ("확인", "실제", "사용") — it still adds to a hit's score but cannot recall a
   * memory by itself (ADR-0046). 1 = off.
   */
  recallCommonRatio: float("RECALL_COMMON_RATIO", 0.06, 0, 1),
  wiki: {
    /** WIKI_COMPOSE=1/0 fixes turn-record compose on or off; unset = the web switch (settings.json, ADR-0038). */
    composeEnv: onOff("WIKI_COMPOSE"),
    /** Turn-record characters sent to the LLM per compose call; bigger jobs run in several chunks. */
    composeChunkChars: int("WIKI_COMPOSE_CHUNK_CHARS", 40_000),
    /** Most turns one compose job may take. */
    composeMaxTurns: int("WIKI_COMPOSE_MAX_TURNS", 200),
    /** Character budget of current page bodies shown to the LLM per compose call. */
    writerBudget: int("WIKI_WRITER_BUDGET_CHARS", 40_000),
    /** Character budget of the wiki page list injected into pi. */
    indexBudget: int("WIKI_INDEX_BUDGET_CHARS", 1500),
  },
  graph: {
    /** Extra memories recall may add through the graph (entity mentions, links), still inside RECALL_BUDGET_CHARS. */
    recallExtra: int("GRAPH_RECALL_EXTRA", 4),
    /**
     * Recall only, with a prompt vector: a 1-/2-hop linked memory whose meaning is this far
     * below the prompt's mean cosine (z under this) is not added (G-087). Links are explicit,
     * so the floor only drops clear misses. Absent vector / small store = no floor.
     */
    recallMinZ: float("GRAPH_RECALL_MIN_Z", -0.5, -100, 100),
    /**
     * Recall only, with a prompt vector: memories close to a recalled one in meaning (cosine
     * ≥ GRAPH_SIMILAR_MIN) or written within GRAPH_NEARBY_HOURS of it may fill slots the
     * links left, when the prompt's z for them is at least this (G-087, ADR-0051).
     * Computed per request, never stored. 0 = off.
     */
    proximityMinZ: float("GRAPH_PROXIMITY_MIN_Z", 2, 0, 100),
    similarMin: float("GRAPH_SIMILAR_MIN", 0.7, -1, 1),
    /**
     * Window for "written around the same time" (hours, either side). 0 = off, the default:
     * imported memories share one created_at, and on a real store the window brought in
     * unrelated memories from the same session (ADR-0051).
     */
    nearbyHours: float("GRAPH_NEARBY_HOURS", 0, 0, 24 * 365),
    /** Memory characters sent to the LLM per backfill call. */
    backfillChunkChars: int("GRAPH_BACKFILL_CHUNK_CHARS", 24_000),
    /** Most memories one backfill job may take. */
    backfillMax: int("GRAPH_BACKFILL_MAX", 2000),
  },
  review: {
    /** Memory characters sent to the LLM per review call. */
    chunkChars: int("REVIEW_CHUNK_CHARS", 24_000),
    /** Most memories one review job may take. */
    maxEntries: int("REVIEW_MAX_ENTRIES", 2000),
    /** No use and no edit for this many days → listed as stale. */
    staleDays: int("REVIEW_STALE_DAYS", 60),
    /** Propose a review of each scope with changes at most every this many days (0 = off). Never applies anything. */
    everyDays: int("REVIEW_EVERY_DAYS", 0),
  },
};

/** YYYY-MM-DD of an ISO timestamp in the configured time zone. */
export function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export const llmEnabled = () => Boolean(config.llm.baseUrl);
export const embedEnabled = () => Boolean(config.embed.baseUrl);
