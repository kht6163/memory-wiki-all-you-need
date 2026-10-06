import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { resolveProject, type ProjectRef } from "./project.ts";
import { applySkills, mirroredVersion, skillPaths, skillsRoot, type SkillsPayload, type SyncResult } from "./skills.ts";

// memory-wiki-all-you-need — central memory + LLM wiki for pi.
//
// - before_agent_start: fetches the memory block from the server and puts it
//   into the system prompt (plus memories matching this prompt as a
//   "memory-recall" message, shown as a card), so memory is always in context
//   without the agent asking.
// - message_end: buffers the turn (user prompt, assistant text, tool calls,
//   tool results).
// - agent_settled: once pi is truly idle (no retries, compaction or queued
//   work), waits settleDelayMs and ships the buffered turn to the
//   server, where an LLM curates it into memory. A new prompt before the delay
//   cancels the send and the turns are shipped together later.
// - Tools compatible with pi-hermes-memory: memory_search, session_search,
//   memory_add, memory_replace, memory_remove. Plus wiki_search / wiki_read /
//   wiki_write for the project wiki, which is kept separately from memory.
// - memory_graph: the memory knowledge graph (entities + typed links).
// - /wiki-compose: asks the server LLM to organize this session's turn
//   records into wiki pages.
// - Skills: on every pi start (resources_discover) and on /skills-sync, the
//   server's global skills and this project's are mirrored one way into
//   <agent dir>/extensions/memory-wiki-all-you-need/skills/ and handed to pi
//   (skills.ts). The mirror never uploads a file; offline, the last sync is used.
//   /context carries the server's skills version: when it differs from what
//   this session loaded, the user is told to run /skills-sync.
// - skill_manage (hermes-compatible name): the agent lists, reads, creates and
//   updates skills on the server (never deletes); the server stays canonical and
//   the result is mirrored back. After a run with many tool calls and no
//   skill_manage call, the next prompt carries a hidden hint to consider saving
//   the procedure (skillNudge, 0 = off).
// - Activity cards (showActivity, on by default): memories recalled for a prompt
//   show under it as a "memory_recall" card, and once the server has curated a
//   sent turn, what it added, updated or deleted shows as a "memory_curate" card
//   (an appended session entry: rendered in the transcript, never sent to the model).

// Settings: <agent dir>/extensions/memory-wiki-all-you-need.json (like other pi
// extensions), e.g. {"serverUrl": "http://<server>:8765"}. Env vars override the
// file (MEMORY_SERVER_URL, MEMORY_SETTLE_DELAY_MS, MEMORY_TIMEOUT_MS,
// MEMORY_PROJECT, MEMORY_SKILL_NUDGE, MEMORY_SHOW_ACTIVITY=0|1, MEMORY_DISABLED=1). The install script writes serverUrl; the
// literal below is only the last fallback and the server swaps it for its own
// origin when serving this file (G-008) — keep it the only occurrence.
const DEFAULT_SERVER = "http://127.0.0.1:8765";

export interface MemoryConfig {
  serverUrl?: string;
  settleDelayMs?: number;
  timeoutMs?: number;
  project?: string;
  /** Tool calls in one run (with 2+ different tools) after which the agent is nudged to save a skill; 0 = never. */
  skillNudge?: number;
  /** Show the memory_recall / memory_curate cards in the transcript (default true). */
  showActivity?: boolean;
  disabled?: boolean;
}

export const configPath = () => path.join(getAgentDir(), "extensions", "memory-wiki-all-you-need.json");

