// Pure helpers of the Claude Code mod (register.ts holds everything that calls
// the mods API `$`). No imports and erasable syntax only: the server's tests
// import this file directly under node's type stripping (server/test/CC-*.ts).

// ---------------------------------------------------------------- settings

/** userConfig keys in plugin.json; Claude Code passes their values to register(on, options). */
export interface PluginOptions {
  server_url?: string;
  timeout_ms?: number;
  settle_delay_ms?: number;
  project?: string;
  skill_nudge?: number;
  mirror_skills?: boolean;
  show_activity?: boolean | string;
}

export interface Settings {
  server: string;
  /** Wait for the memory block before each prompt (ms); the prompt goes on without it after that. */
  timeoutMs: number;
  /** Wait after a turn before sending it, so a quick follow-up prompt ships together (ms). */
  settleDelayMs: number;
  /** Fixed project key instead of the git origin ("" = from git). */
  project: string;
  /** Tool calls in one turn (with 2+ different tools) after which the agent is nudged to save a skill; 0 = never. */
  skillNudge: number;
  /** Mirror the server's global skills into the Claude Code skills folder. */
  mirrorSkills: boolean;
  /** Log "memory_recall" / "memory_curate" lines in the transcript (never sent to Claude). */
  showActivity: boolean;
}

export const DEFAULT_SERVER = "http://127.0.0.1:8765";

const cleanUrl = (u: string) => u.trim().replace(/\/+$/, "");
const num = (env: string | undefined, opt: unknown, dflt: number) => {
  const fromOpt = typeof opt === "number" ? opt : typeof opt === "string" && opt.trim() ? Number(opt) : dflt; // /config may store text
  const n = env?.trim() ? Number(env) : fromOpt;
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

/** true/1/on/yes → true, false/0/off/no → false, anything else → null (not set). /config may store text. */
const boolText = (v: unknown): boolean | null => {
  if (typeof v === "boolean") return v;
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (["true", "on", "yes", "1"].includes(t)) return true;
  if (["false", "off", "no", "0"].includes(t)) return false;
  return null;
};

/** Env vars (same names as the pi extension) win over the plugin options, the options over defaults. */
export function resolveSettings(options: PluginOptions | undefined, env: Record<string, string | undefined>): Settings {
  const o = options ?? {};
  const optServer = typeof o.server_url === "string" ? o.server_url.trim() : "";
  const mirrorEnv = env.MEMORY_MIRROR_SKILLS?.trim();
  return {
    server: cleanUrl(env.MEMORY_SERVER_URL?.trim() || optServer || DEFAULT_SERVER),
    timeoutMs: Math.max(1, num(env.MEMORY_TIMEOUT_MS, o.timeout_ms, 1500)),
    settleDelayMs: num(env.MEMORY_SETTLE_DELAY_MS, o.settle_delay_ms, 8000),
    project: env.MEMORY_PROJECT?.trim() || (typeof o.project === "string" ? o.project.trim() : ""),
    skillNudge: num(env.MEMORY_SKILL_NUDGE, o.skill_nudge, 8),
    mirrorSkills: mirrorEnv ? mirrorEnv !== "0" : !(o.mirror_skills === false || String(o.mirror_skills).trim().toLowerCase() === "false"),
    showActivity: boolText(env.MEMORY_SHOW_ACTIVITY) ?? boolText(o.show_activity) ?? true,
  };
}

/** The env vars resolveSettings reads (register.ts asks for each by name). */
export const ENV_KEYS = ["MEMORY_SERVER_URL", "MEMORY_TIMEOUT_MS", "MEMORY_SETTLE_DELAY_MS", "MEMORY_PROJECT", "MEMORY_SKILL_NUDGE", "MEMORY_MIRROR_SKILLS", "MEMORY_SHOW_ACTIVITY"] as const;

// ----------------------------------------------------------------- project

export interface ProjectRef {
  key: string;
  name: string;
  remote: string | null;
}

/** git@github.com:foo/bar.git, https://user@github.com/foo/bar -> github.com/foo/bar (same as the pi extension's project.ts). */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = u.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/);
  if (scp && !/^[a-z]+:\/\//i.test(u)) u = `${scp[1]}/${scp[2]}`;
  u = u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "").replace(/:\d+\//, "/");
  return u.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
}

/** origin's `url =` from a .git/config text, as the pi extension reads it (not the push URL, not insteadOf-expanded). */
export function originFromGitConfig(cfg: string): string | null {
  const section = cfg.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\n\s*\[|$)/);
  const url = section?.[1]?.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
  return url || null;
}

export const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/**
 * The project of a session from `$.session.repo()` (root = the main working tree,
 * remote = origin's URL): the same key the pi extension computes, so one
 * repository is one project on the server whichever agent works in it.
 */
