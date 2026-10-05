// Harness for running the pi extension (pi-extension/index.ts) inside node:test
// without pi: a fake ExtensionAPI that records handlers, tools and commands,
// a fake ExtensionContext, and a mock memory server on a random local port.
//
// The extension reads MEMORY_SERVER_URL / MEMORY_SETTLE_DELAY_MS /
// MEMORY_TIMEOUT_MS once at import, so a test file sets process.env first and
// then calls loadExtension() (node --test runs each file in its own process).
// Never leave MEMORY_SERVER_URL unset: the default is the real server port.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx: any) => unknown;
type ExtensionModule = typeof import("../../pi-extension/index.ts");

export interface RecordedRequest {
  method: string;
  path: string;
  body: any;
}

export type Mode = "ok" | "hang" | "error500" | "errorText";

export interface MockServer {
  port: number;
  url: string;
  requests: RecordedRequest[];
  mode: Mode;
  /** Reply for a path (without query) in "ok" mode; default {}. */
  routes: Map<string, (req: RecordedRequest) => unknown>;
  /** Stop accepting connections and drop open ones (connection refused afterwards). */
  stop(): Promise<void>;
  /** Listen again on the same port. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function startMockServer(): Promise<MockServer> {
  const hanging = new Set<http.ServerResponse>();
  const mock: MockServer = {
    port: 0,
    url: "",
    requests: [],
    mode: "ok",
    routes: new Map(),
    stop,
    restart,
    close: stop,
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (raw += c));
    req.on("end", () => {
      let body: unknown = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const rec: RecordedRequest = { method: req.method ?? "", path: req.url ?? "", body };
      mock.requests.push(rec);
      if (mock.mode === "hang") {
        hanging.add(res);
        return;
      }
      if (mock.mode === "error500") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      if (mock.mode === "errorText") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
        return;
      }
      const route = mock.routes.get(rec.path.split("?")[0]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(route ? route(rec) : {}));
    });
  });

  async function listen(port: number) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    mock.port = (server.address() as AddressInfo).port;
    mock.url = `http://127.0.0.1:${mock.port}`;
  }
  async function stop() {
    for (const res of hanging) res.destroy();
    hanging.clear();
    if (!server.listening) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
  async function restart() {
    // Re-bind the same port; retry briefly in case the old socket is still releasing.
    for (let i = 0; ; i++) {
      try {
        return await listen(mock.port);
      } catch (err) {
        if (i >= 4) throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  await listen(0);
  return mock;
}

export interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  sessionManager: { getSessionId(): string };
  ui: {
    setStatus(key: string, msg: string | undefined): void;
    notify(msg: string, level?: string): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
  };
  notices: { msg: string; level?: string }[];
  status: (string | undefined)[];
  /** Answers for ui.select / ui.input, used in order (undefined = the user cancelled). */
  answers: (string | undefined)[];
  /** What select/input were asked: title and options or placeholder. */
  asked: { kind: "select" | "input"; title: string; options?: string[]; placeholder?: string }[];
}

export function makeCtx(cwd: string, sessionId = "sess-x"): FakeCtx {
  const notices: { msg: string; level?: string }[] = [];
  const status: (string | undefined)[] = [];
  const answers: (string | undefined)[] = [];
  const asked: FakeCtx["asked"] = [];
  return {
    cwd,
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setStatus: (_key, msg) => void status.push(msg),
      notify: (msg, level) => void notices.push({ msg, level }),
      select: async (title, options) => (asked.push({ kind: "select", title, options }), answers.shift()),
      input: async (title, placeholder) => (asked.push({ kind: "input", title, placeholder }), answers.shift()),
    },
    notices,
    status,
    answers,
    asked,
  };
}

export interface FakePi {
  api: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  tools: Map<string, { name: string; execute: (id: string, params: any, ...rest: any[]) => Promise<any> }>;
  commands: Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>;
  /** Run every handler for an event in order, like pi; returns the last non-undefined result. */
  emit(event: string, payload: any, ctx: FakeCtx): Promise<unknown>;
}

export function makePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const tools: FakePi["tools"] = new Map();
  const commands: FakePi["commands"] = new Map();
  const api = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    },
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
  };
  return {
    api: api as unknown as ExtensionAPI,
    handlers,
    tools,
    commands,
    async emit(event, payload, ctx) {
      let result: unknown = undefined;
      for (const h of handlers.get(event) ?? []) {
        const r = await h(payload, ctx);
        if (r !== undefined) result = r;
      }
      return result;
    },
  };
}

/** Import the extension (after env is set) and register it on a fresh fake pi. */
export async function loadExtension(opts: { settingsFile?: boolean } = {}): Promise<FakePi> {
  // settingsFile: the server URL comes from PI_CODING_AGENT_DIR's settings file instead (set that first).
  if (!process.env.MEMORY_SERVER_URL && !(opts.settingsFile && process.env.PI_CODING_AGENT_DIR)) {
    throw new Error("set MEMORY_SERVER_URL (or PI_CODING_AGENT_DIR with a settings file) before loadExtension()");
  }
  const mod: ExtensionModule = await import("../../pi-extension/index.ts");
  const pi = makePi();
  mod.default(pi.api);
  return pi;
}

export function beforeAgentStartEvent(prompt: string) {
  return { type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: {} as { sections?: Record<string, string> } };
}

export const userMsg = (text: string) => ({ message: { role: "user", content: text } });
export const assistantMsg = (text: string, toolCalls: { name: string; arguments: unknown }[] = []) => ({
  message: { role: "assistant", content: [{ type: "text", text }, ...toolCalls.map((t) => ({ type: "toolCall", ...t }))] },
});
export const toolResultMsg = (toolName: string, text: string, isError = false) => ({
  message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }] },
});

/** Poll until cond() is true or the deadline passes; returns the final cond(). */
export async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return cond();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Silence console.error (the extension logs failed sends) for the duration of fn. */
export async function quietErrors<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = orig;
  }
}
