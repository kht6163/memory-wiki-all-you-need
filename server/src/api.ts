import { Hono, type Context } from "hono";
import { buildContext } from "./context.ts";
import { DebugForcedError, debugEnabled, debugLog, debugLogStream, debugState, listDebugLogs, msSince, setDebug } from "./debug-log.ts";
import { embedStats, queryVector, type QueryInfo } from "./embeddings.ts";
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
  projectAliases,
  listEntries,
  listProjects,
  listRevisions,
  purgeEntry,
  recentActivity,
  recordShown,
  recordUsage,
  usageOf,
  provenanceOf,
  restoreEntry,
  revertEntry,
  stats,
  updateEntry,
  updateProject,
  upsertProject,
  visibleEntries,
  type ProjectRef,
  entryState,
  entryStates,
  getPolicy,
  setPolicy,
  withStates,
} from "./store.ts";
import { mergePreview, mergeProject } from "./project-merge.ts";
import { dismissSimilarProjects, similarProjects } from "./project-similar.ts";
import { deleteTurn, enqueueTurn, getTurn, listTurns, retryTurn } from "./turns.ts";
import { config, llmEnabled } from "./config.ts";
import {
  applyProposal,
  dismissProposal,
  enqueueReview,
  listProposals,
  listReviewJobs,
  cancelReviewJob,
  retryReviewJob,
  reviewScopeSummary,
  reviewStats,
  staleEntries,
  type ProposalStatus,
} from "./review.ts";
import {
  addLink,
  deleteEntity,
  enqueueBackfill,
  entitiesOf,
  entityEntries,
  getEntity,
  graphData,
  graphStats,
  isLinkType,
  linksOf,
  listEntities,
  listGraphJobs,
  mergeEntities,
  neighborhood,
  removeLink,
  revertGraphRevision,
  cancelGraphJob,
  retryGraphJob,
  updateEntity,
} from "./graph.ts";
import { dismissSimilarPair, similarEntities } from "./entity-similar.ts";
import { listGraphRevisions } from "./graph-revisions.ts";
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
  lintWiki,
  missingLinks,
  pageRevisions,
  pagesCitingEntry,
  restorePage,
  cancelJob,
  retryJob,
  revertPage,
  enqueueCompose,
  searchWiki,
  updatePage,
  wikiStats,
} from "./wiki.ts";

export const api = new Hono();

// Debug mode: one "http" line per request (polling and the debug endpoints themselves excluded).
const UNLOGGED = new Set(["/api/health", "/api/stats", "/health", "/stats"]);
api.use("*", async (c, next) => {
  if (!debugEnabled()) return next();
  const t0 = performance.now();
  await next();
  const path = c.req.path;
  if (UNLOGGED.has(path) || path.includes("/debug")) return;
  const url = new URL(c.req.url);
  debugLog("http", { method: c.req.method, path, query: url.search || undefined, status: c.res.status, ms: msSince(t0) });
});

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof DebugForcedError) return c.json({ error: err.message }, 409);
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

// Fused search scores (ADR-0034) are small numbers: 2 decimals would flatten them.
// Keyword-only scores keep their 2 decimals (unchanged output with embeddings off).
const roundScore = (n: number, fused: boolean) => (fused ? Math.round(n * 10000) / 10000 : Math.round(n * 100) / 100);

api.get("/health", (c) =>
  c.json({ ok: true, llm: llmEnabled() ? config.llm.model : null, debug: debugEnabled(), ...stats(), ...wikiStats(), ...graphStats(), ...reviewStats(), ...embedStats() }),
);

/** One "context" debug line: the prompt, what was injected and why recall picked what it did. */
function logContext(type: string, project: { id: number; key: string } | null, prompt: string, ctx: { included: number[]; recalled: number[]; recall: string; system: string }, debug: object) {
  debugLog(type, {
    project: project ? { id: project.id, key: project.key } : null,
    prompt,
    included: ctx.included,
    recalled: ctx.recalled,
    systemChars: ctx.system.length,
    recallChars: ctx.recall.length,
    ...debug,
  });
}

// ------------------------------------------------------------------ debug mode