/** A path in the form keys use (same as the pi extension's keyPath). */
export function keyPath(p: string, windows: boolean): string {
  let t = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (windows) t = t.toLowerCase();
  return t;
}

/**
 * The project for a folder outside any git repository — never global: "home/<user>" for the
 * home directory itself, "home/<user>/<relative path>" under it, else "path/<absolute path>".
 * The same key the pi extension builds (pi-extension/project.ts folderProject).
 */
export function folderProject(cwd: string, home: string, user: string, windows: boolean): ProjectRef {
  const c = keyPath(cwd, windows);
  const h = keyPath(home, windows);
  const base = (x: string) => x.split("/").filter(Boolean).pop() ?? "";
  const who = user.trim() || base(keyPath(home, false));
  if (h && who && (c === h || c.startsWith(`${h}/`))) {
    const rel = c.slice(h.length).replace(/^\/+/, "");
    const userKey = `home/${who.toLowerCase()}`;
    return rel ? { key: `${userKey}/${rel}`, name: base(rel), remote: null } : { key: userKey, name: who, remote: null };
  }
  const abs = c.replace(/^\/+/, "");
  return abs ? { key: `path/${abs}`, name: base(abs), remote: null } : { key: "path/", name: "/", remote: null };
}

export function projectFromRepo(repo: { root: string; remote: string | null } | null, override: string): ProjectRef | null {
  if (override) return { key: override, name: override.split("/").pop() || override, remote: null };
  if (!repo) return null;
  const name = baseName(repo.root);
  return { key: repo.remote ? normalizeRemote(repo.remote) : `local/${name}`, name, remote: repo.remote };
}

// ------------------------------------------------------------------- turns

export interface TurnMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: { name: string; args: string }[];
  name?: string;
  isError?: boolean;
}

