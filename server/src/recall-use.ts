import { config, localDate } from "./config.ts";
import type { Turn } from "./db.ts";
import { debugEnabled, debugEvents, debugLog } from "./debug-log.ts";
import { commonWords } from "./search.ts";
import { redactSecrets } from "./secrets.ts";
import { getEntry } from "./store.ts";
import { searchWords } from "./words.ts";

// Recall measurement (ADR-0050): did the agent use what recall injected? /context remembers,
// per session, which memories it recalled for which prompt; when that turn arrives (/turns),
// the agent's own output (assistant text and tool-call arguments, not tool results) is checked
// for each memory: cited as #id, or distinctive words of the memory that the prompt did not
// contain. One "recall.use" debug line per prompt. recallReport sums the debug log for a period.
// Debug mode only: nothing is remembered or written while it is off.

interface Pending {
  prompt: string;
  /** What the turn's user message is compared by (promptKey). */
  key: string;
  recalled: number[];
  agent: string | null;
  projectId: number | null;
  at: number;
}

/** Sessions remembered at most (oldest dropped first) and prompts kept per session. */
const MAX_SESSIONS = 500;
const MAX_PER_SESSION = 20;
/** A prompt whose turn has not arrived within this long is forgotten. */
const MAX_AGE_MS = 6 * 3600_000;
/** Distinctive words of a memory to look for, and how many must appear to count as used. */
const MAX_TERMS = 24;
export const USE_MIN_TERMS = 2;
/**
 * "Distinctive" is stricter than recall's common-word gate: in at most this share of live memories
 * (and at most COMMON_MIN_DF). Replayed on production turns, the recall ratio (6%) let words like
 * "프로젝트" or "그래서" count as evidence.
 */
const DISTINCT_RATIO = 0.02;
/** Korean particles after a noun ("스킬이", "커밋을", "범위로"): the stem is the word. */
const JOSA = /(으로|에서|에게|까지|부터|처럼|보다|이랑|하고|이|가|을|를|은|는|에|의|로|과|와|도|만)$/u;
/** Korean adverbs / connectives that are in few memories yet say nothing about one. */
const KO_FILLER = new Set(["그래서", "아니라", "이번에", "그대로", "무조건", "않으면", "때문에", "하지만", "그러면", "그리고", "따라서"]);
/**
 * A Korean word ending like a verb or adjective ("확인할", "확인해야", "변경된", "확인하지"): not a
 * name of anything. "지" / "한" only in verb forms: "메시지", "패키지", "이미지", "권한" are nouns.
 */
const KO_VERBISH = /(다|고|할|야|면|며|는|던|된|해|게|요|하지|되지|않지|없지|있지|이지|(?<![권제기시])한)$/u;
/** Latin words every technical text has. */
const EN_FILLER = new Set(["https", "http", "www", "com", "json", "code", "true", "false", "null", "the", "and", "for", "with", "this", "that", "not", "use", "new", "file", "api", "src"]);

/**
 * A word as the use test compares it, or null when it cannot tell one memory from another.
 * Document frequency alone does not work at this size: "내용" is in 25 of 1,091 memories.
 * Kept: words with Latin letters or digits of 3+ characters (names, paths, versions, ids) and
 * Korean nouns of 3+ characters once a particle is stripped ("마이그레이션을" → "마이그레이션").
 */
export function useTerm(w: string): string | null {
  if (/^\p{Script=Hangul}+$/u.test(w)) {
    const stem = w.replace(JOSA, "");
    return stem.length >= 3 && !KO_FILLER.has(stem) && !KO_VERBISH.test(stem) ? stem : null;
  }
  // A particle on a Latin word or address ("db는", "10.10.40.70의").
  const bare = w.replace(/(?<=[^\p{Script=Hangul}])(으로|에서|이|가|을|를|은|는|에|의|로|과|와|도|만)$/u, "");
  return bare.length >= 3 && !/^\d+$/.test(bare) && !EN_FILLER.has(bare) ? bare : null;
}
const useTerms = (text: string) => [...new Set(searchWords(text).map(useTerm).filter((w): w is string => w !== null))];

const pending = new Map<string, Pending[]>();

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/**
 * How a prompt and the turn's copy of it are matched. The turn's user text has been redacted and
 * clipped (client 6000, server 4000 characters); /context's prompt has not. Same redaction, then
 * the first KEY_CHARS characters — before any clip — on both sides.
 */
const KEY_CHARS = 1000;
const promptKey = (s: string) => norm(redactSecrets(norm(s))).slice(0, KEY_CHARS);