api.get("/debug", (c) => c.json({ ...debugState(), dir: config.debug.logDir, keepDays: config.debug.keepDays, maxMbPerDay: config.debug.maxBytesPerDay / 1048576, files: listDebugLogs() }));
api.put("/debug", async (c) => {
  const b = await body<{ enabled?: unknown }>(c);
  if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
  setDebug(b.enabled);
  return c.json({ ...debugState(), dir: config.debug.logDir, keepDays: config.debug.keepDays, maxMbPerDay: config.debug.maxBytesPerDay / 1048576, files: listDebugLogs() });
});
api.get("/debug/logs/:date", (c) => {
  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
  const stream = debugLogStream(date, c.req.query("type") || undefined);
  if (!stream) throw new HttpError(404, "no debug log for that day");
  // Streamed (a day can be 200 MB). Shown as text in the browser ("열기"); ndjson as a download ("받기").
  const download = c.req.query("download") === "1";
  return c.body(stream, 200, {
    "content-type": download ? "application/x-ndjson; charset=utf-8" : "text/plain; charset=utf-8",
    ...(download ? { "content-disposition": `attachment; filename="memory-wiki-debug-${date}.jsonl"` } : {}),
  });
});

/** Called by the pi extension before every run. Upserts the project. */
api.post("/context", async (c) => {
  const b = await body<{ project?: ProjectRef | null; prompt?: string }>(c);
  const project = projectFromRef(b.project);
  const prompt = String(b.prompt ?? "").slice(0, 8000);
  const { debug, ...ctx } = await buildContext(project, prompt);
  // Only prompt-specific recall counts as use; the stable block is shown every time.
  recordUsage(ctx.recalled, "recall");
  recordShown(ctx.included);
  if (debug) logContext("context", project, prompt, ctx, debug);
  return c.json({ project, ...ctx });
});

api.get("/context/preview", async (c) => {
  const id = num(c.req.query("project_id"));
  const project = id ? getProject(id) : null;
  const prompt = c.req.query("prompt") ?? "";
  const { debug, ...ctx } = await buildContext(project, prompt);
  if (debug) logContext("context.preview", project, prompt, ctx, debug);
  return c.json({ project, ...ctx });
});

api.post("/turns", async (c) => {
  const b = await body<Parameters<typeof enqueueTurn>[0]>(c);
  const t = enqueueTurn(b);
  return c.json({ id: t.id, status: t.status }, 202);
});

api.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  const t0 = performance.now();
  const info: QueryInfo = {};
  const vector = await queryVector(q, { info });
  const key = c.req.query("project");
  const projectId = num(c.req.query("project_id")) ?? (key ? getProjectByKey(key)?.id : undefined);
  const scope = c.req.query("scope") as Scope | undefined;
  const hits = searchEntries(q, {
    projectId: projectId ?? null,
    scopes: scope ? [scope] : undefined,
    category: c.req.query("category") || undefined,
    limit: num(c.req.query("limit")) ?? 20,
    allProjects: c.req.query("all") === "1",
    inactive: c.req.query("inactive") === "1",
    vector,
  });
  // via=agent: the memory_search tool (web searches do not count as use).
  if (c.req.query("via") === "agent") recordUsage(hits.map((h) => h.entry.id), "search");
  debugLog("search", {
    q,
    via: c.req.query("via") ?? "web",
    params: Object.fromEntries(new URL(c.req.url).searchParams),
    embed: info,
    hits: hits.map((h) => ({ id: h.entry.id, score: h.score, keyword: h.keyword, similarity: h.similarity })),
    ms: msSince(t0),
  });
  const st = entryStates(hits.map((h) => h.entry));
  return c.json(hits.map((h) => ({ ...h.entry, ...st.get(h.entry.id), score: roundScore(h.score, Boolean(vector)) })));
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

/** Curation policy: human-written rules for the server LLM. project_id omitted/0 = global. */
api.get("/policy", (c) => c.json(getPolicy(num(c.req.query("project_id")) || null)));
api.put("/policy", async (c) => {
  const b = await body<{ project_id?: number | null; text?: string }>(c);
  return c.json(setPolicy(b.project_id || null, String(b.text ?? "")));
});

api.get("/meta", (c) => c.json({ categories: CATEGORIES, llm: llmEnabled() ? config.llm.model : null }));
api.get("/stats", (c) => c.json({ debug: debugEnabled(), ...stats(), ...wikiStats(), ...graphStats(), ...reviewStats(), ...embedStats() }));