/** One row of `$.session.messages()` (the fields this mod reads). */
export interface SessionRow {
  role: "user" | "assistant";
  text: string;
  toolUses: readonly { tool_use_id: string; tool: string; input?: unknown }[];
  toolResults?: readonly { tool_use_id: string; text?: string; isError?: boolean; result?: unknown }[];
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
export const redact = (s: string) => SECRET_PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [truncated]` : s);
/** Reminders Claude Code itself adds to a user row are not the user's words. */
const stripReminders = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

/** This mod's tools reach Claude as mcp__memory-wiki__<name>; the server (curation prompt, pi turns) knows them by <name>. */
export const toolName = (name: string) => name.replace(/^mcp__memory-wiki__/, "");

const resultText = (r: { text?: string; result?: unknown }) => {
  if (r.text?.trim()) return r.text;
  if (r.result === undefined || r.result === null) return "";
  return typeof r.result === "string" ? r.result : JSON.stringify(r.result);
};

/**
 * Rows of one turn → the server's turn messages (same shape and limits as the
 * pi extension): user text, assistant text with its tool calls, tool results.
 */
export function toTurnMessages(rows: readonly SessionRow[]): TurnMessage[] {
  const toolNames = new Map<string, string>();
  const out: TurnMessage[] = [];
  for (const r of rows) {
    if (r.role === "assistant") {
      const toolCalls = r.toolUses.map((t) => {
        toolNames.set(t.tool_use_id, toolName(t.tool));
        return { name: toolName(t.tool), args: redact(clip(JSON.stringify(t.input ?? {}), 800)) };
      });
      const text = r.text.trim();
      if (!text && !toolCalls.length) continue;
      out.push({ role: "assistant", text: redact(clip(text, 6000)), ...(toolCalls.length ? { toolCalls } : {}) });
      continue;
    }
    const text = stripReminders(r.text ?? "");
    if (text) out.push({ role: "user", text: redact(clip(text, 6000)) });
    for (const t of r.toolResults ?? []) {
      out.push({ role: "tool", name: toolNames.get(t.tool_use_id) ?? "?", isError: Boolean(t.isError), text: redact(clip(resultText(t), 2000)) });
    }
  }
  return out;
}

/** A row's identity (role, text and tool ids): finds the row a turn started after, also after the list moved. */
export function rowKey(r: SessionRow | undefined): string | null {
  if (!r) return null;
  const ids = [...r.toolUses.map((t) => t.tool_use_id), ...(r.toolResults ?? []).map((t) => t.tool_use_id)].join(",");
  return `${r.role}\u0000${r.text}\u0000${ids}`;
}

/** Where a turn's rows begin: recorded at turn.start (and moved by a compaction during the turn). */
export interface TurnMark {
  /** The prompt as the turn began with it ("" for a continuation). */
  prompt: string;
  /** rowKey of the last row before the turn (null: the transcript was empty). */
  anchor: string | null;
  /** The transcript length then. */
  length: number;
}

/** $.session.messages() returns at most this many (the newest): a recorded length means nothing past it. */
export const MESSAGES_WINDOW = 4096;

/**
 * Where this turn's rows start in `$.session.messages()`: the last user row
 * with the prompt's text; else just after the anchor row (at the recorded
 * length when it is still there, else its last occurrence); else the recorded
 * length while the list is below its window; else null (unknown).
 */
export function locateTurn(rows: readonly SessionRow[], mark: TurnMark): number | null {
  const want = stripReminders(mark.prompt);
  if (want) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r && r.role === "user" && !r.toolResults?.length && stripReminders(r.text) === want) return i;
    }
  }
  if (mark.length < 0) return null; // turn.start could not read the transcript
  if (mark.anchor === null) return mark.length === 0 ? 0 : rows.length < MESSAGES_WINDOW && mark.length <= rows.length ? mark.length : null;
  if (mark.length > 0 && rowKey(rows[mark.length - 1]) === mark.anchor) return mark.length;
  for (let i = rows.length - 1; i >= 0; i--) if (rowKey(rows[i]) === mark.anchor) return i + 1;
  return rows.length < MESSAGES_WINDOW && mark.length <= rows.length ? mark.length : null;
}

/** Where the last prompt the user typed starts (a user row with text, not tool results): for a turn whose start was never recorded. */
export function lastPromptRow(rows: readonly SessionRow[]): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r.role === "user" && !r.toolResults?.length && stripReminders(r.text)) return i;
  }
  return null;
}

/** UTF-8 bytes of a value as JSON ($.store's 4 MiB is bytes; Korean text is 3 bytes a character). */
export const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** The server keeps the first 400 messages of a turn (server/src/turns.ts): never send more in one. */
export const MAX_TURN_MESSAGES = 400;
/** Stored and sent per chunk at most (UTF-8 bytes of JSON): $.store holds 4 MiB for every session on the machine. */
export const MAX_CHUNK_BYTES = 400_000;
/** All unsent chunks together (UTF-8 bytes of JSON); the oldest go first past it. */
export const MAX_PENDING_BYTES = 2_500_000;

/** Split a turn's messages into chunks the server takes whole (≤ 400 messages, ≤ MAX_CHUNK_BYTES each). */
export function chunkMessages(messages: readonly TurnMessage[], maxCount = MAX_TURN_MESSAGES, maxBytes = MAX_CHUNK_BYTES): TurnMessage[][] {
  const out: TurnMessage[][] = [];
  let cur: TurnMessage[] = [];
  let size = 0;
  for (const m of messages) {
    const n = jsonBytes(m);
    if (cur.length && (cur.length >= maxCount || size + n > maxBytes)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(m);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}


/** Tool use of one turn, for the skill nudge (only this mod's own skill_manage counts as saving one). */
export function runStats(messages: readonly TurnMessage[]) {
  const tools = new Set<string>();
  let calls = 0;
  let usedSkills = false;
  for (const m of messages) {
    for (const t of m.toolCalls ?? []) {
      calls++;
      tools.add(t.name);
      if (toolName(t.name) === "skill_manage") usedSkills = true;
    }
  }
  return { calls, tools: [...tools], usedSkills };
}

/** The hidden hint for the next prompt after a long, varied turn that saved no skill (null = none). */
export function skillHint(stats: ReturnType<typeof runStats>, threshold: number): string | null {
  if (threshold <= 0 || stats.calls < threshold || stats.tools.length < 2 || stats.usedSkills) return null;
  return (
    `<skill-hint note="From the memory-wiki plugin, not the user.">Your previous task took ${stats.calls} tool calls (${stats.tools.slice(0, 8).join(", ")}). ` +
    "If it was a procedure likely to recur and no skill covers it yet, save it with skill_manage after handling this request; " +
    "if a skill you followed was wrong or incomplete, update it. Otherwise ignore this note.</skill-hint>"
  );
}

// ------------------------------------------------------------------ skills

export interface SyncSkill {
  name: string;
  description: string;
  body: string;
  updated_at?: string;
}

export interface SkillsPayload {
  version?: string;
  global: SyncSkill[];
  project: { key: string; name: string; skills: SyncSkill[] } | null;
}

/** The server's (and Claude Code's) skill name rule: lowercase letters, digits, single hyphens, ≤64. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** First line of every SKILL.md this mod writes; a folder without it is never touched (it is someone else's). */
export const MIRROR_MARKER = "<!-- memory-wiki: synced from the memory server";

export const validSkill = (s: unknown): s is SyncSkill => {
  const k = s as SyncSkill;
  return Boolean(k) && typeof k.name === "string" && k.name.length <= 64 && SKILL_NAME_RE.test(k.name) && typeof k.description === "string" && k.description.trim() !== "" && typeof k.body === "string";
};

/** SKILL.md as Claude Code reads it: frontmatter (description JSON-quoted so nothing in it can break the YAML), the marker, the body. */
export function renderSkill(s: SyncSkill, server: string): string {
  return [
    "---",
    `name: ${s.name}`,
    `description: ${JSON.stringify(s.description.replace(/\s+/g, " ").trim())}`,
    "---",
    `${MIRROR_MARKER} (${server}). Local edits are overwritten on the next sync: change it on the server's web UI or with skill_manage. -->`,
    "",
    s.body.trim(),
    "",
  ].join("\n");
}

