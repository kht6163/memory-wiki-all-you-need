// Harness for running the Claude Code mod (claude-code-plugin/hooks/register.ts)
// inside node:test without Claude Code: a fake mods API `$` (files and store in
// memory, real timers, real fetch to the X-ext-harness mock server) and an `on`
// that records each hook with its matcher, so a test fires events like Claude
// Code does and passes Claude Code's own behavior as `next`.
import { register } from "../../claude-code-plugin/hooks/register.ts";
import type { SessionRow } from "../../claude-code-plugin/hooks/lib.ts";

type Hook = ($: unknown, e: any, next: any) => unknown;
interface Registration {
  event: string;
  matcher: Record<string, unknown> | null;
  hook: Hook;
  onError: Hook | null;
}

export interface FakeSession {
  $: any;
  hooks: Registration[];
  tools: Map<string, { name: string; description: string; inputSchema?: unknown }>;
  commands: Map<string, { name: string; description: string }>;
  files: Map<string, string>;
  store: Map<string, unknown>;
  env: Record<string, string>;
  rows: SessionRow[];
  sessionId: string;
  repo: { root: string; remote: string | null } | null;
  ui: { status: (string | undefined)[]; toasts: string[]; logs: string[] };
  processes: string[][];
  /** Make $.process.run throw (the desktop app has no process API). */
  noProcess: boolean;
  /** Fire an event: runs the matching hooks as a chain ending in `core` (Claude Code's own behavior). */
  emit(event: string, e: any, core?: (e: any) => unknown): Promise<any>;
}

const matches = (m: Record<string, unknown> | null, e: Record<string, unknown>) =>
  !m || Object.entries(m).every(([k, v]) => (v instanceof RegExp ? v.test(String(e[k])) : Array.isArray(v) ? v.includes(e[k]) : e[k] === v));

export function startSession(opts: { env: Record<string, string>; repo?: FakeSession["repo"]; options?: Record<string, unknown>; sessionId?: string }): FakeSession {
  const s: FakeSession = {
    $: null,
    hooks: [],
    tools: new Map(),
    commands: new Map(),
    files: new Map(),
    store: new Map(),
    env: { HOME: "/home/test", ...opts.env },
    rows: [],
    sessionId: opts.sessionId ?? "sess-cc",
    repo: opts.repo ?? null,
    ui: { status: [], toasts: [], logs: [] },
    processes: [],
    noProcess: false,
    async emit(event, e, core = (x) => x) {
      const chain = s.hooks.filter((h) => h.event === event && matches(h.matcher, e));
      const run = async (i: number, ev: any): Promise<any> => {
        const h = chain[i];
        if (!h) return core(ev);
        const next = (x: any) => run(i + 1, x);
        try {
          return await h.hook(s.$, ev, next);
        } catch (err) {
          if (h.onError) return h.onError(s.$, ev, Object.assign(next, { error: { kind: "throw", message: String(err) } }));
          return run(i + 1, ev); // a failed hook is skipped, like Claude Code does
        }
      };
      return run(0, e);
    },
  };
  const dirOf = (p: string) => p.replace(/\/+$/, "");
  s.$ = {
    plugin: { name: "memory-wiki", root: "/plugin" },
    clock: {
      now: async () => Date.now(),
      after: (ms: number, fn: () => void) => {
        const h = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(h) };
      },
    },
    http: {
      async fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
        const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
        return { status: res.status, ok: res.ok, headers: {}, text: await res.text() };
      },
    },
    env: { get: async (k: string) => s.env[k] },
    fs: {
      async read(p: string) {
        const t = s.files.get(p);
        if (t === undefined) throw new Error(`$.fs.read(${p}) failed: ENOENT`);
        return t;
      },
      async write(p: string, text: string) {
        s.files.set(p, text);
      },
      async exists(p: string) {
        const d = dirOf(p);
        return s.files.has(d) || [...s.files.keys()].some((k) => k.startsWith(`${d}/`));
      },
    },
    process: {
      async run(argv: string[]) {
        if (s.noProcess) throw new Error("$.process.run is not available here");
        s.processes.push(argv);
        if (argv[0] === "hostname") return { exitCode: 0, stdout: "test-host\n", stderr: "" };
        if (argv[0] === "rm") {
          s.files.delete(argv[argv.length - 1] ?? "");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (argv[0] === "rmdir") {
          const d = dirOf(argv[argv.length - 1] ?? "");
          const busy = [...s.files.keys()].some((k) => k.startsWith(`${d}/`));
          return { exitCode: busy ? 1 : 0, stdout: "", stderr: busy ? "Directory not empty" : "" };
        }
        return { exitCode: 127, stdout: "", stderr: "not found" };
      },
    },
    store: {
      get: async (k: string) => (s.store.has(k) ? structuredClone(s.store.get(k)) : undefined),
      set: async (k: string, v: unknown) => void s.store.set(k, structuredClone(v)),
      delete: async (k: string) => void s.store.delete(k),
      keys: async () => [...s.store.keys()],
    },
    session: {
      id: async () => s.sessionId,
      cwd: async () => "/work/app",
      repo: async () => s.repo,
      messages: async () => s.rows.map((r) => structuredClone(r)),
    },
    ui: {
      status: (t: string | undefined) => void s.ui.status.push(t),
      toast: (t: string) => void s.ui.toasts.push(t),
      log: (t: string) => void s.ui.logs.push(t),
    },
    tool: { register: async (t: { name: string; description: string }) => void s.tools.set(t.name, t) },
    command: { register: async (c: { name: string; description: string }) => void s.commands.set(c.name, c) },
  };
  const on = (event: string, a: unknown, b?: unknown) => {
    const reg: Registration = { event, matcher: b ? (a as Record<string, unknown>) : null, hook: (b ?? a) as Hook, onError: null };
    s.hooks.push(reg);
    return {
      catch(h: Hook) {
        reg.onError = h;
      },
    };
  };
  register(on, opts.options as never);
  return s;
}