api.get("/projects", (c) => c.json(listProjects()));
// Registered before /projects/:id so "similar" is never read as an id.
api.get("/projects/similar", (c) => c.json(similarProjects(Math.min(num(c.req.query("limit")) ?? 50, 500))));
api.post("/projects/similar/dismiss", async (c) => {
  const b = await body<{ a: number; b: number }>(c);
  dismissSimilarProjects(Number(b.a), Number(b.b));
  return c.json({ ok: true });
});
api.get("/projects/:id", (c) => {
  const p = getProject(idParam(c));
  if (!p) throw new HttpError(404, "project not found");
  return c.json({ ...p, aliases: projectAliases(p.id) });
});
/** Merge a project split off by an origin change into another one (source = :id). */
api.get("/projects/:id/merge-preview", (c) => c.json(mergePreview(idParam(c), c.req.query("into"))));
api.post("/projects/:id/merge", async (c) => {
  const b = await body<{ into?: number | string | null }>(c);
  return c.json(mergeProject(idParam(c), b.into));
});
api.patch("/projects/:id", async (c) => c.json(updateProject(idParam(c), await body(c))));
api.delete("/projects/:id", (c) => {
  deleteProject(idParam(c));
  return c.json({ ok: true });
});

api.get("/entries", (c) =>
  c.json(
    withStates(listEntries({
      scope: (c.req.query("scope") as Scope) || undefined,
      projectId: num(c.req.query("project_id")),
      category: c.req.query("category") || undefined,
      deleted: c.req.query("deleted") === "1",
      limit: num(c.req.query("limit")) ?? 1000,
    })),
  ),
);
api.get("/entries/visible", (c) => c.json(withStates(visibleEntries(num(c.req.query("project_id")) ?? null))));
api.get("/entries/:id", (c) => {
  const e = getEntry(idParam(c));
  if (!e) throw new HttpError(404, "entry not found");
  return c.json({
    entry: { ...e, ...entryState(e) },
    project: e.project_id ? getProject(e.project_id) : null,
    revisions: listRevisions(e.id),
    citedBy: pagesCitingEntry(e.id),
    entities: entitiesOf(e.id),
    links: linksOf(e.id),
    usage: usageOf(e.id),
    provenance: provenanceOf(e.id),
  });
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

api.post("/entries/:id/links", async (c) => {
  const b = await body<{ to: number; type: string }>(c);
  if (!isLinkType(b.type)) throw new HttpError(400, "invalid link type");
  addLink(idParam(c), Number(b.to), b.type, "human");
  return c.json(linksOf(idParam(c)), 201);
});
api.delete("/entries/:id/links", (c) => {
  const type = c.req.query("type");
  if (!isLinkType(type)) throw new HttpError(400, "invalid link type");
  removeLink(idParam(c), Number(c.req.query("to")), type);
  return c.json(linksOf(idParam(c)));
});

// ----------------------------------------------------------------- graph

/** Whole graph for the web view: project (with bridging global/user memories) or everything. */
api.get("/graph", (c) => c.json(graphData(num(c.req.query("project_id")) ?? null, { limit: num(c.req.query("limit")) })));

/** memory_graph tool: neighborhood of an entity (entity=) or a memory (id=), as seen from a project. */
api.get("/graph/neighbors", (c) => {
  const key = c.req.query("project");
  const projectId = num(c.req.query("project_id")) ?? (key ? getProjectByKey(key)?.id : undefined) ?? null;
  const r = neighborhood({ entity: c.req.query("entity") || undefined, id: num(c.req.query("id")) }, projectId);
  if (c.req.query("via") === "agent") recordUsage(r.kind === "memory" ? [r.memory.id] : r.memories.map((m) => m.id), "search");
  return c.json(r);
});

api.get("/entities", (c) =>
  c.json(listEntities({ q: c.req.query("q") || undefined, projectId: num(c.req.query("project_id")), limit: num(c.req.query("limit")) })),
);
// Registered before /entities/:id so "similar" is never read as an id.
api.get("/entities/similar", (c) => c.json(similarEntities(Math.min(num(c.req.query("limit")) ?? 50, 500))));
api.post("/entities/similar/dismiss", async (c) => {
  const b = await body<{ a: number; b: number }>(c);
  dismissSimilarPair(Number(b.a), Number(b.b));
  return c.json({ ok: true });
});
api.get("/entities/:id", (c) => {
  const ent = getEntity(idParam(c));
  if (!ent) throw new HttpError(404, "entity not found");
  const memories = withStates(entityEntries(ent.id)).map((e) => ({ ...e, project_name: e.project_id ? getProject(e.project_id)?.name ?? null : null }));
  return c.json({ entity: ent, memories });
});
api.patch("/entities/:id", async (c) => c.json(updateEntity(idParam(c), await body(c))));
api.post("/entities/:id/merge", async (c) => {
  const b = await body<{ into: number }>(c);
  return c.json(mergeEntities(idParam(c), Number(b.into)));
});
api.delete("/entities/:id", (c) => {
  deleteEntity(idParam(c));
  return c.json({ ok: true });
});

api.post("/graph/backfill", async (c) => {
  const b = await body<{ project_id?: number | null; all?: boolean }>(c);
  return c.json(enqueueBackfill(b.project_id || null, { all: b.all }), 201);
});
api.get("/graph/jobs", (c) => c.json(listGraphJobs(num(c.req.query("limit")) ?? 20)));
api.post("/graph/jobs/:id/retry", (c) => c.json(retryGraphJob(idParam(c))));
api.post("/graph/jobs/:id/cancel", (c) => c.json(cancelGraphJob(idParam(c))));
/** Link and entity edit history, newest first (entity_id= / entry_id= narrow it). */
api.get("/graph/revisions", (c) =>
  c.json(
    listGraphRevisions({
      limit: Math.min(num(c.req.query("limit")) ?? 50, 500),
      entityId: num(c.req.query("entity_id")),
      entryId: num(c.req.query("entry_id")),
    }),
  ),
);
api.post("/graph/revisions/:id/revert", (c) => c.json(revertGraphRevision(idParam(c))));

// ---------------------------------------------------------------- review

/** Start an LLM review of a scope: project_id, or none/0 = global + user memories. */
api.post("/review", async (c) => {
  const b = await body<{ project_id?: number | null }>(c);
  return c.json(enqueueReview(b.project_id || null), 201);
});
api.get("/review/jobs", (c) => {
  const pid = c.req.query("project_id");
  return c.json(listReviewJobs({ projectId: pid === undefined ? undefined : num(pid) || null, limit: num(c.req.query("limit")) ?? 20 }));
});
api.get("/review/scope", (c) => c.json(reviewScopeSummary(num(c.req.query("project_id")) || null)));
api.post("/review/jobs/:id/retry", (c) => c.json(retryReviewJob(idParam(c))));
api.post("/review/jobs/:id/cancel", (c) => c.json(cancelReviewJob(idParam(c))));
api.get("/review/proposals", (c) => {
  const pid = c.req.query("project_id");
  return c.json(
    listProposals({
      status: (c.req.query("status") as ProposalStatus) || undefined,
      jobId: num(c.req.query("job_id")),
      projectId: pid === undefined ? undefined : num(pid) || null,
    }),
  );
});
api.post("/review/proposals/:id/apply", (c) => c.json(applyProposal(idParam(c))));
api.post("/review/proposals/:id/dismiss", (c) => c.json(dismissProposal(idParam(c))));
/** Not used and not edited for `days` days (no LLM). */
api.get("/review/stale", (c) => {
  const pid = num(c.req.query("project_id"));
  return c.json(staleEntries(pid || null, num(c.req.query("days")) ?? config.review.staleDays));
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
api.get("/wiki/lint", (c) => c.json(lintWiki(wikiScope(c))));
api.get("/wiki/pages/:id", (c) => {
  const p = getPage(idParam(c));
  if (!p) throw new HttpError(404, "page not found");
  return c.json({
    page: p,
    project: p.project_id ? getProject(p.project_id) : null,
    revisions: pageRevisions(p.id),
    backlinks: backlinks(p),
    cites: withStates(citedEntries(p)),
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
api.get("/wiki/search", async (c) => {
  const q = c.req.query("q") ?? "";
  const t0 = performance.now();
  const info: QueryInfo = {};
  const vector = await queryVector(q, { info });
  const hits = searchWiki(q, {
      projectId: c.req.query("all") === "1" ? undefined : wikiScope(c),
      allProjects: c.req.query("all") === "1",
      limit: num(c.req.query("limit")) ?? 10,
      vector,
  });
  debugLog("wiki.search", { q, embed: info, hits: hits.map((h) => ({ id: h.page.id, slug: h.page.slug, score: h.score, similarity: h.similarity })), ms: msSince(t0) });
  return c.json(hits.map((h) => ({ ...h.page, body: undefined, snippet: h.snippet, score: roundScore(h.score, Boolean(vector)) })));
});
/** Agent read: the page from the project wiki, falling back to the global wiki ("global:slug" forces global). */
api.get("/wiki/read", (c) => {
  let slug = c.req.query("slug") ?? "";
  let scope: number | null = wikiScope(c);
  if (slug.startsWith("global:")) {
    slug = slug.slice(7);
    scope = null;
  }
  // A deleted project page must not hide a live global page with the same slug.
  const own = getPageBySlug(scope, slug);
  const p = own && !own.deleted_at ? own : scope != null ? getPageBySlug(null, slug) : own;
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
api.post("/wiki/jobs/:id/cancel", (c) => c.json(cancelJob(idParam(c))));