export const isMirrored = (text: string | null | undefined) => typeof text === "string" && text.split("\n").some((l) => l.startsWith(MIRROR_MARKER));

const RETIRED = "memory-wiki: retired";
/**
 * What is left of a skill the server dropped where its folder cannot be
 * removed (no process API, Windows): marked as ours, off for Claude.
 */
export function renderRetired(name: string, server: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(`Retired on the memory server — not a procedure any more; delete this folder.`)}`,
    "disable-model-invocation: true",
    "---",
    `${MIRROR_MARKER} (${server}). ${RETIRED}: the server no longer has this skill. -->`,
    "",
  ].join("\n");
}
export const isRetired = (text: string | null | undefined) => isMirrored(text) && (text ?? "").includes(RETIRED);

export interface MirrorPlan {
  /** Folders to (re)write: name → SKILL.md text. Only ones whose text differs. */
  write: { name: string; text: string }[];
  /** Folders this mod wrote earlier that the server no longer has (SKILL.md still carries the marker). */
  remove: string[];
  /** Server skills whose folder is someone else's (no marker, or no readable SKILL.md): left alone. */
  conflicts: string[];
  /** The names this mod owns once the plan is carried out (removals add back what could not be removed). */
  owned: string[];
}

/**
 * What to do in the skills folder. `current` has an entry for each folder that
 * exists among the names the server has or this mod owned: its SKILL.md text,
 * or null when the folder exists but SKILL.md cannot be read. No entry = no
 * folder. A folder is only written or removed when it is absent or carries the
 * marker (G-072).
 */
export function planMirror(skills: readonly SyncSkill[], owned: readonly string[], current: ReadonlyMap<string, string | null>, server: string): MirrorPlan {
  const want = new Map<string, string>();
  for (const s of skills) if (validSkill(s) && !want.has(s.name)) want.set(s.name, renderSkill(s, server));
  const plan: MirrorPlan = { write: [], remove: [], conflicts: [], owned: [] };
  for (const [name, text] of want) {
    if (current.has(name) && !isMirrored(current.get(name))) {
      plan.conflicts.push(name);
      continue;
    }
    plan.owned.push(name);
    if (current.get(name) !== text) plan.write.push({ name, text });
  }
  for (const name of owned) {
    if (want.has(name) || !current.has(name)) continue; // still wanted, or already gone
    if (isMirrored(current.get(name))) plan.remove.push(name);
  }
  plan.owned.sort();
  return plan;
}

/** Global skills not installed here (mirroring off, a name taken by a local skill, a failed write): listed for skill_manage view. */
export function globalSkillsNote(skills: readonly SyncSkill[], shadowed: readonly string[] = []): string {
  const list = skills.filter(validSkill);
  if (!list.length) return "";
  return [
    "<global-skills>",
    "Procedures saved on the memory server for every repository (not installed as skills here): when a task matches one, read it with skill_manage (action view, scope global) and follow it.",
    ...list.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").trim()}${shadowed.includes(s.name) ? " (a local skill of the same name is not this one)" : ""}`),
    "</global-skills>",
  ].join("\n");
}

/** The memory block's note on this project's skills: they stay on the server and are read with skill_manage. */
export function projectSkillsNote(project: SkillsPayload["project"], mirroredGlobal: readonly string[]): string {
  const skills = (project?.skills ?? []).filter(validSkill);
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").trim()}${mirroredGlobal.includes(s.name) ? " (use this one, not the global skill of the same name)" : ""}`);
  return [
    "<project-skills>",
    "Procedures saved for this repository on the memory server. They are not installed as skills: when a task matches one, read it with skill_manage (action view, scope project) and follow it.",
    ...lines,
    "</project-skills>",
  ].join("\n");
}

// ------------------------------------------------------------------- tools

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Loaded upfront (not behind Claude Code's tool search). */
  eager?: boolean;
}

