// memory-wiki — the memory-wiki-all-you-need client for Claude Code, as a mod
// (a plugin whose hooks run inside Claude Code). Same server API and tools as
// the pi extension (pi-extension/index.ts). ADR-0041.
//
// - session.start: registers the tools and commands, finds the project (origin's
//   url from .git/config, the key pi computes), fetches the memory block and
//   mirrors the server's global skills in the background.
// - prompt.compose (once per turn, before prompt.submit): appends the memory
//   block as a "session" section of the system prompt — the block from the
//   previous /context answer, so it stays put within a turn.
// - prompt.submit: POST /context with the prompt; memories matching it (and the
//   skill hint) go in as context only Claude reads. Never longer than timeoutMs.
// - turn.start / session.compact / turn.complete (main conversation only): the
//   turn's own rows of $.session.messages() become the server's turn messages,
//   kept in $.store as chunks (≤ 400 messages) until POST /turns has them,
//   sent settleDelayMs after the turn (a new prompt restarts the wait). Each
//   chunk has an id the server keeps once (a resend is not a second turn).
// - Skills: global skills are mirrored one way into <config dir>/skills/<name>/
//   (Claude Code reloads that folder by itself); this project's skills stay on
//   the server and are listed in the memory block for skill_manage view.
//
// Everything that calls `$` lives in this file (the mods static check allows
// `$` only in top-level functions of the hooks module); lib.ts is pure.
import {
  MAX_CHUNK_BYTES,
  MAX_PENDING_BYTES,
  MAX_TURN_MESSAGES,
  TOOLS,
  chunkMessages,
  formatTool,
  globalSkillsNote,
  isRetired,
  jsonBytes,
  lastPromptRow,
  locateTurn,
  originFromGitConfig,
  planMirror,
  folderProject,
  curationLine,
  projectFromRepo,
  recallLine,
  TURN_STATUSES,
  projectSkillsNote,
  renderRetired,
  resolveSettings,
  rowKey,
  runStats,
  skillHint,
  skillWriteIsLive,
  toTurnMessages,
  toolRequest,
  type PluginOptions,
  type ProjectRef,
  type SessionRow,
  type Settings,
  type SkillReply,
  type SkillsPayload,
  type TurnMark,
  type TurnMessage,
} from "./lib.ts";

// The mods API as this file uses it (the full types are written by Claude Code
// into .claude-plugin/types/ when the plugin is loaded with --plugin-dir).
type Api = any;
type Next = (e: any) => Promise<any>;

const PREFIX = "mcp__memory-wiki__";

/** One stored chunk of finished turns, under `pending:<session>:<id>`; deleted only once the server has it. */
interface Chunk {
  /** Sent as batchId: the server keeps one turn per (session, batchId), so a resend is not a second turn. */
  id: string;
  sessionId: string;
  /** The server it is for (a chunk is never sent to another server). */
  server: string;
  project: ProjectRef | null;
  cwd: string;
  client: string;
  messages: TurnMessage[];
  savedAt: number;
  /** A send was tried: the server may have it, so nothing more is merged in (the id must keep meaning these messages). */
  tried?: boolean;
}
const PENDING = "pending:";
/** A chunk left by a session that is gone (crash, quit before sending) is sent by another session after this long. */
const ORPHAN_AFTER_MS = 10 * 60_000;
/** How long a sent turn is watched for its curation result (memory_curate line). */
const WATCH_MS = 10 * 60_000;
/** Skill folders this mod wrote, so it never removes one it did not write. */
const MIRROR_KEY = "mirror";
/** The last project-skills note per project key, for the first prompt of the next session. */
const NOTE_KEY = "notes";

let settings: Settings = resolveSettings({}, {});
let project: ProjectRef | null = null;
let cwd = "";
let client = "";
let systemBlock = "";
let skillsNote = "";
let warned = false;
let hint = "";
// Activity lines ($.ui.log: in the transcript, never sent to Claude): the recall line waits for
// the turn to start so it lands under the prompt; curation watches end with the session.
let recallNote: string | null = null;
let watchGen = 0;
const watches = new Set<{ cancel(): void }>();
/** A prompt was typed while a turn ran: the hint from that turn would reach the wrong prompt, so it is dropped. */
let promptDuringTurn = false;
/**
 * Running turns by turnId: where each starts and what a compaction during it
 * already captured. Keyed, not one slot, so another loop's turn.start (should a
 * subagent ever raise one) cannot move the main turn's start. The first open
 * one is the main conversation's (anything else starts inside it).
 */