/** The client kinds the measurement knows; anything else is not recorded. */
const AGENTS = new Set(["pi", "claude-code"]);
export function agentKind(raw: unknown): string | null {
  return typeof raw === "string" && AGENTS.has(raw) ? raw : null;
}

/** Debug mode went off (or never was on): forget everything remembered. */
function off(): boolean {
  if (debugEnabled()) return false;
  pending.clear();
  return true;
}

export function rememberRecall(sessionId: unknown, p: Omit<Pending, "at" | "prompt" | "key"> & { prompt: string }, now = Date.now()) {
  if (off() || typeof sessionId !== "string" || !sessionId || sessionId.length > 200 || !p.recalled.length || !p.prompt.trim()) return;
  const list = (pending.get(sessionId) ?? []).filter((x) => now - x.at <= MAX_AGE_MS);
  list.push({ ...p, prompt: norm(p.prompt), key: promptKey(p.prompt), at: now });
  pending.delete(sessionId); // re-insert: most recently used last
  pending.set(sessionId, list.slice(-MAX_PER_SESSION));
  while (pending.size > MAX_SESSIONS) pending.delete(pending.keys().next().value!);
}

/** Test hook. */
export function resetRecallUse() {
  pending.clear();
}

export interface MemoryUse {
  id: number;
  cited: boolean;
  /** Distinctive words of the memory found in the agent's output. */
  matched: string[];
  /** How many distinctive words the memory had (0 = nothing to look for). */
  distinct: number;
  used: boolean;
}

/**
 * The agent's own output for one prompt: assistant text and tool-call arguments after the user
 * message at `at`, up to the next user message (a batch can hold several prompts: their answers
 * are not this prompt's evidence).
 */
function agentOutput(turn: Turn, at: number): { words: Set<string>; text: string } {
  const parts: string[] = [];
  for (const m of turn.payload.messages.slice(at + 1)) {
    if (m.role === "user") break;
    if (m.role !== "assistant") continue;
    parts.push(m.text);
    for (const c of m.toolCalls ?? []) parts.push(c.args);
  }
  const text = parts.join("\n");
  return { words: new Set(useTerms(text)), text };
}

/**
 * How one recalled memory shows up in the agent's output. Distinctive words: the memory's
 * title, keywords and body words (useTerm) that are in few live memories (DISTINCT_RATIO) and
 * not in the prompt — the agent could not have them from the question alone. An estimate:
 * the matched words are logged so a person can check the verdicts.
 */
export function memoryUse(id: number, prompt: string, out: { words: Set<string>; text: string }, common: (w: string) => boolean): MemoryUse {
  const e = getEntry(id);
  const cited = new RegExp(`#${id}(?!\\d)`).test(out.text);
  if (!e) return { id, cited, matched: [], distinct: 0, used: cited };
  const asked = new Set(useTerms(prompt));
  // Stop at MAX_TERMS: the common-word test reads the corpus once per new word.
  const terms: string[] = [];
  for (const w of useTerms([e.title, e.keywords.join(" "), e.body].join(" "))) {
    if (terms.length >= MAX_TERMS) break;
    if (!asked.has(w) && !common(w)) terms.push(w);
  }
  const matched = terms.filter((w) => out.words.has(w));
  return { id, cited, matched: matched.slice(0, 8), distinct: terms.length, used: cited || matched.length >= USE_MIN_TERMS };
}

/** A turn arrived: log how each prompt of it used what recall gave it. */
export function noteTurnUse(turn: Turn, now = Date.now()) {
  if (off()) return;
  const list = pending.get(turn.session_id);
  if (!list?.length) return;
  const fresh = list.filter((p) => now - p.at <= MAX_AGE_MS);
  const msgs = turn.payload.messages;
  const keys = msgs.map((m) => (m.role === "user" ? promptKey(m.text) : null));
  const left: Pending[] = [];
  let common: ((w: string) => boolean) | undefined;
  // Pending prompts are in the order they were asked: match them to the turn's user messages in
  // order, each message once ("계속" twice pairs with both, not twice with the first).
  let from = 0;
  let firstMatched = -1;
  for (const [i, p] of fresh.entries()) {
    const at = keys.findIndex((k, j) => j >= from && k !== null && k === p.key);
    if (at < 0) {
      left.push(p);
      continue;
    }
    from = at + 1;
    if (firstMatched < 0) firstMatched = i;
    common ??= commonWords(DISTINCT_RATIO, p.projectId);
    const out = agentOutput(turn, at);
    const memories = p.recalled.map((id) => memoryUse(id, p.prompt, out, common!));
    debugLog("recall.use", {
      turn: turn.id,
      session: turn.session_id,
      agent: p.agent,
      project: p.projectId,
      prompt: p.prompt.slice(0, 300),
      memories,
      used: memories.filter((m) => m.used).map((m) => m.id),
    });
  }
  // An unmatched prompt asked before one that matched will not come later: its turn was lost.
  const keep = firstMatched < 0 ? left : left.filter((p) => fresh.indexOf(p) > firstMatched);
  if (keep.length) pending.set(turn.session_id, keep);
  else pending.delete(turn.session_id);
}

