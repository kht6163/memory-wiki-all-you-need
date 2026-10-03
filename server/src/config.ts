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
  /** Character budget for the stable memory block injected into the system prompt. */
  contextBudget: int("CONTEXT_BUDGET_CHARS", 8000),
  /** Character budget for per-prompt recall. */
  recallBudget: int("RECALL_BUDGET_CHARS", 3000),
  recallLimit: int("RECALL_LIMIT", 6),
  wiki: {
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

export const llmEnabled = () => Boolean(config.llm.baseUrl);