const turns = new Map<string, TurnMark & { captured: TurnMessage[] }>();
const mainTurn = () => turns.values().next().value;
let flushTimer: { cancel(): void } | null = null;
let flushing: Promise<void> | null = null;
/** Store read-modify-writes of chunks run one at a time (keepTurn vs. flush). */
let storeLock: Promise<unknown> = Promise.resolve();
/** Chunks being sent right now: never merged into. */
const inFlight = new Set<string>();
/** Turns $.store refused (full, broken): sent from memory instead. */
let unstored: Chunk[] = [];
let chunkSeq = 0;
let droppedNotice = false;
/** The server's skills version that is mirrored and noted here ("" = none on the server, null = never synced). */
let syncedVersion: string | null = null;
let syncing: Promise<void> | null = null;
let skillsDirExisted = true;

class ServerError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** An answer from the memory server within `ms`, or an error (never longer: the server may be down). */
async function call<T>($: Api, method: string, path: string, body: unknown, ms: number): Promise<T> {
  let timer: { cancel(): void } | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = $.clock.after(ms, () => reject(new Error(`no answer within ${ms} ms`)));
  });
  try {
    const res = await Promise.race([
      $.http.fetch(`${settings.server}/api${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
      timeout,
    ]);
    let data: any = {};
    try {
      data = res.text ? JSON.parse(res.text) : {};
    } catch {
      data = {};
    }
    if (!res.ok) throw new ServerError(data?.error ?? `HTTP ${res.status}`, res.status);
    return data as T;
  } finally {
    (timer as { cancel(): void } | null)?.cancel();
  }
}

/** A 4xx other than 408/429: the server will never take this request as it is. */
const permanent = (err: unknown) => err instanceof ServerError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;

const projectBody = () => (project ? { key: project.key, name: project.name, remote: project.remote } : null);

/** The env vars resolveSettings reads (lib.ts ENV_KEYS), each named literally: the mods check lists what a module reads. */
async function readEnv($: Api): Promise<Record<string, string | undefined>> {
  return {
    MEMORY_SERVER_URL: (await $.env.get("MEMORY_SERVER_URL")) ?? undefined,
    MEMORY_TIMEOUT_MS: (await $.env.get("MEMORY_TIMEOUT_MS")) ?? undefined,
    MEMORY_SETTLE_DELAY_MS: (await $.env.get("MEMORY_SETTLE_DELAY_MS")) ?? undefined,
    MEMORY_PROJECT: (await $.env.get("MEMORY_PROJECT")) ?? undefined,
    MEMORY_SKILL_NUDGE: (await $.env.get("MEMORY_SKILL_NUDGE")) ?? undefined,
    MEMORY_MIRROR_SKILLS: (await $.env.get("MEMORY_MIRROR_SKILLS")) ?? undefined,
    MEMORY_SHOW_ACTIVITY: (await $.env.get("MEMORY_SHOW_ACTIVITY")) ?? undefined,
  };
}

/** The project the pi extension would see here: origin's `url =` from .git/config (not the push URL), else what Claude Code reports. */
async function findProject($: Api): Promise<ProjectRef | null> {
  let repo: { root: string; remote: string | null } | null = null;
  try {
    repo = await $.session.repo();
  } catch {
    repo = null;
  }
  if (repo && !settings.project) {
    try {
      const url = originFromGitConfig(await $.fs.read(`${repo.root}/.git/config`));
      if (url) repo = { root: repo.root, remote: url };
    } catch {
      // a submodule's .git is a file, or no access: keep Claude Code's answer
    }
  }
  if (!repo && !settings.project) return folderProjectHere($);
  return projectFromRepo(repo, settings.project);
}

/** Outside git: the folder itself (home/<user>[/<path>] or path/<path>, see lib.ts folderProject). */
async function folderProjectHere($: Api): Promise<ProjectRef | null> {
  try {
    const windows = (await $.env.get("OS")) === "Windows_NT";
    const home = (windows ? (await $.env.get("USERPROFILE")) || (await $.env.get("HOME")) : (await $.env.get("HOME")) || (await $.env.get("USERPROFILE"))) ?? "";
    const user = (await $.env.get("USER")) || (await $.env.get("USERNAME")) || "";
    if (!cwd.trim()) return null;
    return folderProject(cwd, home, user, windows);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ context

async function fetchContext($: Api, prompt: string, ms: number): Promise<string> {
  try {
    const res = await call<{ system?: string; recall?: string; recalledEntries?: unknown; skillsVersion?: string }>($, "POST", "/context", { project: projectBody(), prompt }, ms);
    if (prompt.trim()) recallNote = settings.showActivity ? recallLine(res) : null;
    if (typeof res.system === "string") systemBlock = res.system;
    if (warned) $.ui.status(undefined);
    warned = false;
    // Another PC or the web changed the skills: bring them here in the background.
    if (typeof res.skillsVersion === "string" && res.skillsVersion !== syncedVersion) startSkillSync($, false);
    return res.recall ?? "";
  } catch (err) {
    if (!warned) {
      $.ui.toast(`memory server unreachable (${settings.server}): ${(err as Error).message} — set it with /config (memory-wiki)`);
      $.ui.status(`memory offline (${settings.server})`);
    }
    warned = true;
    return "";
  }
}

// -------------------------------------------------------------------- turns

function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeLock.then(fn, fn);
  storeLock = run.catch(() => {});
  return run;
}

async function pendingKeys($: Api): Promise<string[]> {
  try {
    return ((await $.store.keys()) as string[]).filter((k) => k.startsWith(PENDING)).sort();
  } catch {
    return [];
  }
}

const chunkKey = (c: Pick<Chunk, "sessionId" | "id">) => `${PENDING}${c.sessionId}:${c.id}`;
const size = jsonBytes;

/** Keep the other unsent chunks under MAX_PENDING_BYTES together: drop the oldest first, and say so once. */
async function makeRoom($: Api, need: number) {
  const all: { key: string; savedAt: number; size: number }[] = [];
  for (const key of await pendingKeys($)) {
    const c = (await $.store.get(key)) as Chunk | undefined;
    if (c && !inFlight.has(key)) all.push({ key, savedAt: c.savedAt ?? 0, size: size(c) });
  }
  let total = all.reduce((n, c) => n + c.size, 0);
  all.sort((a, b) => a.savedAt - b.savedAt);
  let dropped = 0;
  while (total + need > MAX_PENDING_BYTES && all.length) {
    const c = all.shift()!;
    await $.store.delete(c.key);
    total -= c.size;
    dropped++;
  }
  if (dropped && !droppedNotice) {
    droppedNotice = true;
    $.ui.toast(`memory-wiki: dropped ${dropped} old unsent turn chunk(s) — the memory server has been unreachable for a long time`);
  }
}

/**
 * Keep a finished turn until the server has it: merged into this session's
 * newest chunk while that one is young (never near orphan age, so another
 * session never sends a copy that misses it), untried and not being sent;
 * else new chunks. Never throws: what the store refuses is kept in memory.
 */
async function keepTurn($: Api, messages: TurnMessage[]) {
  const sessionId = await $.session.id();
  const now = await $.clock.now();
  const base = { sessionId, server: settings.server, project, cwd, client, savedAt: now };
  await locked(async () => {
    let rest = messages;
    try {
      const own = (await pendingKeys($)).filter((k) => k.startsWith(`${PENDING}${sessionId}:`) && !inFlight.has(k));
      const lastKey = own.at(-1);
      const last = lastKey ? ((await $.store.get(lastKey)) as Chunk | undefined) : undefined;
      if (lastKey && last && !last.tried && last.server === settings.server && now - (last.savedAt ?? 0) < ORPHAN_AFTER_MS / 2) {
        const merged = [...last.messages, ...messages];
        if (merged.length <= MAX_TURN_MESSAGES && size(merged) <= MAX_CHUNK_BYTES) {
          await makeRoom($, size(messages));
          await $.store.set(lastKey, { ...last, messages: merged, savedAt: now });
          rest = [];
        }
      }
    } catch {
      rest = messages; // the merge was refused: keep the turn as a chunk of its own below
    }
    for (const part of rest.length ? chunkMessages(rest) : []) {
      const c: Chunk = { ...base, id: `${String(now).padStart(14, "0")}-${String(++chunkSeq).padStart(4, "0")}`, messages: part };
      try {
        await makeRoom($, size(c));
        await $.store.set(chunkKey(c), c);
      } catch (err) {
        unstored.push(c); // the store refused it: send from memory, and say so
        $.ui.toast(`memory-wiki: a turn could not be saved on this machine (${(err as Error).message}); it is sent before this session ends if the server answers`);
      }
    }
  });
}

/** Send this session's chunks (and chunks other sessions left long ago for this server), oldest first; each is deleted only once the server has it. */
async function flush($: Api, ms = 10_000, onlyOwn = false, watch = true) {
  if (flushing) return flushing;
  const gen = watchGen; // a session.end during the sends must not start watches for the old conversation
  flushing = (async () => {
    flushTimer?.cancel();
    flushTimer = null;
    const sessionId = await $.session.id();
    const now = await $.clock.now();
    // Take the chunks under the lock: each is marked in flight and tried before any send, so no
    // turn is merged into a chunk whose id the server may already have (this process, or after a crash).
    const queue: { key: string | null; chunk: Chunk }[] = unstored.map((chunk) => ({ key: null, chunk }));
    await locked(async () => {
      for (const key of await pendingKeys($)) {
        if (inFlight.has(key)) continue;
        const chunk = (await $.store.get(key)) as Chunk | undefined;
        if (!chunk?.messages) continue;
        const mine = chunk.sessionId === sessionId;
        if (!mine && (onlyOwn || now - (chunk.savedAt ?? 0) < ORPHAN_AFTER_MS)) continue; // another live session's
        if ((chunk.server ?? settings.server) !== settings.server) continue; // for another server
        inFlight.add(key);
        if (!chunk.tried) {
          try {
            await $.store.set(key, { ...chunk, tried: true });
          } catch {
            // not marked on disk: this process still holds it in flight
          }
        }
        queue.push({ key, chunk });
      }
    });
    let stop = false;
    for (const { key, chunk } of queue) {
      if (stop) {
        if (key) inFlight.delete(key);
        continue;
      }
      try {
        if (chunk.messages.some((m) => m.role === "user" || m.role === "assistant")) {
          const sent = await call<{ id?: number }>(
            $,
            "POST",
            "/turns",
            { sessionId: chunk.sessionId, batchId: chunk.id, project: chunk.project, client: chunk.client, cwd: chunk.cwd, agent: "claude-code", messages: chunk.messages },
            ms,
          );
          // This session's own turn: say what curation changed once the server is done.
          if (watch && gen === watchGen && chunk.sessionId === sessionId && typeof sent?.id === "number") watchTurn($, sent.id);
        }
        await done($, key, chunk);
      } catch (err) {
        if (permanent(err)) {
          // The server will never take it as it is: do not let it hold back every later turn.
          $.ui.toast(`memory-wiki: the server refused a turn (${(err as Error).message}); it was dropped`);
          await done($, key, chunk);
          continue;
        }
        $.ui.log(`turn not sent yet (${(err as Error).message}); it is kept and sent later`);
        stop = true;
      } finally {
        if (key) inFlight.delete(key);
      }
    }
  })();
  try {
    await flushing;
  } finally {
    flushing = null;
  }
}

/**
 * Poll GET /turns/:id/status until the server has curated the turn, then log a memory_curate
 * line when memories changed. Every 3 s for 30 s, then every 10 s, for at most 10 min; three
 * failed polls in a row (an old server: 404 or its web UI's index.html), another server, or
 * the session's end stop it. Never throws.
 */
function watchTurn($: Api, id: number) {
  if (!settings.showActivity) return;
  const gen = watchGen;
  const server = settings.server;
  let failures = 0;
  let started = 0;
  const schedule = (elapsed: number) => {
    if (elapsed > WATCH_MS) return;
    const timer = $.clock.after(elapsed < 30_000 ? 3_000 : 10_000, () => {
      watches.delete(timer);
      void tick().catch(() => {});
    });
    watches.add(timer);
  };
  const tick = async () => {
    if (gen !== watchGen || server !== settings.server) return;
    let t: { status?: unknown; result?: unknown } | null = null;
    try {
      t = await call<{ status?: unknown; result?: unknown }>($, "GET", `/turns/${id}/status`, undefined, 5000);
    } catch {
      t = null;
    }
    if (!t || !TURN_STATUSES.includes(String(t.status))) {
      if (++failures >= 3) return;
    } else failures = 0;
    if (gen !== watchGen || server !== settings.server || !settings.showActivity) return;
    if (t && (t.status === "done" || t.status === "skipped" || t.status === "error")) {
      const line = curationLine(t.status, t.result);
      if (line) $.ui.log(line);
      return;
    }
    schedule((await $.clock.now()) - started);
  };
  void (async () => {
    started = await $.clock.now();
    schedule(0);
  })().catch(() => {});
}

function stopWatches() {
  watchGen++;
  for (const w of watches) w.cancel();
  watches.clear();
}

async function done($: Api, key: string | null, chunk: Chunk) {
  if (key) await locked(() => $.store.delete(key));
  else unstored = unstored.filter((c) => c !== chunk);
}

function scheduleFlush($: Api) {
  flushTimer?.cancel();
  flushTimer = $.clock.after(Math.max(1, settings.settleDelayMs), () => {
    flushTimer = null;
    void flush($).catch(() => {});
  });
}

// ------------------------------------------------------------------- skills

async function configDir($: Api): Promise<string> {
  const dir = (await $.env.get("CLAUDE_CONFIG_DIR"))?.trim();
  if (dir) return dir.replace(/[\\/]+$/, "");
  // Claude Code uses the OS home: USERPROFILE on Windows (HOME there is often git's or MSYS's).
  const windows = (await $.env.get("OS")) === "Windows_NT";
  const home = (windows ? (await $.env.get("USERPROFILE")) || (await $.env.get("HOME")) : (await $.env.get("HOME")) || (await $.env.get("USERPROFILE"))) ?? "";
  if (!home.trim()) throw new Error("no HOME: cannot find the Claude Code skills folder");
  return `${home.trim().replace(/[\\/]+$/, "")}/.claude`;
}

/** What is at <root>/<name>: no folder (absent), a folder whose SKILL.md cannot be read (null), or SKILL.md's text. */
async function folderState($: Api, root: string, name: string): Promise<{ exists: boolean; text: string | null }> {
  let exists = false;
  try {
    exists = await $.fs.exists(`${root}/${name}`);
  } catch {
    exists = true; // cannot tell: treat it as someone else's
  }
  if (!exists) return { exists, text: null };
  try {
    const t = await $.fs.read(`${root}/${name}/SKILL.md`);
    return { exists, text: typeof t === "string" ? t : null };
  } catch {
    return { exists, text: null };
  }
}

/** Remove a folder this mod wrote: its SKILL.md, then the folder only if empty. Else (once) leave a retired stub, still ours. */
async function retireFolder($: Api, root: string, name: string, windows: boolean, writeStub: boolean): Promise<boolean> {
  const dir = `${root}/${name}`;
  if (!windows) {
    try {
      const r = await $.process.run(["rm", "-f", "--", `${dir}/SKILL.md`], { timeoutMs: 5000 });
      if (r.exitCode === 0) {
        try {
          await $.process.run(["rmdir", "--", dir], { timeoutMs: 5000 }); // fails when the user put files there: they stay
        } catch {
          // left as an empty or user folder
        }
        return true;
      }
    } catch {
      // no process API here (e.g. the desktop app): fall back to the stub
    }
  }
  if (writeStub) {
    try {
      await $.fs.write(`${dir}/SKILL.md`, renderRetired(name, settings.server));
    } catch {
      // nothing more to do; it is tried again on the next sync
    }
  }
  return false;
}

/** The folders this mod wrote under one skills root ($.store "mirror": {roots: {root: names}}; one machine can have several config dirs). */
async function ownedFolders($: Api, root: string): Promise<string[]> {
  const v = (await $.store.get(MIRROR_KEY)) as { roots?: Record<string, string[]>; root?: string; owned?: string[] } | undefined;
  if (v?.roots) return v.roots[root] ?? [];
  return v?.root === root ? (v.owned ?? []) : []; // the first shape, one root
}

async function saveOwned($: Api, root: string, owned: string[]) {
  const v = (await $.store.get(MIRROR_KEY)) as { roots?: Record<string, string[]>; root?: string; owned?: string[] } | undefined;
  const roots = v?.roots ?? (v?.root ? { [v.root]: v.owned ?? [] } : {});
  await $.store.set(MIRROR_KEY, { roots: { ...roots, [root]: owned } });
}

interface SyncResult {
  written: number;
  removed: string[];
  retired: string[];
  conflicts: string[];
  failed: string[];
  global: number;
  project: number;
}

/** Fetch the server's skills, mirror the global ones and refresh the note. Throws only when the server fails; disk trouble is per skill. */
async function syncSkills($: Api, ms: number): Promise<SyncResult> {
  const q = project ? `?${new URLSearchParams({ project: project.key })}` : "";
  const payload = await call<SkillsPayload>($, "GET", `/skills/sync${q}`, undefined, ms);
  if (!payload || !Array.isArray(payload.global)) throw new Error("unexpected answer from the server (no skill lists)");
  const result: SyncResult = { written: 0, removed: [], retired: [], conflicts: [], failed: [], global: payload.global.length, project: payload.project?.skills?.length ?? 0 };
  let installed: string[] = [];
  try {
    const root = `${await configDir($)}/skills`;
    const owned = await ownedFolders($, root);
    // Mirroring off: nothing wanted, so this mod's own folders go (marked ones only).
    const wanted = settings.mirrorSkills ? payload.global : [];
    const current = new Map<string, string | null>();
    for (const name of new Set([...wanted.map((s) => s.name), ...owned])) {
      if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue;
      const f = await folderState($, root, name);
      if (f.exists) current.set(name, f.text);
    }
    const plan = planMirror(wanted, owned, current, settings.server);
    const nowOwned = new Set(plan.owned);
    for (const w of plan.write) {
      try {
        await $.fs.write(`${root}/${w.name}/SKILL.md`, w.text);
        result.written++;
      } catch {
        result.failed.push(w.name);
        nowOwned.delete(w.name);
      }
    }
    const windows = (await $.env.get("OS")) === "Windows_NT";
    for (const name of plan.remove) {
      const stub = isRetired(current.get(name));
      if (await retireFolder($, root, name, windows, !stub)) result.removed.push(name);
      else {
        if (!stub) result.retired.push(name); // newly turned off; an old stub stays quietly
        nowOwned.add(name); // still ours: removed on a later sync where that works
      }
    }
    try {
      await saveOwned($, root, [...nowOwned].sort());
    } catch (err) {
      $.ui.log(`skill folder list not saved (${(err as Error).message})`);
    }
    installed = plan.owned.filter((n) => nowOwned.has(n) && !result.failed.includes(n));
    result.conflicts = plan.conflicts;
  } catch (err) {
    $.ui.log(`skills not installed (${(err as Error).message})`);
  }
  // The note is set whatever happened on disk: Claude must learn which skills exist,
  // including global ones not installed here (mirroring off, a local skill of that name, a failed write).
  const missing = payload.global.filter((g) => !installed.includes(g.name));
  const notes = [projectSkillsNote(payload.project, installed), globalSkillsNote(missing, result.conflicts)].filter(Boolean);
  skillsNote = notes.join("\n\n");
  syncedVersion = typeof payload.version === "string" ? payload.version : "";
  if (project) {
    try {
      const all = ((await $.store.get(NOTE_KEY)) as Record<string, string> | undefined) ?? {};
      await $.store.set(NOTE_KEY, { ...all, [project.key]: skillsNote });
    } catch {
      // only a head start for the next session
    }
  }
  return result;
}

function describeSync(r: SyncResult): string {
  return [
    r.written ? `${r.written} updated` : "",
    r.removed.length ? `removed ${r.removed.join(", ")}` : "",
    r.retired.length ? `turned off ${r.retired.join(", ")} (delete those folders by hand)` : "",
    r.conflicts.length ? `not installed, a folder of that name is not from the server: ${r.conflicts.join(", ")}` : "",
    r.failed.length ? `could not write ${r.failed.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Sync in the background (never more than one at a time); `loud` says what happened even when nothing changed. */
function startSkillSync($: Api, loud: boolean) {
  if (syncing) return;
  syncing = (async () => {
    try {
      const r = await syncSkills($, 10_000);
      const what = describeSync(r);
      if (what) {
        const note = !skillsDirExisted && r.written ? " — run /reload-skills once so Claude Code starts watching the skills folder" : "";
        $.ui.toast(`memory-wiki skills: ${what}${note}`);
      } else if (loud) {
        $.ui.toast(`memory-wiki skills: ${r.global} global, ${r.project} for this project — no change`);
      }
    } catch (err) {
      $.ui.log(`skills not synced (${(err as Error).message}); the last synced copy stays in use`);
    }
  })();
  void syncing.finally(() => {
    syncing = null;
  });
}

// ---------------------------------------------------------------- commands

async function statusText($: Api): Promise<string> {
  try {
    const h = await call<{ entries: number; pending: number; llm: string | null }>($, "GET", "/health", undefined, 3000);
    let link = settings.server;
    if (project) {
      const res = await call<{ project?: { id: number } | null }>($, "POST", "/context", { project: projectBody(), prompt: "" }, 3000).catch(() => null);
      if (res?.project) link = `${settings.server}/#/p/${res.project.id}`;
    }
    const waiting = (await pendingKeys($)).length + unstored.length;
    return `memory: ${settings.server} · project ${project ? project.key : "(none)"} · ${h.entries} memories · ${h.pending} pending on the server${waiting ? ` · ${waiting} turn chunk(s) not sent yet` : ""} · llm ${h.llm ?? "off"}\n${link}`;
  } catch (err) {
    return `memory server unreachable (${settings.server}): ${(err as Error).message} — set server_url with /config (memory-wiki) or MEMORY_SERVER_URL`;
  }
}

async function pin($: Api, args: string): Promise<string> {
  const projectOnly = /(^|\s)--project(\s|$)/.test(args);
  const body = args.replace(/(^|\s)--project(\s|$)/, " ").trim();
  if (!body) return `Manage standing instructions at ${settings.server}/#/standing`;
  try {
    let projectId: number | null = null;
    if (projectOnly) {
      if (!project) throw new Error("not inside a project");
      const res = await call<{ project?: { id: number } | null }>($, "POST", "/context", { project: projectBody(), prompt: "" }, 10_000);
      projectId = res.project?.id ?? null;
    }
    await call(
      $,
      "POST",
      "/entries",
      {
        scope: projectId ? "project" : "global",
        project_id: projectId,
        category: "standing",
        title: body.length <= 120 ? body : `${body.slice(0, 117)}…`,
        body: body.length <= 120 ? "" : body,
      },
      10_000,
    );
    return "Pinned. It applies from the next request.";
  } catch (err) {
    return `memory-pin failed: ${(err as Error).message}`;
  }
}

async function compose($: Api, args: string): Promise<string> {
  try {
    await flush($, 10_000, true);
    const job = await call<{ id: number; payload: { turns: number[] } }>(
      $,
      "POST",
      "/wiki/compose",
      { project: projectBody(), session_id: await $.session.id(), instruction: args.trim() || undefined },
      10_000,
    );
    return `Wiki compose job #${job.id} queued (${job.payload.turns.length} turns). Progress: ${settings.server}/#/wiki-jobs`;
  } catch (err) {
    return `wiki-compose failed: ${(err as Error).message}`;
  }
}

async function skillsSync($: Api): Promise<string> {
  try {
    const r = await syncSkills($, 10_000);
    const what = describeSync(r);
    const reload = !skillsDirExisted && r.written ? " — run /reload-skills once so Claude Code starts watching the skills folder" : "";
    const global = settings.mirrorSkills ? `${r.global} global installed` : `${r.global} global (installing is off: read with skill_manage)`;
    return `skills synced from ${settings.server}: ${global} · ${project ? `${r.project} for ${project.key} via skill_manage` : "no project"}${what ? ` · ${what}` : " · no change"}${reload}`;
  } catch (err) {
    return `skills-sync failed (${settings.server}): ${(err as Error).message} — the last synced skills stay in use`;
  }
}

const COMMANDS = [
  { name: "memory-wiki", description: "Show the memory server, this project and the wiki link" },
  { name: "memory-pin", description: "Add a standing instruction to every session (--project: this project only)", argumentHint: "<text> [--project]" },
  { name: "wiki-compose", description: "Organize this session's turns into the project wiki with the server LLM", argumentHint: "[focus]" },
  { name: "skills-sync", description: "Download the memory server's skills now (one way: local edits are overwritten)" },
  { name: "memory-flush", description: "Send the finished turns to the memory server now instead of waiting" },
];

// ---------------------------------------------------------------- the hooks

export function register(on: any, options?: PluginOptions) {
  on("session.start", async ($: Api, e: any, next: Next) => {
    settings = resolveSettings(options, await readEnv($));
    cwd = e.cwd ?? (await $.session.cwd());
    project = await findProject($);
    // Tools first, each on its own: a throw here would skip the rest of this hook.
    for (const t of TOOLS) {
      try {
        await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      } catch (err) {
        $.ui.log(`tool ${t.name} not registered: ${(err as Error).message}`);
      }
    }
    for (const c of COMMANDS) {
      try {
        await $.command.register(c);
      } catch (err) {
        $.ui.log(`/${c.name} not added: ${(err as Error).message}`);
      }
    }
    try {
      const r = await $.process.run(["hostname"], { timeoutMs: 2000 });
      client = r.exitCode === 0 ? String(r.stdout).trim() : "";
    } catch {
      client = "";
    }
    try {
      skillsDirExisted = await $.fs.exists(`${await configDir($)}/skills`);
    } catch {
      skillsDirExisted = true;
    }
    // The last skills note for this project, until the background sync refreshes it.
    if (project) {
      try {
        const notes = (await $.store.get(NOTE_KEY)) as Record<string, string> | undefined;
        skillsNote = notes?.[project.key] ?? "";
      } catch {
        skillsNote = "";
      }
    }
    // The memory block for the first prompt (prompt.compose runs before prompt.submit), then
    // skills and turns left from earlier sessions, in the background.
    await fetchContext($, "", settings.timeoutMs);
    if (syncedVersion === null) startSkillSync($, false);
    $.clock.after(1, () => void flush($).catch(() => {}));
    return next(e);
  });

  on("tool.describe", { tool: /^mcp__memory-wiki__/ }, async ($: Api, e: any, next: Next) => {
    const r = await next(e);
    const def = TOOLS.find((t) => PREFIX + t.name === e.tool);
    return def?.eager ? { ...r, isDeferred: false } : r;
  });

  on("prompt.compose", async ($: Api, e: any, next: Next) => {
    const r = await next(e);
    const text = [systemBlock, skillsNote].filter(Boolean).join("\n\n");
    if (!text) return r;
    return { sections: [...r.sections, { id: "memory-wiki", text, scope: "session" }] };
  });

  on("prompt.submit", async ($: Api, e: any, next: Next) => {
    // A new prompt: the previous turn waits for this one, and both ship together.
    flushTimer?.cancel();
    flushTimer = null;
    if (turns.size) promptDuringTurn = true;
    recallNote = null; // only this prompt's recall (a failed or text-less fetch leaves none)
    const recall = await fetchContext($, e.text ?? "", settings.timeoutMs);
    const extra = [recall, hint].filter(Boolean);
    hint = "";
    if (!extra.length) return next(e);
    return next({ ...e, context: [...(e.context ?? []), extra.join("\n")] });
  }).catch(async ($: Api, e: any, next: Next) => next(e)); // never hold a prompt back

  // Every main-loop turn starts here (a queued prompt, a continuation too); subagents raise none.
  on("turn.start", async ($: Api, e: any, next: Next) => {
    if (recallNote) {
      $.ui.log(recallNote); // under the prompt that recalled it
      recallNote = null;
    }
    if (turns.size > 20) turns.clear(); // marks whose turn.complete never came (a crash in the engine): start over
    try {
      const rows = (await $.session.messages()) as SessionRow[];
      turns.set(e.turnId, { prompt: e.text ?? "", anchor: rowKey(rows.at(-1)), length: rows.length, captured: [] });
    } catch {
      turns.set(e.turnId, { prompt: e.text ?? "", anchor: null, length: -1, captured: [] });
    }
    return next(e);
  });

  // A compaction during a turn: keep what the turn has so far, and start again after what remains.
  // No .catch on purpose: a failed hook is skipped and the compaction goes on (the fail-soft outcome).
  on("session.compact", async ($: Api, e: any, next: Next) => {
    const open = mainTurn();
    if (e.agentId || e.trigger === "precompute" || !open) return next(e);
    const start = locateTurn(e.messages as SessionRow[], open);
    const r = await next(e);
    if (!r?.skip && Array.isArray(r?.messages) && mainTurn() === open) {
      if (start !== null) open.captured.push(...toTurnMessages((e.messages as SessionRow[]).slice(start)));
      open.prompt = "";
      open.anchor = rowKey(r.messages.at(-1));
      open.length = r.messages.length;
    }
    return r;
  });

  on("turn.complete", async ($: Api, e: any, next: Next) => {
    if (e.agentId) {
      turns.delete(e.turnId);
      return next(e); // a subagent's turn: its work shows in the main turn's tool results
    }
    const open = turns.get(e.turnId) ?? null;
    turns.clear(); // the main turn is over: nothing else is running

    const queued = promptDuringTurn;
    promptDuringTurn = false;
    try {
      const rows = (await $.session.messages()) as SessionRow[];
      // No mark: the turn began before this module loaded (a reload) — from the last typed prompt.
      const start = open ? locateTurn(rows, open) : lastPromptRow(rows);
      if (start === null) $.ui.log("turn not recorded: its start could not be found in the transcript");
      else if (!open) $.ui.log("turn recorded from the last prompt (it started before the plugin loaded)");
      const messages = [...(open?.captured ?? []), ...(start === null ? [] : toTurnMessages(rows.slice(start)))];
      if (messages.some((m) => m.role === "user" || m.role === "assistant")) {
        hint = queued ? "" : (skillHint(runStats(messages), settings.skillNudge) ?? "");
        await keepTurn($, messages);
        scheduleFlush($);
      }
    } catch (err) {
      $.ui.log(`turn not recorded: ${(err as Error).message}`);
    }
    return next(e);
  });

  on("session.end", async ($: Api, e: any, next: Next) => {
    // 1.5 s for every mod's session.end together: one quick try; what is left stays in $.store.
    flushTimer?.cancel();
    flushTimer = null;
    hint = ""; // a /clear or resume starts another conversation
    recallNote = null;
    stopWatches();
    try {
      await flush($, 1000, true, false);
    } catch {
      // kept for the next session
    }
    // Turns the store refused earlier: one more try to keep them on disk for the next session.
    for (const c of unstored.splice(0)) {
      try {
        await $.store.set(chunkKey(c), c);
      } catch {
        // lost: said when it was refused
      }
    }
    return next(e);
  });

  on("tool.call", { tool: /^mcp__memory-wiki__/ }, async ($: Api, e: any) => {
    const name = String(e.tool).slice(PREFIX.length);
    const { tool: _t, tool_use_id: _id, ...args } = e;
    const req = toolRequest(name, args, project);
    if (typeof req === "string") return { result: req };
    try {
      const data = await call<any>($, req.method, req.path, req.body, 10_000);
      let text = formatTool(name, args, data);
      if (name === "skill_manage" && skillWriteIsLive(data as SkillReply)) {
        // Bring the change to this PC now (global skills are files; this project's are in the note).
        try {
          await syncSkills($, 10_000);
        } catch (err) {
          text += ` (not synced here yet: ${(err as Error).message})`;
        }
      }
      return { result: text };
    } catch (err) {
      return { result: `memory server error: ${(err as Error).message}` };
    }
  }).catch(async ($: Api, e: any, next: any) => ({ result: `memory-wiki tool failed (${next.error?.kind ?? "error"}): try again or go on without it` }));

  on("command.run", { command: "memory-wiki" }, async ($: Api) => ({ text: await statusText($) }));
  on("command.run", { command: "memory-pin" }, async ($: Api, e: any) => ({ text: await pin($, e.args ?? "") }));
  on("command.run", { command: "wiki-compose" }, async ($: Api, e: any) => ({ text: await compose($, e.args ?? "") }));
  on("command.run", { command: "skills-sync" }, async ($: Api) => ({ text: await skillsSync($) }));
  on("command.run", { command: "memory-flush" }, async ($: Api) => {
    await flush($, 10_000, true);
    const sessionId = await $.session.id();
    const left = (await pendingKeys($)).filter((k) => k.startsWith(`${PENDING}${sessionId}:`)).length + unstored.length;
    return { text: left ? `The memory server did not take ${left} turn chunk(s); they are kept and sent later.` : "Turns sent for curation." };
  });
}