/** The settings file, or {} when it is missing or broken (never throws: pi must start anyway). */
export function readConfig(file = configPath()): MemoryConfig {
  try {
    if (!fs.existsSync(file)) return {};
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (err) {
    console.error(`[memory] ignoring ${file}: ${(err as Error).message}`);
    return {};
  }
}

/** Merge into the settings file, keeping keys it does not set. Throws (writes nothing) on a file that is not a JSON object. */
export function writeConfig(patch: MemoryConfig, file = configPath()) {
  let current: MemoryConfig = {};
  if (fs.existsSync(file)) {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
    current = v;
  }
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}

const cleanUrl = (u: string) => u.trim().replace(/\/+$/, "");
/** An env value wins when it is set and not blank; the file's only when it is a number. */
const num = (env: string | undefined, file: unknown, dflt: number) => {
  const n = env?.trim() ? Number(env) : typeof file === "number" ? file : dflt;
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

/** "1/true/on" → true, "0/false/off" → false, anything else → null (not set). */
const boolText = (v: string | undefined): boolean | null => {
  const t = v?.trim().toLowerCase() ?? "";
  if (["true", "on", "yes", "1"].includes(t)) return true;
  if (["false", "off", "no", "0"].includes(t)) return false;
  return null;
};

/** Effective settings: env vars win over the settings file, the file over built-in defaults. */
export function resolveSettings(env: Record<string, string | undefined>, file: MemoryConfig) {
  const envServer = env.MEMORY_SERVER_URL?.trim() ?? "";
  const fileServer = typeof file.serverUrl === "string" ? file.serverUrl.trim() : "";
  return {
    server: cleanUrl(envServer || fileServer || DEFAULT_SERVER),
    source: (envServer ? "env" : fileServer ? "file" : "default") as "env" | "file" | "default",
    envServer,
    settleDelayMs: num(env.MEMORY_SETTLE_DELAY_MS, file.settleDelayMs, 8000),
    timeoutMs: num(env.MEMORY_TIMEOUT_MS, file.timeoutMs, 1500),
    project: env.MEMORY_PROJECT?.trim() || (typeof file.project === "string" ? file.project.trim() : ""),
    skillNudge: num(env.MEMORY_SKILL_NUDGE, file.skillNudge, 8),
    showActivity: boolText(env.MEMORY_SHOW_ACTIVITY) ?? (typeof file.showActivity === "boolean" ? file.showActivity : true),
    disabled: env.MEMORY_DISABLED === "1" || file.disabled === true,
  };
}

const settings = resolveSettings(process.env, readConfig());
let SERVER = settings.server;
let serverSource = settings.source;
let SETTLE_DELAY_MS = settings.settleDelayMs;
let CONTEXT_TIMEOUT_MS = settings.timeoutMs;
let PROJECT_OVERRIDE = settings.project;
let SKILL_NUDGE = settings.skillNudge;
let SHOW_ACTIVITY = settings.showActivity;

/** Re-read env + file after /memory-config or /memory-server changed the file. "disabled" needs /reload. */
function applySettings() {
  const next = resolveSettings(process.env, readConfig());
  SERVER = next.server;
  serverSource = next.source;
  SETTLE_DELAY_MS = next.settleDelayMs;
  CONTEXT_TIMEOUT_MS = next.timeoutMs;
  PROJECT_OVERRIDE = next.project;
  SKILL_NUDGE = next.skillNudge;
  SHOW_ACTIVITY = next.showActivity;
  return next;
}

export type SettingKey = keyof MemoryConfig;
/** The keys /memory-config knows: what they mean, the env var that overrides them, and how a typed value parses. */
export const SETTINGS: Record<SettingKey, { env: string; help: string; parse: (v: string) => MemoryConfig[SettingKey] }> = {
  serverUrl: {
    env: "MEMORY_SERVER_URL",
    help: "memory server URL",
    parse: (v) => {
      const u = new URL(v.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("expected http(s)://<server>:8765");
      return cleanUrl(u.origin + u.pathname);
    },
  },
  timeoutMs: { env: "MEMORY_TIMEOUT_MS", help: "timeout for fetching memory before each request (ms)", parse: (v) => positiveInt(v, 1) },
  settleDelayMs: { env: "MEMORY_SETTLE_DELAY_MS", help: "wait after pi settles before sending the turn (ms)", parse: (v) => positiveInt(v, 0) },
  project: {
    env: "MEMORY_PROJECT",
    help: "fixed project key instead of the git origin",
    parse: (v) => {
      if (!v.trim()) throw new Error("empty project key (use unset to go back to the git origin)");
      return v.trim();
    },
  },
  skillNudge: {
    env: "MEMORY_SKILL_NUDGE",
    help: "after a run with this many tool calls, hint the agent to save the procedure as a skill (0 = off)",
    parse: (v) => positiveInt(v, 0),
  },
  showActivity: {
    env: "MEMORY_SHOW_ACTIVITY",
    help: "show recalled memories and curation results as cards in the conversation",
    parse: (v) => {
      const b = boolText(v);
      if (b === null) throw new Error("expected true or false");
      return b;
    },
  },
  disabled: {
    env: "MEMORY_DISABLED",
    help: "turn the extension off (applies after /reload; /memory-config disabled false turns it back on)",
    parse: (v) => {
      const b = boolText(v);
      if (b === null) throw new Error("expected true or false");
      return b;
    },
  },
};
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

/** Whether the env var really overrides the file for this key (same rules as resolveSettings). */
export function envOverrides(key: SettingKey, env: Record<string, string | undefined> = process.env): string | null {
  const v = env[SETTINGS[key].env]?.trim();
  if (!v) return null;
  if (key === "disabled") return v === "1" ? v : null;
  if (key === "showActivity") return boolText(v) === null ? null : v;
  return v;
}

function positiveInt(v: string, min: number): number {
  const n = Number(v.trim());
  if (!Number.isInteger(n) || n < min) throw new Error(`expected a whole number ≥ ${min}`);
  return n;
}

/** Current value of a key as shown to people, with where it comes from. */
function describeSetting(key: SettingKey): string {
  const file = readConfig();
  const env = envOverrides(key);
  const eff = resolveSettings(process.env, file);
  const value =
    key === "serverUrl" ? eff.server : key === "timeoutMs" ? eff.timeoutMs : key === "settleDelayMs" ? eff.settleDelayMs : key === "project" ? eff.project || "(git origin)" : key === "skillNudge" ? eff.skillNudge : key === "showActivity" ? eff.showActivity : eff.disabled;
  const from = env ? `env ${SETTINGS[key].env}` : file[key] !== undefined ? "settings file" : "default";
  return `${key} = ${value}  (${from})`;
}

/** Autocomplete for /memory-config: keys, "unset <key>", and true/false for disabled / showActivity. */
export function configCompletions(prefix: string): { value: string; label: string; description?: string }[] | null {
  const parts = prefix.split(/\s+/);
  if (parts.length <= 1) {
    const items = [...SETTING_KEYS.map((k) => ({ value: `${k} `, label: k, description: SETTINGS[k].help })), { value: "unset ", label: "unset", description: "remove a key from the settings file" }];
    const hits = items.filter((i) => i.label.startsWith(parts[0] ?? ""));
    return hits.length ? hits : null;
  }
  if (parts[0] === "unset" && parts.length === 2) {
    const hits = SETTING_KEYS.filter((k) => k.startsWith(parts[1])).map((k) => ({ value: `unset ${k}`, label: k }));
    return hits.length ? hits : null;
  }
  if ((parts[0] === "disabled" || parts[0] === "showActivity") && parts.length === 2) {
    const hits = ["true", "false"].filter((v) => v.startsWith(parts[1])).map((v) => ({ value: `${parts[0]} ${v}`, label: v }));
    return hits.length ? hits : null;
  }
  return null;
}
const MAX_BUFFER = 600;
/** How long a sent turn is watched for its curation result (memory_curate card). */
const WATCH_MS = 10 * 60_000;
const TURN_STATUSES = new Set(["pending", "processing", "done", "skipped", "error"]);

interface TurnMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: { name: string; args: string }[];
  name?: string;
  isError?: boolean;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED:private-key]"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED:key]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED:github-token]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED:slack-token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED:jwt]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, "Bearer [REDACTED]"],
];
const redact = (s: string) => SECRET_PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [truncated]` : s);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function toTurnMessage(msg: unknown): TurnMessage | null {
  const m = msg as { role?: string; content?: unknown; toolName?: string; isError?: boolean };
  if (m.role === "user") {
    const text = textOf(m.content).trim();
    return text ? { role: "user", text: redact(clip(text, 6000)) } : null;
  }
  if (m.role === "assistant") {
    const parts = Array.isArray(m.content) ? m.content : [];
    const toolCalls = parts
      .filter((p): p is { type: "toolCall"; name: string; arguments: unknown } => p?.type === "toolCall")
      .map((p) => ({ name: p.name, args: redact(clip(JSON.stringify(p.arguments ?? {}), 800)) }));
    const text = textOf(parts).trim();
    if (!text && !toolCalls.length) return null;
    return { role: "assistant", text: redact(clip(text, 6000)), ...(toolCalls.length ? { toolCalls } : {}) };
  }
  if (m.role === "toolResult") {
    return { role: "tool", name: m.toolName ?? "?", isError: Boolean(m.isError), text: redact(clip(textOf(m.content), 2000)) };
  }
  return null;
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

interface EntryLite {
  id: number;
  scope: string;
  category: string;
  title: string;
  body: string;
  tags: string[];
}

function fmtEntries(entries: EntryLite[]): string {
  if (!entries.length) return "No matching memories.";
  return entries
    .map((e) => `#${e.id} [${e.scope}/${e.category}] ${e.title}${e.body ? `\n  ${e.body.replace(/\n/g, "\n  ")}` : ""}`)
    .join("\n");
}

// ------------------------------------------------------- activity cards

/** What the "memory_recall" card shows (stored in the hidden-from-model `details`). */
export interface RecallCard {
  entries: { id: number; title: string }[];
}
/** What the "memory_curate" card shows (an appended session entry). */
export interface CurationCard {
  turnId: number;
  applied: { op: "add" | "update" | "delete"; entryId: number; title: string }[];
  skipped: number;
}

const CARD_OPS = new Set(["add", "update", "delete"]);
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * The recall card for a /context reply, or null when nothing was recalled.
 * Titles come from recalledEntries; an older server only sends ids (or nothing), so
 * the ids fall back to the "- [#id] title" lines of the recall block itself.
 */