const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const bool = (description?: string) => ({ type: "boolean", ...(description ? { description } : {}) });
const numb = (description?: string) => ({ type: "number", ...(description ? { description } : {}) });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const target = {
  type: "string",
  enum: ["memory", "user", "project", "failure"],
  description: "memory = global facts for every project, user = about the user, project = this repository only, failure = what did not work and why",
};

/** The tools this mod gives Claude (as mcp__<plugin>__<name>); same names and arguments as the pi extension's. */
export const TOOLS: ToolDef[] = [
  {
    name: "memory_search",
    eager: true,
    description:
      "Search the persistent memory (this project + global + user profile) for conventions, decisions, past failures, preferences and environment facts. Use before acting when earlier context may matter.",
    inputSchema: obj(
      {
        query: str("Keywords or a natural-language question"),
        scope: { type: "string", enum: ["all", "project", "global", "user"] },
        category: str("fact, convention, preference, decision, failure, correction, insight, tool-quirk"),
        limit: numb(),
      },
      ["query"],
    ),
  },
  {
    name: "session_search",
    description: "Search past conversation turns (prompts and answers) from earlier sessions on any machine.",
    inputSchema: obj({ query: str(), all_projects: bool("Search every project instead of only the current one"), limit: numb() }, ["query"]),
  },
  {
    name: "memory_graph",
    description:
      'Explore the memory graph. entity: everything remembered about a technology/service/tool/file (e.g. "PostgreSQL", "docker compose") plus co-occurring entities. id: one memory with its entities and typed links (because, depends_on, supersedes, related) — why it exists and what it depends on.',
    inputSchema: obj({ entity: str("Entity name, e.g. PostgreSQL"), id: numb("Memory id, e.g. 12 for [#12]") }),
  },
  {
    name: "wiki_search",
    description:
      "Search the long-form wiki (this project's wiki + the global wiki): overview, architecture, conventions, decisions, procedures, troubleshooting. Returns page slugs and snippets; open one with wiki_read.",
    inputSchema: obj({ query: str(), all_projects: bool("Search every project's wiki"), limit: numb() }, ["query"]),
  },
  {
    name: "wiki_read",
    description: 'Read a wiki page by slug (see <wiki-pages> in the system prompt). Prefix "global:" for a global wiki page.',
    inputSchema: obj({ slug: str() }, ["slug"]),
  },
  {
    name: "wiki_write",
    description:
      "Create or update a wiki page. Only when the user asks to document something in the wiki. Updating: read the page with wiki_read first, then send the full new body (mode replace) or just a new section (mode append). Pages form a tree: give a new page a \"parent\" when it belongs under an existing page. Write for people: a 1-3 sentence summary first; ## sections and ### subsections (they become the table of contents; no manual TOC); tables for anything with repeated fields (settings, comparisons, versions, commands); numbered steps for procedures; short paragraphs, no walls of text; no '# Title' line; link pages with [[slug]].",
    inputSchema: obj(
      {
        slug: str("Page slug, e.g. architecture, deploy, troubleshooting"),
        title: str("Page title (required when creating)"),
        body: str("Markdown body"),
        mode: { type: "string", enum: ["replace", "append"], description: "For an existing page. Default replace" },
        global: bool("Write to the global wiki instead of this project's"),
        reason: str("Short change note for the page history"),
        parent: str("Slug of an existing page in the same wiki to put this page under (pages form a tree); empty string = top level; omit to leave it where it is"),
      },
      ["slug", "body"],
    ),
  },
  {
    name: "memory_add",
    description: "Save a durable memory. Only when the user explicitly asks to remember something; turns are curated automatically otherwise.",
    inputSchema: obj({ target, content: str("The fact, self-contained. First line may be a short title."), title: str(), category: str() }, ["target", "content"]),
  },
  {
    name: "memory_replace",
    description: "Replace an existing memory, found by a unique substring of its text.",
    inputSchema: obj({ target, old_text: str(), content: str(), title: str() }, ["target", "old_text", "content"]),
  },
  {
    name: "memory_remove",
    description: "Delete an existing memory, found by a unique substring of its text.",
    inputSchema: obj({ target, old_text: str() }, ["target", "old_text"]),
  },
  {
    name: "skill_manage",
    eager: true,
    description: [
      "Manage reusable procedures (skills) kept on the memory server: list, view, create, update. Skills capture HOW to do something (deploy, release, debug, migrate), not facts — facts go to memory. Deleting is done by the user on the memory server's web UI.",
      "Global skills are installed as Claude Code skills (or, with installing off, listed in <global-skills>); this project's skills stay on the server (listed in <project-skills>) — read one with view before following it.",
      "Use it after finishing a task that took trial and error or many tool calls and is likely to recur, or when the user teaches you a workflow; skip one-off task state.",
      "create needs scope: 'project' when the procedure depends on this repository's paths, scripts or deploy flow, 'global' when it transfers to other repositories.",
      "Put the trigger signals a user would actually type (task names, error strings, symptoms) in description: skills are picked by name and description alone.",
      "Prefer the structured fields (when_to_use, procedure_steps, pitfalls, verification_steps) over a free-form body. To change a skill, view it first, then update with the updated_at you saw (send the full new body or all structured fields).",
      "A skill can wait for a person's approval (a candidate, or an edit waiting for approval): do not create or send it again. A locked skill can only be changed by people.",
    ].join(" "),
    inputSchema: obj(
      {
        action: { type: "string", enum: ["list", "view", "create", "update"] },
        name: str("Skill name: lowercase letters, digits, single hyphens, e.g. deploy-release"),
        scope: { type: "string", enum: ["global", "project"], description: "Required for create. For view/update: which one when both exist (default: this project's)" },
        description: str("What it does and when to use it, with trigger phrases; one line, max 1024 characters. Required for create"),
        when_to_use: str(),
        procedure_steps: { type: "array", items: { type: "string" }, description: "Ordered concrete steps" },
        pitfalls: { type: "array", items: { type: "string" } },
        verification_steps: { type: "array", items: { type: "string" }, description: "Checks that prove it worked" },
        body: str("Free-form Markdown body instead of the structured fields"),
        updated_at: str("Required for update: the updated_at from view"),
      },
      ["action"],
    ),
  },
];

