import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { format } from "node:util";
import { config, localDate } from "./config.ts";
import { redactSecrets } from "./secrets.ts";

// Debug mode (ADR-0035): when on, the server appends one JSON object per line
// to <logDir>/YYYY-MM-DD.jsonl (local day in TIMEZONE) — requests, what recall
// picked and why, search hits, LLM prompts and replies, curation results,
// embedding calls and the console. For tuning features from real use.
//  - Never throws and never blocks a request: a failing write is dropped (G-065).
//  - Every string is redacted (secrets.ts) and cut to DEBUG_LOG_MAX_STRING.
//  - A day's file stops at DEBUG_LOG_MAX_MB (one "truncated" line), and files
//    older than DEBUG_LOG_KEEP_DAYS are deleted.
//  - DEBUG_MODE=1 forces it on; otherwise <DATA_DIR>/debug.json holds the
//    switch set from the web (env wins, like the extension settings, ADR-0033).

export type DebugSource = "env" | "file" | "default";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

const stateFile = () => path.join(config.dataDir, "debug.json");
let fileSwitch: boolean | null | undefined; // undefined = not read yet, null = no (valid) file

function readSwitch(): boolean | null {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return typeof j?.enabled === "boolean" ? j.enabled : null;
  } catch {
    return null;
  }
}

export function debugState(): { enabled: boolean; source: DebugSource } {
  if (config.debug.env) return { enabled: true, source: "env" };
  if (fileSwitch === undefined) fileSwitch = readSwitch();
  return fileSwitch === null ? { enabled: false, source: "default" } : { enabled: fileSwitch, source: "file" };
}

export const debugEnabled = () => debugState().enabled;

/** Turns debug mode on or off (persisted). Throws when DEBUG_MODE forces it on. */
export function setDebug(enabled: boolean): { enabled: boolean; source: DebugSource } {
  if (config.debug.env) throw new DebugForcedError();
  if (!enabled) debugLog("debug", { enabled: false });
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), `${JSON.stringify({ enabled }, null, 2)}\n`);
  fileSwitch = enabled;
  if (enabled) debugLog("debug", { enabled: true });
  return debugState();
}

export class DebugForcedError extends Error {
  constructor() {
    super("debug mode is forced on by DEBUG_MODE");
  }
}

/** Tests: forget the cached switch and the open day. */
export function resetDebugState() {
  fileSwitch = undefined;
  day = "";
  dayBytes = 0;
  dayFull = false;
  warned = false;
}

// ----------------------------------------------------------------- writing

let day = "";
let dayBytes = 0;
let dayFull = false;
let warned = false;
let writing = false;

const fileOf = (date: string) => path.join(config.debug.logDir, `${date}.jsonl`);

/** Strings redacted and cut; numbers, booleans, null kept; Sets/Maps/typed arrays made readable. */
function clean(_key: string, v: unknown): unknown {
  if (typeof v === "string") {
    // Redact the whole string before cutting: a secret across the cut would be too short to match.
    const r = redactSecrets(v);
    return r.length > config.debug.maxStringChars ? `${r.slice(0, config.debug.maxStringChars)}… (${v.length} chars)` : r;
  }
  if (v instanceof Set) return [...v];
  if (v instanceof Map) return Object.fromEntries(v);
  if (ArrayBuffer.isView(v)) return `(${(v as Uint8Array).length} values)`;
  if (v instanceof Error) return { name: v.name, message: v.message };
  return v;
}

/** Opens a day (creates the folder, reads its size). `day` is set only once that worked, so a failure is retried next event. */
function openDay(date: string, now: Date) {
  fs.mkdirSync(config.debug.logDir, { recursive: true });
  try {
    dayBytes = fs.statSync(fileOf(date)).size;
  } catch {
    dayBytes = 0;
  }
  dayFull = dayBytes >= config.debug.maxBytesPerDay;
  day = date;
  pruneDebugLogs(now);
}