// ------------------------------------------------------------------ report

export interface RecallReport {
  days: number;
  from: string;
  to: string;
  /** Prompts with recall (context lines with a non-empty prompt), per client kind ("?" = not sent). */
  prompts: Record<string, number>;
  /** Prompts where recall injected nothing. */
  emptyRecall: number;
  recalled: number;
  /** Search hits by what found them. */
  hits: { keywordOnly: number; vectorOnly: number; both: number };
  /** Candidates the gates dropped (ADR-0046), over `gatedPrompts` prompts that logged it (v0.24.0+). */
  gated: { common: number; minZ: number; keywordMinZ: number };
  gatedPrompts: number;
  /** Graph extras by route kind ("because", "replaces", entity, …). */
  extras: Record<string, number>;
  /** recall.use lines: memories checked and judged used, per client kind. */
  use: Record<string, { prompts: number; memories: number; used: number; cited: number }>;
}

/**
 * The route kind of an extra's "via" label: a link ("because #12", "follows from #3", "replaces #3",
 * "… (2-hop)", see context.ts viaLabel) or, for anything else, an entity's name → "entity".
 */
export function viaKind(via: string): string {
  const m = /^(because|depends_on|supersedes|needs|follows from|replaces) #\d+( \(2-hop\))?$/.exec(via);
  return m ? `${m[1]}${m[2] ? " 2-hop" : ""}` : "entity";
}

/** Sums the debug log of the last `days` days (today included). */
export async function recallReport(days: number, now = new Date()): Promise<RecallReport> {
  const n = Math.min(Math.max(Math.trunc(days) || 14, 1), 60);
  // Calendar days back from today's local date (24-hour steps repeat or skip a day around DST).
  const [y, m, d] = localDate(now.toISOString()).split("-").map(Number);
  const dates = Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10)).reverse();
  const r: RecallReport = {
    days: n,
    from: dates[0],
    to: dates[dates.length - 1],
    prompts: {},
    emptyRecall: 0,
    recalled: 0,
    hits: { keywordOnly: 0, vectorOnly: 0, both: 0 },
    gated: { common: 0, minZ: 0, keywordMinZ: 0 },
    gatedPrompts: 0,
    extras: {},
    use: {},
  };
  for (const date of dates)
    for await (const ev of debugEvents(date, ["context", "recall.use"])) {
      if (ev.type === "context") {
        if (!String(ev.prompt ?? "").trim()) continue;
        const agent = agentKind(ev.agent) ?? "?";
        r.prompts[agent] = (r.prompts[agent] ?? 0) + 1;
        const recalled = Array.isArray(ev.recalled) ? ev.recalled.length : 0;
        r.recalled += recalled;
        if (!recalled) r.emptyRecall++;
        for (const h of Array.isArray(ev.hits) ? (ev.hits as { keyword?: number; similarity?: number }[]) : []) {
          if (h.keyword != null && h.similarity != null) r.hits.both++;
          else if (h.keyword != null) r.hits.keywordOnly++;
          else if (h.similarity != null) r.hits.vectorOnly++;
        }
        const g = ev.gated as Partial<RecallReport["gated"]> | undefined;
        if (g) {
          r.gatedPrompts++;
          for (const k of ["common", "minZ", "keywordMinZ"] as const) r.gated[k] += Number(g[k]) || 0;
        }
        for (const x of Array.isArray(ev.extras) ? (ev.extras as { via?: string }[]) : []) {
          const k = viaKind(String(x.via ?? ""));
          r.extras[k] = (r.extras[k] ?? 0) + 1;
        }
      } else {
        const agent = agentKind(ev.agent) ?? "?";
        const u = (r.use[agent] ??= { prompts: 0, memories: 0, used: 0, cited: 0 });
        u.prompts++;
        for (const m of Array.isArray(ev.memories) ? (ev.memories as MemoryUse[]) : []) {
          u.memories++;
          if (m.used) u.used++;
          if (m.cited) u.cited++;
        }
      }
    }
  return r;
}