/** A session.start like Claude Code's: resolves to { cwd }. */
export const sessionStart = (s: FakeSession) => s.emit("session.start", { cwd: "/work/app", surface: "terminal", isInteractive: true }, (e) => ({ cwd: e.cwd }));

/** The system prompt sections Claude Code would send, with what the mod adds. */
export const compose = (s: FakeSession) =>
  s.emit("prompt.compose", { model: "m", promptModel: "m", surfaces: [], tools: [], outputStyle: null, traits: [] }, () => ({
    sections: [{ id: "intro", text: "core", scope: "shared" }],
  }));

/** A typed prompt: resolves to what entered (text + context), as Claude Code's own prompt.submit does. */
export const submit = (s: FakeSession, text: string) =>
  s.emit("prompt.submit", { text, wait: false, origin: { kind: "user" } }, (e) => ({ text: e.text, context: e.context }));

let turnSeq = 0;
/** A main-loop turn beginning (Claude Code fires it for every turn, a queued prompt's too). */
export const turnStart = (s: FakeSession, text: string) => s.emit("turn.start", { text, turnId: `t${++turnSeq}` }, (e) => ({ turnId: e.turnId }));

export const complete = (s: FakeSession, extra: Record<string, unknown> = {}) =>
  s.emit("turn.complete", { answer: "", durationMs: 1, isAborted: false, turnId: `t${turnSeq}`, reason: "answer", ...extra });

/** A prompt typed while idle, as Claude Code runs it: prompt.submit, the user row, turn.start. */
export async function prompt(s: FakeSession, text: string) {
  const entered = await submit(s, text);
  await turnStart(s, text);
  s.rows.push(user(text));
  return entered;
}

/** A Claude tool call on one of the mod's tools: resolves to the tool result. */
export const callTool = (s: FakeSession, name: string, args: Record<string, unknown>) =>
  s.emit("tool.call", { tool: `mcp__memory-wiki__${name}`, tool_use_id: "toolu_1", ...args }, () => ({ result: "core ran the tool" }));

export const user = (text: string): SessionRow => ({ role: "user", text, toolUses: [] });
export const assistant = (text: string, toolUses: SessionRow["toolUses"] = []): SessionRow => ({ role: "assistant", text, toolUses });
export const toolResult = (id: string, text: string, isError = false): SessionRow => ({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text, isError }] });