export interface Request {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

type Args = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const projectBody = (p: ProjectRef | null) => (p ? { key: p.key, name: p.name, remote: p.remote } : null);

/** The server request for a tool call, or a string to answer with at once (bad arguments). */
export function toolRequest(name: string, a: Args, project: ProjectRef | null): Request | string {
  const q = new URLSearchParams();
  switch (name) {
    case "memory_search": {
      q.set("q", s(a.query));
      q.set("limit", String(a.limit ?? 10));
      q.set("via", "agent");
      if (project) q.set("project", project.key);
      if (a.scope && a.scope !== "all") q.set("scope", s(a.scope));
      if (a.category) q.set("category", s(a.category));
      return { method: "GET", path: `/search?${q}` };
    }
    case "session_search":
      q.set("q", s(a.query));
      q.set("limit", String(a.limit ?? 8));
      if (project && !a.all_projects) q.set("project", project.key);
      return { method: "GET", path: `/session-search?${q}` };
    case "memory_graph":
      if (!a.entity && !a.id) return "Give an entity name or a memory id.";
      q.set("via", "agent");
      if (a.entity) q.set("entity", s(a.entity));
      if (a.id) q.set("id", s(a.id));
      if (project) q.set("project", project.key);
      return { method: "GET", path: `/graph/neighbors?${q}` };
    case "wiki_search":
      q.set("q", s(a.query));
      q.set("limit", String(a.limit ?? 8));
      if (a.all_projects) q.set("all", "1");
      else if (project) q.set("project", project.key);
      return { method: "GET", path: `/wiki/search?${q}` };
    case "wiki_read":
      q.set("slug", s(a.slug));
      if (project) q.set("project", project.key);
      return { method: "GET", path: `/wiki/read?${q}` };
    case "wiki_write":
      return { method: "POST", path: "/agent/wiki", body: { ...a, project: projectBody(project) } };
    case "memory_add":
      return { method: "POST", path: "/agent/memory", body: { action: "add", ...a, project: projectBody(project) } };
    case "memory_replace":
      return { method: "POST", path: "/agent/memory", body: { action: "replace", ...a, project: projectBody(project) } };
    case "memory_remove":
      return { method: "POST", path: "/agent/memory", body: { action: "remove", ...a, project: projectBody(project) } };
    case "skill_manage": {
      const body = a.action === "create" || a.action === "update" ? skillBody(a) : undefined;
      if (a.action === "create" && !body) return "create needs procedure_steps (with when_to_use, pitfalls, verification_steps) or a body.";
      if (a.action === "update" && !body) {
        const partial = Boolean(s(a.when_to_use).trim() || (Array.isArray(a.pitfalls) && a.pitfalls.length) || (Array.isArray(a.verification_steps) && a.verification_steps.length));
        if (partial) return "update replaces the whole body: send procedure_steps together with when_to_use, pitfalls and verification_steps (view the skill first), or a full body. Nothing was changed.";
        if (a.description === undefined) return "update needs a new body (or procedure_steps) and/or description. Nothing was changed.";
      }
      return {
        method: "POST",
        path: "/agent/skill",
        body: { action: a.action, name: a.name, scope: a.scope, description: a.description, body, updated_at: a.updated_at, project: projectBody(project) },
      };
    }
  }
  return `unknown tool ${name}`;
}

const list = (items: unknown, ordered: boolean) =>
  (Array.isArray(items) ? items : [])
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .map((x, i) => `${ordered ? `${i + 1}.` : "-"} ${x.trim()}`)
    .join("\n");

/** A SKILL.md body from `body`, or from the structured fields (When to Use / Procedure / Pitfalls / Verification). */
export function skillBody(p: Args): string | undefined {
  if (typeof p.body === "string" && p.body.trim()) return p.body.trim();
  const steps = list(p.procedure_steps, true);
  if (!steps) return undefined;
  const when = s(p.when_to_use).trim();
  return [when && `## When to Use\n${when}`, `## Procedure\n${steps}`, list(p.pitfalls, false) && `## Pitfalls\n${list(p.pitfalls, false)}`, list(p.verification_steps, true) && `## Verification\n${list(p.verification_steps, true)}`]
    .filter(Boolean)
    .join("\n\n");
}

interface EntryLite {
  id: number;
  scope: string;
  category: string;
  title: string;
  body: string;
}

export function fmtEntries(entries: readonly EntryLite[]): string {
  if (!entries.length) return "No matching memories.";
  return entries.map((e) => `#${e.id} [${e.scope}/${e.category}] ${e.title}${e.body ? `\n  ${e.body.replace(/\n/g, "\n  ")}` : ""}`).join("\n");
}

export interface AgentSkill {
  scope: "global" | "project";
  name: string;
  description: string;
  body?: string;
  author: string;
  updated_at: string;
  status?: "active" | "candidate";
  locked?: boolean;
  pending_edit?: boolean | { description: string; body: string; at: string } | null;
}

export interface SkillReply {
  action: string;
  skills?: AgentSkill[];
  skill?: AgentSkill;
  version?: string;
  previous_version?: string;
  changed?: boolean;
  proposed?: boolean;
}

const flags = (k: AgentSkill) =>
  [k.status === "candidate" && "candidate: waiting for approval", k.locked && "locked", k.pending_edit && "edit waiting for approval"].filter(Boolean).join(", ");

/** Whether a skill_manage write reached the PCs at once (not waiting for a person, not a no-op). */
export const skillWriteIsLive = (r: SkillReply) => (r.action === "create" || r.action === "update") && r.changed !== false && r.skill?.status !== "candidate" && !r.proposed;

/** The text Claude reads for a tool's server answer (same wording as the pi extension). */
export function formatTool(name: string, a: Args, data: any): string {
  switch (name) {
    case "memory_search":
      return fmtEntries(data as EntryLite[]);
    case "session_search": {
      const hits = data as { id: number; project_name: string | null; created_at: string; snippet: string }[];
      if (!hits.length) return "No matching past turns.";
      return hits.map((h) => `turn #${h.id} · ${h.project_name ?? "no project"} · ${h.created_at.slice(0, 16)}\n  ${h.snippet}`).join("\n");
    }
    case "memory_graph": {
      if (data.kind === "entity") {
        const head = `${data.entity.name} (${data.entity.kind})${data.entity.description ? ` — ${data.entity.description}` : ""}`;
        const rel = data.related.length ? `\nRelated entities: ${data.related.map((x: { name: string }) => x.name).join(", ")}` : "";
        return `${head}\n\n${fmtEntries(data.memories)}${rel}`;
      }
      const verbs: Record<string, Record<string, string>> = {
        out: { because: "because of", depends_on: "depends on", supersedes: "replaces", related: "related to" },
        in: { because: "is the reason for", depends_on: "is needed by", supersedes: "was replaced by", related: "related to" },
      };
      const links = (data.links as { dir: string; type: string; other: { id: number; title: string; category: string } }[])
        .map((l) => `  ${verbs[l.dir]?.[l.type] ?? l.type} #${l.other.id} [${l.other.category}] ${l.other.title}`)
        .join("\n");
      return `${fmtEntries([data.memory])}\nEntities: ${(data.entities as { name: string }[]).map((e) => e.name).join(", ") || "(none)"}${links ? `\nLinks:\n${links}` : "\nLinks: (none)"}`;
    }
    case "wiki_search": {
      const hits = data as { slug: string; title: string; project_id: number | null; snippet: string }[];
      if (!hits.length) return "No matching wiki pages.";
      return hits.map((h) => `${h.project_id == null ? "global:" : ""}${h.slug} — ${h.title}\n  ${h.snippet}`).join("\n");
    }
    case "wiki_read":
      return `# ${data.title}\n(updated ${s(data.updated_at).slice(0, 10)}; [[slug]] = wiki link, [#id] = memory reference)\n\n${data.body}`;
    case "wiki_write":
      return `${data.action}: ${data.page.project_id == null ? "global:" : ""}${data.page.slug} — ${data.page.title}`;
    case "memory_add":
    case "memory_replace":
    case "memory_remove":
      return `${data.action}: #${data.entry.id} [${data.entry.scope}/${data.entry.category}] ${data.entry.title}`;
    case "skill_manage":
      return formatSkill(a, data as SkillReply);
  }
  return JSON.stringify(data);
}

function formatSkill(a: Args, res: SkillReply): string {
  if (res.skills) {
    if (!res.skills.length) return "No skills yet.";
    return res.skills.map((k) => `${k.scope}:${k.name} — ${k.description} (by ${k.author}, updated_at ${k.updated_at}${flags(k) ? `; ${flags(k)}` : ""})`).join("\n");
  }
  const k = res.skill;
  if (!k) return JSON.stringify(res);
  if (res.action === "view") {
    const pending = typeof k.pending_edit === "object" && k.pending_edit ? `\n\n--- edit waiting for approval ---\n${k.pending_edit.description}\n\n${k.pending_edit.body}` : "";
    return `${k.scope}:${k.name} (by ${k.author}, updated_at ${k.updated_at}${flags(k) ? `; ${flags(k)}` : ""})\n${k.description}\n\n${k.body ?? ""}${pending}`;
  }
  if (res.changed === false) return `no change: ${k.scope}:${k.name} already matches what you sent (updated_at ${k.updated_at}).`;
  if (k.status === "candidate") {
    return `${res.action === "create" ? "created" : "updated"} ${k.scope}:${k.name} as a candidate: it waits for a person to approve it on the memory server's web UI, and no PC gets it until then. Do not create it again.`;
  }
  if (res.proposed) return `proposed an edit to ${k.scope}:${k.name}: it waits for a person to approve it on the memory server's web UI; the current version stays in use until then.`;
  const created = res.action === "create";
  const where = k.scope === "global" ? " PCs that install global skills get it as a Claude Code skill." : " It stays on the server: read it with skill_manage view.";
  return `${created ? "created" : "updated"} ${k.scope}:${k.name} (updated_at ${k.updated_at}) on the memory server.${where}`;
}

// ---------------------------------------------------------------- activity

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const CHANGE_OPS = new Set(["add", "update", "delete"]);
const OP_MARK: Record<string, string> = { add: "+", update: "~", delete: "-" };

/**
 * The transcript line for memories recalled for a prompt, or null when none were (same
 * rules as the pi extension's memory_recall card: titles from recalledEntries, else from
 * the "- [#id] title" lines of an older server's recall block).
 */
export function recallLine(res: { recall?: unknown; recalledEntries?: unknown }): string | null {
  if (typeof res.recall !== "string" || !res.recall.trim()) return null;
  let entries: { id: number; title: string }[] = [];
  if (Array.isArray(res.recalledEntries)) {
    entries = res.recalledEntries
      .filter(isObj)
      .filter((e) => typeof e.id === "number")
      .map((e) => ({ id: e.id as number, title: typeof e.title === "string" ? e.title : "" }));
  }
  if (!entries.length) {
    for (const m of res.recall.matchAll(/^- \[#(\d+)\] (.*)$/gm)) entries.push({ id: Number(m[1]), title: (m[2] ?? "").split(": ")[0] ?? "" });
  }
  if (!entries.length) return null;
  const n = entries.length;
  return `🧠 memory_recall · ${n} ${n === 1 ? "memory" : "memories"} · ${entries.map((e) => `#${e.id} ${e.title}`.trim()).join(", ")}`;
}

/** The transcript line for a curated turn, or null when it changed no memory (confirm only, skipped, error, not done). */
export function curationLine(status: unknown, result: unknown): string | null {
  if (status !== "done" || !isObj(result) || !Array.isArray(result.applied)) return null;
  const applied = result.applied.filter(isObj).filter((a) => typeof a.op === "string" && CHANGE_OPS.has(a.op) && typeof a.entryId === "number");
  if (!applied.length) return null;
  const count = (op: string) => applied.filter((a) => a.op === op).length;
  const summary = [
    [count("add"), "added"],
    [count("update"), "updated"],
    [count("delete"), "deleted"],
  ]
    .filter(([c]) => (c as number) > 0)
    .map(([c, w]) => `${c} ${w}`)
    .join(" · ");
  const list = applied.map((a) => `${OP_MARK[a.op as string]} #${a.entryId} ${typeof a.title === "string" ? a.title : ""}`.trim()).join(", ");
  return `🧠 memory_curate · ${summary} — ${list}`;
}

/** The statuses GET /turns/:id/status answers; anything else (an old server's index.html) is a failed poll. */
export const TURN_STATUSES = ["pending", "processing", "done", "skipped", "error"];
