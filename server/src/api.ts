import { Hono, type Context } from "hono";
import { buildContext } from "./context.ts";
import { CATEGORIES, type Entry, type Scope } from "./db.ts";
import { searchEntries, searchTurns } from "./search.ts";
import {
  HttpError,
  createEntry,
  deleteEntry,
  deleteProject,
  getEntry,
  getProject,
  getProjectByKey,
  listEntries,
  listProjects,
  listRevisions,
  purgeEntry,
  recentActivity,
  restoreEntry,
  revertEntry,
  stats,
  updateEntry,
  updateProject,
  upsertProject,
  visibleEntries,
  type ProjectRef,
} from "./store.ts";
import { deleteTurn, enqueueTurn, getTurn, listTurns, retryTurn } from "./turns.ts";
import { config, llmEnabled } from "./config.ts";
import {
  backlinks,
  citedEntries,
  composableTurns,
  createPage,
  deletePage,
  getPage,
  getPageBySlug,
  listJobs,
  listPages,
  missingLinks,
  pageRevisions,
  pagesCitingEntry,
  restorePage,
  retryJob,
  revertPage,
  enqueueCompose,
  searchWiki,
  updatePage,
  wikiStats,
} from "./wiki.ts";

export const api = new Hono();

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: (err as Error).message }, 500);
});

const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
const idParam = (c: Context) => {
  const id = num(c.req.param("id"));
  if (!id) throw new HttpError(400, "invalid id");
  return id;
};
async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function projectFromRef(ref: ProjectRef | null | undefined) {
  return ref?.key ? upsertProject(ref) : null;
}

// ------------------------------------------------------------ agent-facing

api.get("/health", (c) => c.json({ ok: true, llm: llmEnabled() ? config.llm.model : null, ...stats(), ...wikiStats() }));

/** Called by the pi extension before every run. Upserts the project. */
api.post("/context", async (c) => {
  const b = await body<{ project?: ProjectRef | null; prompt?: string }>(c);
  const project = projectFromRef(b.project);
  const ctx = buildContext(project, String(b.prompt ?? "").slice(0, 8000));
  return c.json({ project, ...ctx });
});

api.get("/context/preview", (c) => {
  const id = num(c.req.query("project_id"));
  const project = id ? getProject(id) : null;
  return c.json({ project, ...buildContext(project, c.req.query("prompt") ?? "") });
});

api.post("/turns", async (c) => {
  const b = await body<Parameters<typeof enqueueTurn>[0]>(c);
  const t = enqueueTurn(b);
  return c.json({ id: t.id, status: t.status }, 202);
});

api.get("/search", (c) => {
  const q = c.req.query("q") ?? "";
  const key = c.req.query("project");
  const projectId = num(c.req.query("project_id")) ?? (key ? getProjectByKey(key)?.id : undefined);
  const scope = c.req.query("scope") as Scope | undefined;
  const hits = searchEntries(q, {
    projectId: projectId ?? null,
    scopes: scope ? [scope] : undefined,
    category: c.req.query("category") || undefined,
    limit: num(c.req.query("limit")) ?? 20,
    allProjects: c.req.query("all") === "1",
  });
  return c.json(hits.map((h) => ({ ...h.entry, score: Math.round(h.score * 100) / 100 })));
});

api.get("/session-search", (c) => {
  const key = c.req.query("project");
  const projectId = num(c.req.query("project_id")) ?? (key ? getProjectByKey(key)?.id : undefined);
  return c.json(searchTurns(c.req.query("q") ?? "", { projectId, limit: num(c.req.query("limit")) ?? 10 }));
});