/** Appends; if the folder was removed while running, recreates it once. */
function append(file: string, text: string) {
  try {
    fs.appendFileSync(file, text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    fs.mkdirSync(config.debug.logDir, { recursive: true });
    fs.appendFileSync(file, text);
  }
}

/**
 * Appends one event to today's file when debug mode is on. Never throws.
 * `now` is injectable for tests (day rollover, pruning).
 */
export function debugLog(type: string, data: Record<string, unknown> = {}, now = new Date()) {
  if (writing || !debugEnabled()) return;
  writing = true; // a console line written from here must not recurse
  try {
    const date = localDate(now.toISOString());
    if (date !== day) openDay(date, now);
    if (dayFull) return;
    const line = `${JSON.stringify({ ts: now.toISOString(), type, ...data }, clean)}\n`;
    const size = Buffer.byteLength(line);
    if (dayBytes + size > config.debug.maxBytesPerDay) {
      const marker = `${JSON.stringify({ ts: now.toISOString(), type: "truncated", note: `DEBUG_LOG_MAX_MB reached; nothing more is logged for ${date}` })}\n`;
      append(fileOf(date), marker);
      dayBytes += Buffer.byteLength(marker);
      dayFull = true;
      return;
    }
    append(fileOf(date), line);
    dayBytes += size;
    warned = false; // a later failure warns again
  } catch (err) {
    if (!warned) original.warn(`[debug] cannot write the debug log, dropping events: ${(err as Error).message}`);
    warned = true;
  } finally {
    writing = false;
  }
}

/** Deletes day files older than DEBUG_LOG_KEEP_DAYS (today counts as day 1). Returns the dates removed. */
export function pruneDebugLogs(now = new Date()): string[] {
  const cutoff = localDate(new Date(now.getTime() - (config.debug.keepDays - 1) * 86_400_000).toISOString());
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(config.debug.logDir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m || m[1] >= cutoff) continue;
    try {
      fs.rmSync(path.join(config.debug.logDir, name));
      removed.push(m[1]);
    } catch {
      // keep going
    }
  }
  return removed;
}

// ----------------------------------------------------------------- reading

export function listDebugLogs(): { date: string; bytes: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(config.debug.logDir);
  } catch {
    return [];
  }
  return names
    .map((n) => FILE_RE.exec(n)?.[1])
    .filter((d): d is string => Boolean(d))
    .sort()
    .reverse()
    .flatMap((date) => {
      try {
        return [{ date, bytes: fs.statSync(fileOf(date)).size }];
      } catch {
        return []; // removed between readdir and stat (pruned)
      }
    });
}

/**
 * One day's lines as a stream (null = no such file), so a 200 MB day never
 * blocks the event loop (/context keeps answering while someone reads it).
 * `date` must be YYYY-MM-DD; `type` keeps only that event type.
 */
export function debugLogStream(date: string, type?: string): ReadableStream<Uint8Array> | null {
  if (!DATE_RE.test(date)) throw new RangeError("date must be YYYY-MM-DD");
  const file = fileOf(date);
  if (!fs.existsSync(file)) return null;
  if (!type) return Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;
  const lines = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const enc = new TextEncoder();
  const needle = `"type":${JSON.stringify(type)}`;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      for await (const l of lines) {
        if (!l.includes(needle)) continue;
        try {
          if (JSON.parse(l).type !== type) continue;
        } catch {
          continue;
        }
        ctrl.enqueue(enc.encode(`${l}\n`));
        return; // one line per pull keeps memory flat
      }
      ctrl.close();
    },
    cancel() {
      lines.close();
    },
  });
}

/** One day's events of the given types, parsed (bad lines skipped). Streams the file. */
export async function* debugEvents(date: string, types: readonly string[]): AsyncGenerator<Record<string, unknown>> {
  if (!DATE_RE.test(date)) throw new RangeError("date must be YYYY-MM-DD");
  const file = fileOf(date);
  if (!fs.existsSync(file)) return;
  const needles = types.map((t) => `"type":${JSON.stringify(t)}`);
  const lines = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const l of lines) {
    if (!needles.some((n) => l.includes(n))) continue;
    try {
      const ev = JSON.parse(l) as Record<string, unknown>;
      if (types.includes(String(ev.type))) yield ev;
    } catch {
      // a half-written line
    }
  }
}

/** One day's lines as text (tests, small files). */
export async function readDebugLog(date: string, type?: string): Promise<string | null> {
  const stream = debugLogStream(date, type);
  return stream ? new Response(stream).text() : null;
}

// ----------------------------------------------------------------- console

const original = { log: console.log, warn: console.warn, error: console.error };
let captured = false;

/** Also writes console.log/warn/error lines to the debug log while debug mode is on (installed once at startup). */
export function captureConsole() {
  if (captured) return;
  captured = true;
  for (const level of ["log", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => {
      original[level](...args);
      if (debugEnabled()) debugLog("console", { level, message: format(...args) });
    };
  }
}

/** Milliseconds since `t0` (performance.now()), rounded to 0.1. */
export const msSince = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
