import os from "node:os";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveProject, type ProjectRef } from "./project.ts";

// memory-wiki-all-you-need — central memory + LLM wiki for pi.
//
// - before_agent_start: fetches the memory block from the server and puts it
//   into the system prompt (plus memories matching this prompt as a hidden
//   message), so memory is always in context without the agent asking.
// - message_end: buffers the turn (user prompt, assistant text, tool calls,
//   tool results).
// - agent_settled: once pi is truly idle (no retries, compaction or queued
//   work), waits MEMORY_SETTLE_DELAY_MS and ships the buffered turn to the
//   server, where an LLM curates it into memory. A new prompt before the delay
//   cancels the send and the turns are shipped together later.
// - Tools compatible with pi-hermes-memory: memory_search, session_search,
//   memory_add, memory_replace, memory_remove. Plus wiki_search / wiki_read /
//   wiki_write for the project wiki, which is kept separately from memory.
// - memory_graph: the memory knowledge graph (entities + typed links).
// - /wiki-compose: asks the server LLM to organize this session's turn
//   records into wiki pages.

const SERVER = (process.env.MEMORY_SERVER_URL ?? "http://127.0.0.1:8765").replace(/\/+$/, "");
const SETTLE_DELAY_MS = Number(process.env.MEMORY_SETTLE_DELAY_MS ?? 8000);
const CONTEXT_TIMEOUT_MS = Number(process.env.MEMORY_TIMEOUT_MS ?? 1500);
const MAX_BUFFER = 600;

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

export default function memoryAllYouNeed(pi: ExtensionAPI) {
  if (process.env.MEMORY_DISABLED === "1") return;

  let sessionId = "";
  let cwd = process.cwd();
  let project: ProjectRef | null = null;
  let cachedSystem = "";
  let buffer: TurnMessage[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let warned = false;

  const projectBody = () => (project ? { key: project.key, name: project.name, remote: project.remote } : null);

  const setStatus = (ctx: ExtensionContext, msg: string | undefined) => {
    if (ctx.hasUI) ctx.ui.setStatus("memory", msg);
  };

  const cancelFlush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  };

  async function flush() {
    cancelFlush();
    if (!buffer.some((m) => m.role === "user" || m.role === "assistant")) {
      buffer = [];
      return;
    }
    const messages = buffer;
    buffer = [];
    try {
      await call("POST", "/turns", { sessionId, project: projectBody(), client: os.hostname(), cwd, messages });
    } catch (err) {
      // Keep the turn for the next attempt, bounded so a dead server cannot grow memory forever.
      buffer = [...messages, ...buffer].slice(-MAX_BUFFER);
      console.error(`[memory] failed to send turn: ${(err as Error).message}`);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    cwd = ctx.cwd;
    project = resolveProject(cwd);
    buffer = [];
    setStatus(ctx, project ? `🧠 ${project.name}` : "🧠 global");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    cancelFlush();
    let recall = "";
    try {
      const res = await call<{ system: string; recall: string }>(
        "POST",
        "/context",
        { project: projectBody(), prompt: event.prompt },
        CONTEXT_TIMEOUT_MS,
      );
      cachedSystem = res.system;
      recall = res.recall;
      if (warned) setStatus(ctx, project ? `🧠 ${project.name}` : "🧠 global");
      warned = false;
    } catch (err) {
      if (!warned && ctx.hasUI) ctx.ui.notify(`memory server unreachable (${SERVER}): ${(err as Error).message}`, "warning");
      warned = true;
      setStatus(ctx, "🧠 offline");
    }
    if (cachedSystem) {
      event.systemPromptOptions.sections = { ...(event.systemPromptOptions.sections ?? {}), "memory-context": cachedSystem };
    }
    if (recall) return { message: { customType: "memory-recall", content: recall, display: false } };
    return undefined;
  });

  pi.on("message_end", async (event) => {
    const m = toTurnMessage(event.message);
    if (m) buffer.push(m);
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  });

  pi.on("agent_settled", async () => {
    cancelFlush();
    flushTimer = setTimeout(() => void flush(), SETTLE_DELAY_MS);
  });

  pi.on("session_shutdown", async () => {
    await flush();
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
      const q = new URLSearchParams({ q: p.query, limit: String(p.limit ?? 10) });
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
      const q = new URLSearchParams();
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
      "Create or update a wiki page. Only when the user asks to document something in the wiki. Updating: read the page with wiki_read first, then send the full new body (mode replace) or just a new section (mode append). Markdown with ## headings; no '# Title' line; link pages with [[slug]].",
    parameters: Type.Object({
      slug: Type.String({ description: "Page slug, e.g. architecture, deploy, troubleshooting" }),
      title: Type.Optional(Type.String({ description: "Page title (required when creating)" })),
      body: Type.String({ description: "Markdown body" }),
      mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append")], { description: "For an existing page. Default replace" })),
      global: Type.Optional(Type.Boolean({ description: "Write to the global wiki instead of this project's" })),
      reason: Type.Optional(Type.String({ description: "Short change note for the page history" })),
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
        ctx.ui.notify(`memory server unreachable (${SERVER}): ${(err as Error).message}`, "error");
      }
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

  pi.registerCommand("memory-flush", {
    description: "Send the buffered turn to the memory server now instead of waiting for the idle delay",
    handler: async (_args, ctx) => {
      await flush();
      ctx.ui.notify("Turn sent for curation.", "info");
    },
  });
}