/** Hermes-compatible memory tools: add / replace / remove by substring. */
type AgentTarget = "memory" | "user" | "project" | "failure";
api.post("/agent/memory", async (c) => {
  const b = await body<{
    action: "add" | "replace" | "remove";
    target: AgentTarget;
    content?: string;
    title?: string;
    old_text?: string;
    category?: string;
    project?: ProjectRef | null;
  }>(c);
  const project = projectFromRef(b.project);
  const target = b.target ?? "memory";
  let scope: Scope = target === "user" ? "user" : target === "memory" ? "global" : "project";
  if (scope === "project" && !project) {
    if (target === "project") throw new HttpError(400, "not inside a project; use target \"memory\" for global memories");
    scope = "global";
  }
  const category = target === "failure" ? "failure" : b.category;
  const meta = { author: "agent" as const };
  const split = (content: string) => {
    const text = content.trim();
    if (b.title?.trim()) return { title: b.title.trim(), body: text };
    const firstLine = text.split("\n")[0];
    if (firstLine.length <= 80 && text.includes("\n")) return { title: firstLine, body: text.slice(firstLine.length).trim() };
    return { title: text.length <= 80 ? text : `${text.slice(0, 77)}…`, body: text.length <= 80 ? "" : text };
  };
  const findOne = (needle: string): Entry => {
    const n = needle.trim().toLowerCase();
    if (!n) throw new HttpError(400, "old_text is required");
    const pool = listEntries({ scope, projectId: scope === "project" ? project!.id : undefined }).filter(
      (e) => e.category !== "standing" && `${e.title}\n${e.body}`.toLowerCase().includes(n),
    );
    if (!pool.length) throw new HttpError(404, `no ${target} memory contains "${needle}"`);
    if (pool.length > 1) {
      throw new HttpError(409, `"${needle}" matches ${pool.length} memories, be more specific: ${pool.slice(0, 5).map((e) => `#${e.id} ${e.title}`).join(" | ")}`);
    }
    return pool[0];
  };

  if (b.action === "add") {
    if (!b.content?.trim()) throw new HttpError(400, "content is required");
    const e = createEntry({ scope, project_id: project?.id ?? null, category, ...split(b.content) }, meta);
    return c.json({ ok: true, action: "add", entry: e });
  }
  if (b.action === "replace") {
    if (!b.content?.trim()) throw new HttpError(400, "content is required");
    const cur = findOne(b.old_text ?? "");
    const e = updateEntry(cur.id, { ...split(b.content), category }, meta);
    return c.json({ ok: true, action: "replace", entry: e });
  }
  if (b.action === "remove") {
    const cur = findOne(b.old_text ?? "");
    const e = deleteEntry(cur.id, meta);
    return c.json({ ok: true, action: "remove", entry: e });
  }
  throw new HttpError(400, "action must be add, replace or remove");
});

// ------------------------------------------------------------------ wiki

api.get("/meta", (c) => c.json({ categories: CATEGORIES, llm: llmEnabled() ? config.llm.model : null }));
api.get("/stats", (c) => c.json({ ...stats(), ...wikiStats() }));

api.get("/projects", (c) => c.json(listProjects()));
api.get("/projects/:id", (c) => {
  const p = getProject(idParam(c));
  if (!p) throw new HttpError(404, "project not found");
  return c.json(p);
});
api.patch("/projects/:id", async (c) => c.json(updateProject(idParam(c), await body(c))));
api.delete("/projects/:id", (c) => {
  deleteProject(idParam(c));
  return c.json({ ok: true });
});

api.get("/entries", (c) =>
  c.json(
    listEntries({
      scope: (c.req.query("scope") as Scope) || undefined,
      projectId: num(c.req.query("project_id")),
      category: c.req.query("category") || undefined,
      deleted: c.req.query("deleted") === "1",
      limit: num(c.req.query("limit")) ?? 1000,
    }),
  ),
);
api.get("/entries/visible", (c) => c.json(visibleEntries(num(c.req.query("project_id")) ?? null)));
api.get("/entries/:id", (c) => {
  const e = getEntry(idParam(c));
  if (!e) throw new HttpError(404, "entry not found");
  return c.json({ entry: e, project: e.project_id ? getProject(e.project_id) : null, revisions: listRevisions(e.id), citedBy: pagesCitingEntry(e.id) });
});
api.post("/entries", async (c) => c.json(createEntry(await body(c), { author: "human" }), 201));
api.patch("/entries/:id", async (c) => c.json(updateEntry(idParam(c), await body(c), { author: "human" })));
api.delete("/entries/:id", (c) => c.json(deleteEntry(idParam(c), { author: "human" })));
api.post("/entries/:id/restore", (c) => c.json(restoreEntry(idParam(c), { author: "human" })));
api.post("/entries/:id/revert", async (c) => {
  const b = await body<{ revisionId: number }>(c);
  return c.json(revertEntry(idParam(c), Number(b.revisionId), { author: "human" }));
});
api.delete("/entries/:id/purge", (c) => {
  purgeEntry(idParam(c));
  return c.json({ ok: true });
});

api.get("/activity", (c) => c.json(recentActivity(num(c.req.query("limit")) ?? 100, num(c.req.query("before")))));

api.get("/turns", (c) =>
  c.json(
    listTurns({
      projectId: num(c.req.query("project_id")),
      status: c.req.query("status") || undefined,
      limit: num(c.req.query("limit")) ?? 50,
      before: num(c.req.query("before")),
    }),
  ),
);
api.get("/turns/:id", (c) => {
  const t = getTurn(idParam(c));
  if (!t) throw new HttpError(404, "turn not found");
  return c.json({ ...t, project: t.project_id ? getProject(t.project_id) : null });
});
api.post("/turns/:id/retry", (c) => c.json(retryTurn(idParam(c))));
api.delete("/turns/:id", (c) => {
  deleteTurn(idParam(c));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ wiki

/** Wiki scope from the query: project_id (0 or absent = global) or project key. */
function wikiScope(c: Context): number | null {
  const key = c.req.query("project");
  if (key) {
    const p = getProjectByKey(key);
    if (!p) throw new HttpError(404, `unknown project ${key}`);
    return p.id;
  }
  const id = num(c.req.query("project_id"));
  return id ? id : null;
}

api.get("/wiki/pages", (c) => c.json(listPages(wikiScope(c), { deleted: c.req.query("deleted") === "1" })));
api.get("/wiki/missing", (c) => c.json(missingLinks(wikiScope(c))));
api.get("/wiki/pages/:id", (c) => {
  const p = getPage(idParam(c));
  if (!p) throw new HttpError(404, "page not found");
  return c.json({
    page: p,
    project: p.project_id ? getProject(p.project_id) : null,
    revisions: pageRevisions(p.id),
    backlinks: backlinks(p),
    cites: citedEntries(p),
  });
});
api.get("/wiki/by-slug", (c) => {
  const p = getPageBySlug(wikiScope(c), c.req.query("slug") ?? "");
  if (!p) throw new HttpError(404, "page not found");
  return c.json(p);
});
api.post("/wiki/pages", async (c) => {
  const b = await body<{ project_id?: number | null; slug?: string; title: string; body?: string; locked?: boolean }>(c);
  return c.json(createPage(b.project_id || null, b, { author: "human" }), 201);
});
api.patch("/wiki/pages/:id", async (c) => c.json(updatePage(idParam(c), await body(c), { author: "human" })));
api.delete("/wiki/pages/:id", (c) => c.json(deletePage(idParam(c), { author: "human" })));
api.post("/wiki/pages/:id/restore", (c) => c.json(restorePage(idParam(c), { author: "human" })));
api.post("/wiki/pages/:id/revert", async (c) => {
  const b = await body<{ revisionId: number }>(c);
  return c.json(revertPage(idParam(c), Number(b.revisionId), { author: "human" }));
});
api.get("/wiki/search", (c) =>
  c.json(
    searchWiki(c.req.query("q") ?? "", {
      projectId: c.req.query("all") === "1" ? undefined : wikiScope(c),
      allProjects: c.req.query("all") === "1",
      limit: num(c.req.query("limit")) ?? 10,
    }).map((h) => ({ ...h.page, body: undefined, snippet: h.snippet, score: Math.round(h.score * 100) / 100 })),
  ),
);
/** Agent read: the page from the project wiki, falling back to the global wiki ("global:slug" forces global). */
api.get("/wiki/read", (c) => {
  let slug = c.req.query("slug") ?? "";
  let scope: number | null = wikiScope(c);
  if (slug.startsWith("global:")) {
    slug = slug.slice(7);
    scope = null;
  }
  const p = getPageBySlug(scope, slug) ?? (scope != null ? getPageBySlug(null, slug) : null);
  if (!p || p.deleted_at) {
    const pages = [...(scope != null ? listPages(scope) : []), ...listPages(null)].map((x) => x.slug);
    throw new HttpError(404, `no wiki page "${slug}". Pages: ${pages.join(", ") || "(none)"}`);
  }
  return c.json(p);
});
api.get("/wiki/jobs", (c) => {
  const pid = c.req.query("project_id");
  return c.json(listJobs({ projectId: pid === undefined ? undefined : num(pid) || null, status: c.req.query("status") || undefined }));
});

// --------------------------------------------------- compose (turns → wiki)

/** Turns available to a wiki, with whether each was already composed into it. */
api.get("/wiki/compose/turns", (c) =>
  c.json(
    composableTurns(wikiScope(c), {
      sessionId: c.req.query("session_id") || undefined,
      uncomposed: c.req.query("uncomposed") === "1",
      limit: num(c.req.query("limit")) ?? 200,
    }),
  ),
);

/**
 * Start a compose job. Turns: explicit turn_ids, or every turn of session_id,
 * or (neither) the turns not yet composed into this wiki, oldest first.
 * Wiki: project_id (0/absent = global) or project (key, from the pi extension).
 */
api.post("/wiki/compose", async (c) => {
  const b = await body<{ project_id?: number | null; project?: ProjectRef | null; turn_ids?: number[]; session_id?: string; instruction?: string }>(
    c,
  );
  let projectId: number | null = b.project_id || null;
  if (b.project?.key) {
    const p = getProjectByKey(b.project.key);
    if (!p) throw new HttpError(404, `unknown project ${b.project.key} (no turns recorded yet)`);
    projectId = p.id;
  }
  let ids = Array.isArray(b.turn_ids) ? b.turn_ids : [];
  if (!ids.length) {
    const max = config.wiki.composeMaxTurns;
    const pool = composableTurns(projectId, { sessionId: b.session_id, uncomposed: !b.session_id, limit: max });
    ids = pool.map((t) => t.id);
    if (!ids.length) throw new HttpError(400, b.session_id ? "this session has no recorded turns yet" : "every turn is already composed into this wiki");
  }
  return c.json(enqueueCompose(projectId, ids, b.instruction), 201);
});

// --------------------------------------------------- agent writes (wiki_write)

/**
 * Agent page write by slug: create, replace the body, or append a section.
 * Locked pages refuse agent writes (423). Default wiki: the agent's project.
 */
api.post("/agent/wiki", async (c) => {
  const b = await body<{ project?: ProjectRef | null; global?: boolean; slug: string; title?: string; body: string; mode?: "replace" | "append"; reason?: string }>(
    c,
  );
  const project = b.global ? null : projectFromRef(b.project);
  const projectId = project?.id ?? null;
  const text = String(b.body ?? "").trim();
  if (!text) throw new HttpError(400, "body is required");
  const meta = { author: "agent" as const, reason: b.reason ?? null };
  const existing = getPageBySlug(projectId, String(b.slug ?? b.title ?? ""));
  if (!existing || existing.deleted_at) {
    const page = createPage(projectId, { slug: b.slug, title: b.title?.trim() || b.slug, body: text }, meta);
    return c.json({ action: "create", page }, 201);
  }
  const next = b.mode === "append" ? `${existing.body.trimEnd()}\n\n${text}` : text;
  const page = updatePage(existing.id, { title: b.title?.trim() || undefined, body: next }, meta);
  return c.json({ action: b.mode === "append" ? "append" : "replace", page });
});
api.post("/wiki/jobs/:id/retry", (c) => c.json(retryJob(idParam(c))));