export function recallCard(res: { recall?: unknown; recalled?: unknown; recalledEntries?: unknown }): RecallCard | null {
  if (typeof res.recall !== "string" || !res.recall.trim()) return null;
  let entries: RecallCard["entries"] = [];
  if (Array.isArray(res.recalledEntries)) {
    entries = res.recalledEntries
      .filter(isObj)
      .filter((e) => typeof e.id === "number")
      .map((e) => ({ id: e.id as number, title: typeof e.title === "string" ? e.title : "" }));
  }
  if (!entries.length) {
    for (const m of res.recall.matchAll(/^- \[#(\d+)\] (.*)$/gm)) entries.push({ id: Number(m[1]), title: m[2].split(": ")[0] });
  }
  return entries.length ? { entries } : null;
}

/** The curation card for a finished turn, or null when it changed no memory (confirm-only, nothing, an error). */
export function curationCard(turnId: number, status: unknown, result: unknown): CurationCard | null {
  if (status !== "done" || !isObj(result)) return null;
  const applied = (Array.isArray(result.applied) ? result.applied : [])
    .filter(isObj)
    .filter((a) => typeof a.op === "string" && CARD_OPS.has(a.op) && typeof a.entryId === "number")
    .map((a) => ({ op: a.op as CurationCard["applied"][number]["op"], entryId: a.entryId as number, title: typeof a.title === "string" ? a.title : "" }));
  if (!applied.length) return null;
  // Only exact duplicates are worth a line; refused edits are in skipped too (worker.ts).
  const skipped = Array.isArray(result.skipped) ? result.skipped.filter((x) => isObj(x) && x.reason === "duplicate").length : 0;
  return { turnId, applied, skipped };
}

/** One-line summary of a recall card: "2 memories · A, B". */
export function recallSummary(card: RecallCard): string {
  const titles = card.entries.map((e) => e.title || `#${e.id}`);
  const n = card.entries.length;
  return `${n} ${n === 1 ? "memory" : "memories"} · ${titles.join(", ")}`;
}

/** One-line summary of a curation card: "1 added · 2 updated · 1 deleted". */
export function curationSummary(card: CurationCard): string {
  const n = (op: string) => card.applied.filter((a) => a.op === op).length;
  const parts = [
    [n("add"), "added"],
    [n("update"), "updated"],
    [n("delete"), "deleted"],
  ]
    .filter(([c]) => (c as number) > 0)
    .map(([c, w]) => `${c} ${w}`);
  return parts.join(" · ");
}

const OP_MARK = { add: "+", update: "~", delete: "-" } as const;

/** Card lines (summary first; the rest only when expanded, like a tool result). */
export function cardLines(kind: "recall" | "curate", data: unknown, expanded: boolean): { title: string; summary: string; detail: string[] } | null {
  if (kind === "recall") {
    if (!isObj(data) || !Array.isArray(data.entries)) return null;
    const card = data as unknown as RecallCard;
    if (!card.entries.length) return null;
    return {
      title: "memory_recall",
      summary: recallSummary(card),
      detail: expanded ? card.entries.map((e) => `#${e.id} ${e.title}`) : [],
    };
  }
  if (!isObj(data) || !Array.isArray(data.applied) || !data.applied.length) return null;
  const card = data as unknown as CurationCard;
  return {
    title: "memory_curate",
    summary: curationSummary(card),
    detail: expanded
      ? [
          ...card.applied.map((a) => `${OP_MARK[a.op] ?? "?"} #${a.entryId} ${a.title}`),
          ...(card.skipped ? [`(${card.skipped} skipped as duplicates)`] : []),
          `turn #${card.turnId}`,
        ]
      : [],
  };
}

const expandHint = () => {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "ctrl+o to expand";
  }
};

/** A tool-call-like card (same box and colors as pi's own tool results). */
function renderCard(kind: "recall" | "curate", data: unknown, expanded: boolean, theme: any) {
  const lines = cardLines(kind, data, expanded);
  if (!lines) return undefined;
  const box = new Box(1, 1, (t: string) => theme.bg("toolSuccessBg", t));
  let body = `${theme.fg("toolTitle", theme.bold(lines.title))} ${theme.fg("muted", lines.summary)}`;
  if (lines.detail.length) body += `\n${lines.detail.map((l) => theme.fg("toolOutput", l)).join("\n")}`;
  else body += theme.fg("dim", ` (${expandHint()})`);
  box.addChild(new Text(body, 0, 0));
  return box;
}

const SOURCE_LABEL = { env: "MEMORY_SERVER_URL", file: "settings file", default: "built-in default" } as const;
const isSettingKey = (k: string): k is SettingKey => (SETTING_KEYS as string[]).includes(k);
const unreachableHint = () =>
  serverSource === "env" ? "" : `\nSet the server with /memory-server http://<server>:8765 (saved to ${configPath()})`;

export default function memoryAllYouNeed(pi: ExtensionAPI) {
  // Display only, no server: registered even when the extension is off, so a resumed
  // session's cards never fall back to pi's raw "[memory-recall]" box.
  pi.registerMessageRenderer("memory-recall", (message, options, theme) => renderCard("recall", message.details, options.expanded, theme));
  pi.registerEntryRenderer("memory-curate", (entry, options, theme) => renderCard("curate", entry.data, options.expanded, theme));
  if (resolveSettings(process.env, readConfig()).disabled) {
    // Off: register nothing but a /memory-config that can turn it back on.
    pi.registerCommand("memory-config", {
      description: "memory extension is off — /memory-config disabled false, then /reload",
      getArgumentCompletions: (prefix) => configCompletions(prefix),
      handler: async (args, ctx) => {
        const [first = "", second = ""] = args.trim().split(/\s+/);
        const key = first === "unset" ? second : first;
        const raw = args.trim().slice(first.length).trim();
        if (!isSettingKey(key) || (first !== "unset" && !raw)) {
          ctx.ui.notify(
            envOverrides("disabled")
              ? "memory extension is off: MEMORY_DISABLED=1 is set in this shell — unset it and restart pi"
              : `memory extension is off (${configPath()}). Turn it on: /memory-config disabled false, then /reload`,
            "info",
          );
          return;
        }
        try {
          writeConfig({ [key]: first === "unset" ? undefined : SETTINGS[key].parse(raw) } as MemoryConfig);
        } catch (err) {
          ctx.ui.notify(`could not update ${key}: ${(err as Error).message}`, "error");
          return;
        }
        ctx.ui.notify(`${key} saved to ${configPath()} — run /reload to apply`, "info");
      },
    });
    return;
  }

  let sessionId = "";
  let cwd = process.cwd();
  let project: ProjectRef | null = null;
  let cachedSystem = "";
  let buffer: TurnMessage[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let warned = false;
  // Skills: the server version this session loaded (null = never synced here),
  // the newer one already reported, and this run's tool calls for the nudge.
  let loadedSkillsVersion: string | null = null;
  let skillsStale = false;
  let notifiedSkillsVersion = "";
  let runToolCalls = 0;
  const runTools = new Set<string>();
  let runUsedSkills = false;
  let skillHint = "";
  // Activity cards: only with a UI, and a curation result only lands in the session that
  // sent the turn (session_start/shutdown bump the generation; older watchers stop).
  let hasUI = false;
  let generation = 0;
  const watchers = new Set<ReturnType<typeof setTimeout>>();

  const projectBody = () => (project ? { key: project.key, name: project.name, remote: project.remote } : null);

  const setStatus = (ctx: ExtensionContext, msg: string | undefined) => {
    if (ctx.hasUI) ctx.ui.setStatus("memory", msg);
  };
  const okStatus = () => `${project ? `🧠 ${project.name}` : "🧠 global"}${skillsStale ? " · skills changed: /skills-sync" : ""}`;

  const cancelFlush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  };

  /** Send the buffered turn; `watch` = show its curation result as a card once the server is done. */
  async function flush(watch = true) {
    cancelFlush();
    const gen = generation; // a shutdown during the POST must not start a watcher for a gone session
    if (!buffer.some((m) => m.role === "user" || m.role === "assistant")) {
      buffer = [];
      return;
    }
    const messages = buffer;
    buffer = [];
    try {
      const sent = await call<{ id?: number }>("POST", "/turns", { sessionId, project: projectBody(), client: os.hostname(), cwd, messages });
      if (watch && gen === generation && typeof sent.id === "number") watchTurn(sent.id);
    } catch (err) {
      // Keep the turn for the next attempt, bounded so a dead server cannot grow memory forever.
      buffer = [...messages, ...buffer].slice(-MAX_BUFFER);
      console.error(`[memory] failed to send turn: ${(err as Error).message}`);
    }
  }

  /**
   * Poll the turn until the server has curated it, then append a memory_curate card when
   * memories changed. Every 3s for the first 30s, then every 10s, for at most WATCH_MS;
   * three failed polls in a row (old server without the route, server down, a reply
   * without a known status) give up, and so does a switch to another server.
   * Never throws and never blocks pi.
   */
  function watchTurn(id: number) {
    if (!SHOW_ACTIVITY || !hasUI) return;
    const gen = generation;
    const server = SERVER; // turn ids are per server: a /memory-server switch ends the watch
    const started = Date.now();
    let failures = 0;
    const schedule = () => {
      const elapsed = Date.now() - started;
      if (elapsed > WATCH_MS) return;
      const timer = setTimeout(() => {
        watchers.delete(timer);
        void tick();
      }, elapsed < 30_000 ? 3_000 : 10_000);
      timer.unref?.();
      watchers.add(timer);
    };
    const tick = async () => {
      if (gen !== generation || server !== SERVER) return;
      let t: { status?: string; result?: unknown } | null = null;
      try {
        t = await call<{ status?: string; result?: unknown }>("GET", `/turns/${id}/status`, undefined, 5000);
      } catch {
        t = null;
      }
      // Anything but a known status counts as a failure: an old server without the route
      // answers 404, or 200 with the web UI's index.html (call() makes that {}).
      if (!t || !TURN_STATUSES.has(String(t.status))) {
        if (++failures >= 3) return;
        t = null;
      } else failures = 0;
      if (gen !== generation || server !== SERVER || !SHOW_ACTIVITY) return;
      if (t?.status === "done" || t?.status === "skipped" || t?.status === "error") {
        const card = curationCard(id, t.status, t.result);
        if (card) {
          try {
            pi.appendEntry("memory-curate", card);
          } catch (err) {
            console.error(`[memory] could not show the curation result: ${(err as Error).message}`);
          }
        }
        return;
      }
      schedule();
    };
    schedule();
  }

  const stopWatchers = () => {
    generation++;
    for (const t of watchers) clearTimeout(t);
    watchers.clear();
  };

  pi.on("session_start", async (_event, ctx) => {
    stopWatchers();
    hasUI = ctx.hasUI;
    sessionId = ctx.sessionManager.getSessionId();
    cwd = ctx.cwd;
    project = resolveProject(cwd, PROJECT_OVERRIDE);
    buffer = [];
    setStatus(ctx, okStatus());
  });

  // ------------------------------------------------------------- skills

  const skillRoot = () => skillsRoot(getAgentDir());
  /** Fetch the server's skills and mirror them; throws when the server or the disk fails. */
  async function syncSkills(key: string | null, timeoutMs: number): Promise<SyncResult> {
    const q = key ? `?${new URLSearchParams({ project: key })}` : "";
    const payload = await call<SkillsPayload>("GET", `/skills/sync${q}`, undefined, timeoutMs);
    return applySkills(skillRoot(), payload, key, SERVER);
  }

  pi.on("resources_discover", async (event) => {
    // Never throws: a dead server, an old server without /skills/sync (404) or a
    // read-only disk leave the last synced skills in place.
    try {
      const key = resolveProject(event.cwd, PROJECT_OVERRIDE)?.key ?? null;
      // /skills-sync has just synced and asked pi to reload: do not fetch twice.
      const g = globalThis as { __memoryWikiSkillsSyncedAt?: number };
      let synced: SyncResult | null = null;
      if (Date.now() - (g.__memoryWikiSkillsSyncedAt ?? 0) > 10_000) {
        try {
          synced = await syncSkills(key, CONTEXT_TIMEOUT_MS);
        } catch (err) {
          console.error(`[memory] skills not synced, using the last copy: ${(err as Error).message}`);
        }
      }
      // What this session now loads; compared with /context's skillsVersion before each request.
      // From the sync itself when there was one (versions.json is shared with other pi processes).
      loadedSkillsVersion = synced ? synced.version : mirroredVersion(skillRoot(), key);
      const paths = skillPaths(skillRoot(), key);
      return paths.length ? { skillPaths: paths } : undefined;
    } catch (err) {
      console.error(`[memory] skills unavailable: ${(err as Error).message}`);
      return undefined;
    }
  });

  /** The server's skills differ from the ones this session loaded: say so once per version, and in the status line. */
  function checkSkills(ctx: ExtensionContext, version: unknown) {
    if (typeof version !== "string") return; // a server without skills
    const stale = version !== (loadedSkillsVersion ?? "");
    if (stale && version !== notifiedSkillsVersion && ctx.hasUI) {
      ctx.ui.notify(`the memory server's skills changed — run /skills-sync to load them (${SERVER})`, "info");
    }
    if (stale) notifiedSkillsVersion = version;
    skillsStale = stale;
  }

  pi.on("before_agent_start", async (event, ctx) => {
    cancelFlush();
    let recall = "";
    let card: RecallCard | null = null;
    try {
      const res = await call<{ system: string; recall: string; recalled?: number[]; recalledEntries?: unknown; skillsVersion?: string }>(
        "POST",
        "/context",
        { project: projectBody(), prompt: event.prompt },
        CONTEXT_TIMEOUT_MS,
      );
      cachedSystem = res.system;
      recall = res.recall;
      card = SHOW_ACTIVITY && ctx.hasUI ? recallCard(res) : null;
      const wasStale = skillsStale;
      checkSkills(ctx, res.skillsVersion);
      if (warned || wasStale !== skillsStale) setStatus(ctx, okStatus());
      warned = false;
    } catch (err) {
      if (!warned && ctx.hasUI) ctx.ui.notify(`memory server unreachable (${SERVER}): ${(err as Error).message}${unreachableHint()}`, "warning");
      warned = true;
      setStatus(ctx, "🧠 offline");
    }
    if (cachedSystem) {
      event.systemPromptOptions.sections = { ...(event.systemPromptOptions.sections ?? {}), "memory-context": cachedSystem };
    }
    const hint = skillHint;
    skillHint = "";
    const content = [recall, hint].filter(Boolean).join("\n");
    // Shown (as a memory_recall card, see the renderer) only when memories were recalled;
    // a hint alone stays hidden. The model gets `content` either way, never `details`.
    if (content) return { message: { customType: "memory-recall", content, display: Boolean(card), ...(card ? { details: card } : {}) } };
    return undefined;
  });

  pi.on("message_end", async (event) => {
    const m = toTurnMessage(event.message);
    if (m) buffer.push(m);
    for (const t of m?.toolCalls ?? []) {
      runToolCalls++;
      runTools.add(t.name);
      if (t.name === "skill_manage") runUsedSkills = true;
    }
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  });

  pi.on("agent_settled", async () => {
    // A long, varied run that saved no skill: the next prompt carries a hint (hermes-style nudge).
    if (SKILL_NUDGE > 0 && runToolCalls >= SKILL_NUDGE && runTools.size >= 2 && !runUsedSkills) {
      skillHint =
        `<skill-hint note="From the memory extension, not the user.">Your previous task took ${runToolCalls} tool calls (${[...runTools].slice(0, 8).join(", ")}). ` +
        "If it was a procedure likely to recur and no skill covers it yet, save it with skill_manage after handling this request; " +
        "if a skill you followed was wrong or incomplete, update it. Otherwise ignore this note.</skill-hint>";
    }
    runToolCalls = 0;
    runTools.clear();
    runUsedSkills = false;
    cancelFlush();
    flushTimer = setTimeout(() => void flush(), SETTLE_DELAY_MS);
  });

  pi.on("session_shutdown", async () => {
    stopWatchers();
    await flush(false);
  });

  // ---------------------------------------------------------------- tools

  const target = Type.Union([Type.Literal("memory"), Type.Literal("user"), Type.Literal("project"), Type.Literal("failure")], {
    description: 'memory = global facts for every project, user = about the user, project = this repository only, failure = what did not work and why',
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory search",
    description:
      "Search the persistent memory (this project + global + user profile) for conventions, decisions, past failures, preferences and environment facts. Use before acting when earlier context may matter.",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords or a natural-language question" }),
      scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("project"), Type.Literal("global"), Type.Literal("user")])),
      category: Type.Optional(Type.String({ description: "fact, convention, preference, decision, failure, correction, insight, tool-quirk" })),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, p) {
      const q = new URLSearchParams({ q: p.query, limit: String(p.limit ?? 10), via: "agent" });
      if (project) q.set("project", project.key);
      if (p.scope && p.scope !== "all") q.set("scope", p.scope);
      if (p.category) q.set("category", p.category);
      return text(fmtEntries(await call<EntryLite[]>("GET", `/search?${q}`)));
    },
  });

  pi.registerTool({
    name: "session_search",
    label: "Session search",
    description: "Search past conversation turns (prompts and answers) from earlier sessions on any machine.",
    parameters: Type.Object({
      query: Type.String(),
      all_projects: Type.Optional(Type.Boolean({ description: "Search every project instead of only the current one" })),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, p) {
      const q = new URLSearchParams({ q: p.query, limit: String(p.limit ?? 8) });
      if (project && !p.all_projects) q.set("project", project.key);
      const hits = await call<{ id: number; project_name: string | null; created_at: string; snippet: string }[]>("GET", `/session-search?${q}`);
      if (!hits.length) return text("No matching past turns.");
      return text(hits.map((h) => `turn #${h.id} · ${h.project_name ?? "no project"} · ${h.created_at.slice(0, 16)}\n  ${h.snippet}`).join("\n"));
    },
  });

  pi.registerTool({
    name: "memory_graph",
    label: "Memory graph",
    description:
      "Explore the memory graph. entity: everything remembered about a technology/service/tool/file (e.g. \"PostgreSQL\", \"docker compose\") plus co-occurring entities. id: one memory with its entities and typed links (because, depends_on, supersedes, related) — why it exists and what it depends on.",
    parameters: Type.Object({
      entity: Type.Optional(Type.String({ description: "Entity name, e.g. PostgreSQL" })),
      id: Type.Optional(Type.Number({ description: "Memory id, e.g. 12 for [#12]" })),
    }),
    async execute(_id, p) {
      if (!p.entity && !p.id) return text("Give an entity name or a memory id.");
      const q = new URLSearchParams({ via: "agent" });
      if (p.entity) q.set("entity", p.entity);
      if (p.id) q.set("id", String(p.id));
      if (project) q.set("project", project.key);
      type Mem = EntryLite & { scope: string };
      const r = await call<
        | { kind: "entity"; entity: { name: string; kind: string; description: string }; memories: Mem[]; related: { name: string; count?: number }[] }
        | {
            kind: "memory";
            memory: Mem;
            entities: { name: string; kind: string }[];
            links: { dir: "out" | "in"; type: string; other: { id: number; title: string; category: string } }[];
          }
      >("GET", `/graph/neighbors?${q}`);
      if (r.kind === "entity") {
        const head = `${r.entity.name} (${r.entity.kind})${r.entity.description ? ` — ${r.entity.description}` : ""}`;
        const rel = r.related.length ? `\nRelated entities: ${r.related.map((x) => x.name).join(", ")}` : "";
        return text(`${head}\n\n${fmtEntries(r.memories)}${rel}`);
      }
      const verb = (l: { dir: string; type: string }) =>
        l.dir === "out" ? { because: "because of", depends_on: "depends on", supersedes: "replaces", related: "related to" }[l.type] : { because: "is the reason for", depends_on: "is needed by", supersedes: "was replaced by", related: "related to" }[l.type];
      const links = r.links.map((l) => `  ${verb(l) ?? l.type} #${l.other.id} [${l.other.category}] ${l.other.title}`).join("\n");
      return text(
        `${fmtEntries([r.memory])}\nEntities: ${r.entities.map((e) => e.name).join(", ") || "(none)"}${links ? `\nLinks:\n${links}` : "\nLinks: (none)"}`,
      );
    },
  });

  pi.registerTool({
    name: "wiki_search",
    label: "Wiki search",
    description:
      "Search the long-form wiki (this project's wiki + the global wiki): overview, architecture, conventions, decisions, procedures, troubleshooting. Returns page slugs and snippets; open one with wiki_read.",
    parameters: Type.Object({
      query: Type.String(),
      all_projects: Type.Optional(Type.Boolean({ description: "Search every project's wiki" })),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, p) {
      const q = new URLSearchParams({ q: p.query, limit: String(p.limit ?? 8) });
      if (p.all_projects) q.set("all", "1");
      else if (project) q.set("project", project.key);
      const hits = await call<{ slug: string; title: string; project_id: number | null; snippet: string }[]>("GET", `/wiki/search?${q}`);
      if (!hits.length) return text("No matching wiki pages.");
      return text(hits.map((h) => `${h.project_id == null ? "global:" : ""}${h.slug} — ${h.title}\n  ${h.snippet}`).join("\n"));
    },
  });

  pi.registerTool({
    name: "wiki_read",
    label: "Wiki read",
    description: 'Read a wiki page by slug (see <wiki-pages> in the system prompt). Prefix "global:" for a global wiki page.',
    parameters: Type.Object({ slug: Type.String() }),
    async execute(_id, p) {
      const q = new URLSearchParams({ slug: p.slug });
      if (project) q.set("project", project.key);
      const page = await call<{ title: string; body: string; updated_at: string }>("GET", `/wiki/read?${q}`);
      return text(`# ${page.title}\n(updated ${page.updated_at.slice(0, 10)}; [[slug]] = wiki link, [#id] = memory reference)\n\n${page.body}`);
    },
  });

  pi.registerTool({
    name: "wiki_write",
    label: "Wiki write",
    description:
      "Create or update a wiki page. Only when the user asks to document something in the wiki. Updating: read the page with wiki_read first, then send the full new body (mode replace) or just a new section (mode append). Pages form a tree: give a new page a \"parent\" when it belongs under an existing page. Write for people: a 1-3 sentence summary first; ## sections and ### subsections (they become the table of contents; no manual TOC); tables for anything with repeated fields (settings, comparisons, versions, commands); numbered steps for procedures; short paragraphs, no walls of text; no '# Title' line; link pages with [[slug]].",
    parameters: Type.Object({
      slug: Type.String({ description: "Page slug, e.g. architecture, deploy, troubleshooting" }),
      title: Type.Optional(Type.String({ description: "Page title (required when creating)" })),
      body: Type.String({ description: "Markdown body" }),
      mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append")], { description: "For an existing page. Default replace" })),
      global: Type.Optional(Type.Boolean({ description: "Write to the global wiki instead of this project's" })),
      reason: Type.Optional(Type.String({ description: "Short change note for the page history" })),
      parent: Type.Optional(
        Type.String({ description: "Slug of an existing page in the same wiki to put this page under (pages form a tree); empty string = top level; omit to leave it where it is" }),
      ),
    }),
    async execute(_id, p) {
      const res = await call<{ action: string; page: { slug: string; title: string; project_id: number | null } }>("POST", "/agent/wiki", {
        ...p,
        project: projectBody(),
      });
      return text(`${res.action}: ${res.page.project_id == null ? "global:" : ""}${res.page.slug} — ${res.page.title}`);
    },
  });

  const memoryCall = async (body: Record<string, unknown>) => {
    const res = await call<{ action: string; entry: EntryLite }>("POST", "/agent/memory", { ...body, project: projectBody() });
    return text(`${res.action}: #${res.entry.id} [${res.entry.scope}/${res.entry.category}] ${res.entry.title}`);
  };

  pi.registerTool({
    name: "memory_add",
    label: "Memory add",
    description: "Save a durable memory. Only when the user explicitly asks to remember something; turns are curated automatically otherwise.",
    parameters: Type.Object({
      target,
      content: Type.String({ description: "The fact, self-contained. First line may be a short title." }),
      title: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
    }),
    execute: (_id, p) => memoryCall({ action: "add", ...p }),
  });

  pi.registerTool({
    name: "memory_replace",
    label: "Memory replace",
    description: "Replace an existing memory, found by a unique substring of its text.",
    parameters: Type.Object({ target, old_text: Type.String(), content: Type.String(), title: Type.Optional(Type.String()) }),
    execute: (_id, p) => memoryCall({ action: "replace", ...p }),
  });

  pi.registerTool({
    name: "memory_remove",
    label: "Memory remove",
    description: "Delete an existing memory, found by a unique substring of its text.",
    parameters: Type.Object({ target, old_text: Type.String() }),
    execute: (_id, p) => memoryCall({ action: "remove", ...p }),
  });

  // skill_manage: same name and structured fields as pi-hermes-memory, but the
  // skill lives on the memory server; the result is mirrored back to this PC.
  const list = (items: unknown, ordered: boolean) =>
    (Array.isArray(items) ? items : [])
      .filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .map((x, i) => `${ordered ? `${i + 1}.` : "-"} ${x.trim()}`)
      .join("\n");
  /** A SKILL.md body from `body`, or from the structured fields (When to Use / Procedure / Pitfalls / Verification). */
  function skillBody(p: { body?: string; when_to_use?: string; procedure_steps?: string[]; pitfalls?: string[]; verification_steps?: string[] }): string | undefined {
    if (p.body?.trim()) return p.body.trim();
    const steps = list(p.procedure_steps, true);
    if (!steps) return undefined;
    return [
      p.when_to_use?.trim() && `## When to Use\n${p.when_to_use.trim()}`,
      steps && `## Procedure\n${steps}`,
      list(p.pitfalls, false) && `## Pitfalls\n${list(p.pitfalls, false)}`,
      list(p.verification_steps, true) && `## Verification\n${list(p.verification_steps, true)}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  type AgentSkill = {
    scope: "global" | "project";
    name: string;
    description: string;
    body?: string;
    author: string;
    updated_at: string;
    /** candidate = an agent skill waiting for a person's approval (not on any PC yet). */
    status?: "active" | "candidate";
    locked?: boolean;
    /** list: whether an agent edit waits for approval; view: that edit. */
    pending_edit?: boolean | { description: string; body: string; at: string } | null;
  };
  const flags = (k: AgentSkill) =>
    [k.status === "candidate" && "candidate: waiting for approval", k.locked && "locked", k.pending_edit && "edit waiting for approval"].filter(Boolean).join(", ");

  pi.registerTool({
    name: "memory_review",
    label: "Memory review",
    description:
      "The memory review's pending proposals for this project and global memory (the server's LLM review of stored memories). list: what is pending. view: one proposal with its memories in full. resolve: settle a CONFLICT (memories that disagree) — first verify the facts against the real code, config or environment (read the files, run the commands), fix the wrong memory with memory_replace or remove it with memory_remove, then resolve with a note saying what you checked and which memory was right. Never resolve without checking. Merges, updates and deletes are applied by a person in the web UI.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("view"), Type.Literal("resolve")]),
      id: Type.Optional(Type.Number({ description: "Proposal id (view, resolve), e.g. 329 for #329" })),
      note: Type.Optional(Type.String({ description: "resolve: what you checked (command, file, result) and which memory was right" })),
    }),
    async execute(_id, p) {
      const r = await call<{ text?: string }>("POST", "/agent/review", { action: p.action, id: p.id, note: p.note, project: projectBody() });
      return text(r.text ?? JSON.stringify(r));
    },
  });

  pi.registerTool({
    name: "skill_manage",
    label: "Skill manage",
    description:
      "Manage reusable procedures (pi skills) kept on the memory server and synced to every PC: list, view, create, update. Skills capture HOW to do something (deploy, release, debug, migrate), not facts — facts go to memory. Deleting is done by the user on the memory server's web UI.",
    promptSnippet: "List, read, create and update reusable procedures (skills) on the memory server",
    promptGuidelines: [
      "Use skill_manage after finishing a task that took trial and error or many tool calls and is likely to recur, or when the user teaches you a workflow; skip one-off task state.",
      "create needs scope: 'project' when the procedure depends on this repository's paths, scripts or deploy flow, 'global' when it transfers to other repositories.",
      "Put the trigger signals a user would actually type (task names, error strings, symptoms) in description: pi picks skills by name and description alone.",
      "Prefer the structured fields (when_to_use, procedure_steps, pitfalls, verification_steps) over a free-form body.",
      "To change a skill, view it first, then update with the updated_at you saw (send the full new body or all structured fields).",
      "A skill can wait for a person's approval (a candidate, or an edit waiting for approval): do not create or send it again. A locked skill can only be changed by people.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("view"), Type.Literal("create"), Type.Literal("update")]),
      name: Type.Optional(Type.String({ description: "Skill name: lowercase letters, digits, single hyphens, e.g. deploy-release" })),
      scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")], { description: "Required for create. For view/update: which one when both exist (default: this project's)" })),
      description: Type.Optional(Type.String({ description: "What it does and when to use it, with trigger phrases; one line, max 1024 characters. Required for create" })),
      when_to_use: Type.Optional(Type.String()),
      procedure_steps: Type.Optional(Type.Array(Type.String(), { description: "Ordered concrete steps" })),
      pitfalls: Type.Optional(Type.Array(Type.String())),
      verification_steps: Type.Optional(Type.Array(Type.String(), { description: "Checks that prove it worked" })),
      body: Type.Optional(Type.String({ description: "Free-form Markdown body instead of the structured fields" })),
      updated_at: Type.Optional(Type.String({ description: "Required for update: the updated_at from view" })),
    }),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      const body = p.action === "create" || p.action === "update" ? skillBody(p) : undefined;
      if (p.action === "create" && !body) return text("create needs procedure_steps (with when_to_use, pitfalls, verification_steps) or a body.");
      if (p.action === "update" && !body) {
        const partial = Boolean(p.when_to_use?.trim() || p.pitfalls?.length || p.verification_steps?.length);
        if (partial) return text("update replaces the whole body: send procedure_steps together with when_to_use, pitfalls and verification_steps (view the skill first), or a full body. Nothing was changed.");
        if (p.description === undefined) return text("update needs a new body (or procedure_steps) and/or description. Nothing was changed.");
      }
      const res = await call<{
        action: string;
        skills?: AgentSkill[];
        skill?: AgentSkill;
        version?: string;
        previous_version?: string;
        changed?: boolean;
        proposed?: boolean;
      }>("POST", "/agent/skill", {
        action: p.action,
        name: p.name,
        scope: p.scope,
        description: p.description,
        body,
        updated_at: p.updated_at,
        project: projectBody(),
      });
      if (res.skills) {
        if (!res.skills.length) return text("No skills yet.");
        return text(res.skills.map((k) => `${k.scope}:${k.name} — ${k.description} (by ${k.author}, updated_at ${k.updated_at}${flags(k) ? `; ${flags(k)}` : ""})`).join("\n"));
      }
      const k = res.skill!;
      if (res.action === "view") {
        const pending = typeof k.pending_edit === "object" && k.pending_edit ? `\n\n--- edit waiting for approval ---\n${k.pending_edit.description}\n\n${k.pending_edit.body}` : "";
        return text(`${k.scope}:${k.name} (by ${k.author}, updated_at ${k.updated_at}${flags(k) ? `; ${flags(k)}` : ""})\n${k.description}\n\n${k.body ?? ""}${pending}`);
      }
      if (res.changed === false) return text(`no change: ${k.scope}:${k.name} already matches what you sent (updated_at ${k.updated_at}).`);
      // Waiting for a person (settings "skillApproval" on the server): nothing reaches a PC yet, so nothing to mirror.
      const waiting = k.status === "candidate" ? "candidate" : res.proposed ? "proposed" : null;
      if (waiting) {
        if (ctx?.hasUI) ctx.ui.notify(`skill ${waiting === "candidate" ? "waiting for approval" : "edit waiting for approval"}: ${k.scope}:${k.name} — approve it in the memory server's web UI (${SERVER})`, "info");
        return text(
          waiting === "candidate"
            ? `${res.action === "create" ? "created" : "updated"} ${k.scope}:${k.name} as a candidate: it waits for a person to approve it on the memory server's web UI, and no PC gets it until then. Do not create it again.`
            : `proposed an edit to ${k.scope}:${k.name}: it waits for a person to approve it on the memory server's web UI; the current version stays in use until then.`,
        );
      }
      // Mirror the change back (server → PC). A body change is live at once (pi reads SKILL.md
      // when it uses a skill); a new name is listed after /skills-sync or in the next session.
      let mirrored = true;
      try {
        await syncSkills(project?.key ?? null, 10_000);
        // Only this write happened since the session loaded its skills: not an outside change. A body
        // edit is live at once (pi reads SKILL.md on use); a new skill or description needs /skills-sync,
        // which the status line keeps showing, without a second notice.
        // (A write right after its own earlier write starts from the version already reported.)
        if (res.version !== undefined) {
          if (res.previous_version === (loadedSkillsVersion ?? "") && res.action === "update" && p.description === undefined) loadedSkillsVersion = res.version;
          else if (res.previous_version === (loadedSkillsVersion ?? "") || res.previous_version === notifiedSkillsVersion) notifiedSkillsVersion = res.version;
        }
      } catch (err) {
        mirrored = false;
        console.error(`[memory] skill saved but not mirrored: ${(err as Error).message}`);
      }
      const created = res.action === "create";
      if (ctx?.hasUI) {
        const reload = created ? " — run /skills-sync to load it in this session" : p.description !== undefined ? " — run /skills-sync to refresh its description" : "";
        ctx.ui.notify(`skill ${created ? "saved" : "updated"}: ${k.scope}:${k.name}${reload}`, "info");
      }
      return text(
        `${created ? "created" : "updated"} ${k.scope}:${k.name} (updated_at ${k.updated_at}) on the memory server.` +
          (created ? " pi lists it after /skills-sync or in the next session." : mirrored ? " The synced file is current." : " The local copy refreshes on the next sync."),
      );
    },
  });

  // -------------------------------------------------------------- commands

  pi.registerCommand("memory", {
    description: "Show memory server status and the wiki link for this project",
    handler: async (_args, ctx) => {
      try {
        const h = await call<{ entries: number; pending: number; llm: string | null }>("GET", "/health", undefined, 3000);
        const res = project
          ? await call<{ project: { id: number } | null }>("POST", "/context", { project: projectBody(), prompt: "" }).catch(() => null)
          : null;
        const link = res?.project ? `${SERVER}/#/p/${res.project.id}` : SERVER;
        ctx.ui.notify(
          `memory: ${SERVER} · project ${project ? project.key : "(none)"} · ${h.entries} memories · ${h.pending} pending · llm ${h.llm ?? "off"}\n${link}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`memory server unreachable (${SERVER}): ${(err as Error).message}${unreachableHint()}`, "error");
      }
    },
  });

  /** Save one key (undefined removes it), apply it now and tell the user what happened. */
  async function saveSetting(ctx: ExtensionContext, key: SettingKey, value: MemoryConfig[SettingKey]) {
    const before = SERVER;
    try {
      writeConfig({ [key]: value } as MemoryConfig);
    } catch (err) {
      ctx.ui.notify(`could not update ${configPath()}: ${(err as Error).message} — fix or remove the file and try again`, "error");
      return;
    }
    applySettings();
    const env = envOverrides(key);
    const what = value === undefined ? `${key} removed from ${configPath()}` : `${key} saved to ${configPath()}`;
    if (env) {
      ctx.ui.notify(`${what}, but ${SETTINGS[key].env}=${env} still overrides it in this shell`, "warning");
      return;
    }
    if (key === "project") {
      project = resolveProject(cwd, PROJECT_OVERRIDE);
      setStatus(ctx, okStatus());
    }
    if (key === "disabled") {
      ctx.ui.notify(`${what} — run /reload to apply`, "info");
      return;
    }
    if (key === "serverUrl" && SERVER !== before) {
      warned = false;
      cachedSystem = ""; // the fallback block belonged to the old server
      try {
        const h = await call<{ entries: number }>("GET", "/health", undefined, 3000);
        ctx.ui.notify(`memory server set to ${SERVER} (${h.entries} memories) — ${what}`, "info");
      } catch (err) {
        ctx.ui.notify(`${what}, but ${SERVER} is not reachable: ${(err as Error).message}`, "warning");
      }
      return;
    }
    ctx.ui.notify(`${describeSetting(key)} — ${what}`, "info");
  }

  async function setFromText(ctx: ExtensionContext, key: SettingKey, raw: string) {
    let value: MemoryConfig[SettingKey];
    try {
      value = SETTINGS[key].parse(raw);
    } catch (err) {
      ctx.ui.notify(`invalid ${key}: ${(err as Error).message}`, "error");
      return;
    }
    await saveSetting(ctx, key, value);
  }

  pi.registerCommand("memory-config", {
    description: "Show or change the extension settings: /memory-config [key [value]] · /memory-config unset <key>",
    getArgumentCompletions: (prefix) => configCompletions(prefix),
    handler: async (args, ctx) => {
      const [first = "", ...rest] = args.trim().split(/\s+/);
      const restText = args.trim().slice(first.length).trim();
      if (first === "unset") {
        const key = rest[0] ?? "";
        if (!isSettingKey(key)) return ctx.ui.notify(`usage: /memory-config unset <${SETTING_KEYS.join("|")}>`, "error");
        return saveSetting(ctx, key, undefined);
      }
      if (first && !isSettingKey(first)) {
        return ctx.ui.notify(`unknown setting "${first}" — one of ${SETTING_KEYS.join(", ")}`, "error");
      }
      if (first && restText) return setFromText(ctx, first as SettingKey, restText);
      if (first) return ctx.ui.notify(`${describeSetting(first as SettingKey)}\n${SETTINGS[first as SettingKey].help}`, "info");
      // No arguments: list everything, and in the TUI let the user pick one to change.
      const lines = SETTING_KEYS.map(describeSetting);
      if (!ctx.hasUI) return ctx.ui.notify(`${lines.join("\n")}\nsettings: ${configPath()}`, "info");
      const picked = await ctx.ui.select(`memory settings — ${configPath()}`, lines);
      if (!picked) return;
      const key = picked.split(" ")[0] as SettingKey;
      if (key === "disabled" || key === "showActivity") {
        const v = await ctx.ui.select(key === "disabled" ? "disabled (applies after /reload)" : "showActivity", ["false", "true", "unset"]);
        if (!v) return;
        return v === "unset" ? saveSetting(ctx, key, undefined) : setFromText(ctx, key, v);
      }
      const typed = await ctx.ui.input(`${key}: ${SETTINGS[key].help} — type "unset" to remove`, describeSetting(key).split(" = ")[1].split("  (")[0]);
      if (typed === undefined || !typed.trim()) return;
      return typed.trim() === "unset" ? saveSetting(ctx, key, undefined) : setFromText(ctx, key, typed);
    },
  });

  pi.registerCommand("memory-server", {
    description: "Show or set the memory server URL: /memory-server [http://<server>:8765]  (same as /memory-config serverUrl)",
    handler: async (args, ctx) => {
      const url = args.trim();
      if (!url) {
        ctx.ui.notify(`memory server: ${SERVER} (from ${SOURCE_LABEL[serverSource]})\nsettings: ${configPath()}`, "info");
        return;
      }
      await setFromText(ctx, "serverUrl", url);
    },
  });

  pi.registerCommand("memory-pin", {
    description: "Add a standing instruction injected into every session: /memory-pin <text>  (add --project for this project only)",
    handler: async (args, ctx) => {
      const projectOnly = /(^|\s)--project(\s|$)/.test(args);
      const body = args.replace(/(^|\s)--project(\s|$)/, " ").trim();
      if (!body) {
        ctx.ui.notify(`Manage standing instructions at ${SERVER}/#/standing`, "info");
        return;
      }
      try {
        let projectId: number | null = null;
        if (projectOnly) {
          if (!project) throw new Error("not inside a project");
          const res = await call<{ project: { id: number } | null }>("POST", "/context", { project: projectBody(), prompt: "" });
          projectId = res.project?.id ?? null;
        }
        await call("POST", "/entries", {
          scope: projectId ? "project" : "global",
          project_id: projectId,
          category: "standing",
          title: body.length <= 120 ? body : `${body.slice(0, 117)}…`,
          body: body.length <= 120 ? "" : body,
        });
        ctx.ui.notify("Pinned. It applies from the next request.", "info");
      } catch (err) {
        ctx.ui.notify(`memory-pin failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("wiki-compose", {
    description: "Organize this session's turns into the project wiki with the server LLM: /wiki-compose [focus, e.g. 배포 절차 위주로]",
    handler: async (args, ctx) => {
      try {
        await flush();
        const job = await call<{ id: number; payload: { turns: number[] } }>("POST", "/wiki/compose", {
          project: projectBody(),
          session_id: sessionId,
          instruction: args.trim() || undefined,
        });
        ctx.ui.notify(`Wiki compose job #${job.id} queued (${job.payload.turns.length} turns). Progress: ${SERVER}/#/wiki-jobs`, "info");
      } catch (err) {
        ctx.ui.notify(`wiki-compose failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("skills-sync", {
    description: "Download the memory server's skills (global + this project) to this PC and reload them. One way: local edits are overwritten",
    handler: async (_args, ctx) => {
      // pi refuses to reload mid-response (it only warns), and the loaded skills would then stay stale.
      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
        ctx.ui.notify("skills-sync: wait for the current response to finish, then run it again", "warning");
        return;
      }
      const key = project?.key ?? null;
      let r: SyncResult;
      try {
        r = await syncSkills(key, 10_000);
      } catch (err) {
        ctx.ui.notify(`skills-sync failed (${SERVER}): ${(err as Error).message} — the last synced skills stay in use`, "error");
        return;
      }
      const removed = r.removed.length ? ` · removed ${r.removed.join(", ")}` : "";
      ctx.ui.notify(
        `skills synced from ${SERVER}: ${r.global} global · ${key ? `${r.project} for ${key}` : "no project"}${removed}${r.changed ? "" : " (no change)"}
${skillRoot()}`,
        "info",
      );
      // Reload even when the disk already matched: this session may have loaded an older set
      // (another pi process synced the folder, or the project changed with /memory-config).
      (globalThis as { __memoryWikiSkillsSyncedAt?: number }).__memoryWikiSkillsSyncedAt = Date.now();
      try {
        await ctx.reload(); // pi re-reads skills (resources_discover runs again, without a second fetch)
      } catch (err) {
        ctx.ui.notify(`skills are on disk; run /reload to load them (${(err as Error).message})`, "warning");
      }
    },
  });

  pi.registerCommand("memory-flush", {
    description: "Send the buffered turn to the memory server now instead of waiting for the idle delay",
    handler: async (_args, ctx) => {
      await flush();
      ctx.ui.notify("Turn sent for curation.", "info");
    },
  });
}
