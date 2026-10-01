import path from "node:path";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: int("PORT", 8765),
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
};

export const llmEnabled = () => Boolean(config.llm.baseUrl);
