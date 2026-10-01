import { config } from "./config.ts";
import { db, now, rowToEntry, transaction, type Entry, type Source } from "./db.ts";
import { extractTerms } from "./search.ts";
import { findSecrets } from "./secrets.ts";
import { HttpError, getProject } from "./store.ts";

// Wiki layer: long-form pages per project (project_id) or global (null).
// Independent of memory: people and the agent write pages, and the LLM
// composes pages from turn records only when asked. Pages link to each other
// with [[slug]] / [[slug|label]] and may reference a memory with [#id].

export interface WikiPage {
  id: number;
  project_id: number | null;
  slug: string;
  title: string;
  body: string;
  locked: boolean;
  source: Source;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface WikiRevision {
  id: number;
  page_id: number;
  action: "create" | "update" | "delete" | "restore";
  title: string;
  body: string;
  author: Source;
  job_id: number | null;
  reason: string | null;
  created_at: string;
}

/** "write"/"sync" only appear in v0.2.0 history rows. */
export type WikiJobKind = "compose" | "write" | "sync";
export interface WikiJob {
  id: number;
  project_id: number | null;
  kind: WikiJobKind;
  status: "pending" | "processing" | "done" | "skipped" | "error";
  payload: ComposeJobPayload;
  first_at: string;
  run_after: string;
  result: unknown;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

/** Turn records to organize into pages, oldest first. */
export interface ComposeJobPayload {
  turns: number[];
  /** Optional focus from the person who started it ("배포 절차 위주로"). */
  instruction?: string;
}

type Row = Record<string, unknown>;

const toPage = (r: Row): WikiPage => ({
  id: Number(r.id),
  project_id: r.project_id == null ? null : Number(r.project_id),
  slug: String(r.slug),
  title: String(r.title),
  body: String(r.body),
  locked: Boolean(r.locked),
  source: r.source as Source,
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
  deleted_at: r.deleted_at == null ? null : String(r.deleted_at),
});

const toRevision = (r: Row): WikiRevision => ({
  id: Number(r.id),
  page_id: Number(r.page_id),
  action: r.action as WikiRevision["action"],
  title: String(r.title),
  body: String(r.body),
  author: r.author as Source,
  job_id: r.job_id == null ? null : Number(r.job_id),
  reason: r.reason == null ? null : String(r.reason),
  created_at: String(r.created_at),
});

const toJob = (r: Row): WikiJob => ({
  id: Number(r.id),
  project_id: r.project_id == null ? null : Number(r.project_id),
  kind: r.kind as WikiJobKind,
  status: r.status as WikiJob["status"],
  payload: JSON.parse(String(r.payload ?? "{}")),
  first_at: String(r.first_at),
  run_after: String(r.run_after),
  result: r.result == null ? null : JSON.parse(String(r.result)),
  error: r.error == null ? null : String(r.error),
  created_at: String(r.created_at),
  processed_at: r.processed_at == null ? null : String(r.processed_at),
});

// ------------------------------------------------------------------ slugs

export function slugify(s: string): string {
  const slug = s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "page";
}

const LINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const CITE_RE = /\[#(\d+)\]/g;

export function parseLinks(body: string): string[] {
  return [...new Set([...body.matchAll(LINK_RE)].map((m) => slugify(m[1])))];
}
export function parseCitations(body: string): number[] {
  return [...new Set([...body.matchAll(CITE_RE)].map((m) => Number(m[1])))];
}

// ------------------------------------------------------------------ pages

const scopeWhere = (projectId: number | null) => (projectId == null ? "project_id IS NULL" : "project_id = ?");
const scopeArgs = (projectId: number | null) => (projectId == null ? [] : [projectId]);

export function getPage(id: number): WikiPage | null {
  const r = db.prepare(`SELECT * FROM wiki_pages WHERE id = ?`).get(id);
  return r ? toPage(r) : null;
}

export function getPageBySlug(projectId: number | null, slug: string): WikiPage | null {
  const r = db
    .prepare(`SELECT * FROM wiki_pages WHERE ${scopeWhere(projectId)} AND slug = ?`)
    .get(...scopeArgs(projectId), slugify(slug));
  return r ? toPage(r) : null;
}

export function listPages(projectId: number | null, opts: { deleted?: boolean } = {}): WikiPage[] {
  return db
    .prepare(
      `SELECT * FROM wiki_pages WHERE ${scopeWhere(projectId)} AND deleted_at IS ${opts.deleted ? "NOT NULL" : "NULL"}
       ORDER BY slug = 'overview' DESC, title COLLATE NOCASE`,
    )
    .all(...scopeArgs(projectId))
    .map(toPage);
}

export interface PageMeta {
  author: Source;
  jobId?: number | null;
  reason?: string | null;
}

function guardPage(title: string, body: string) {
  if (!title.trim()) throw new HttpError(400, "title is required");
  if (title.length > 200) throw new HttpError(400, "title is too long (max 200)");
  if (body.length > 100_000) throw new HttpError(400, "body is too long (max 100000)");
  const secrets = findSecrets(`${title}\n${body}`);
  if (secrets.length) throw new HttpError(422, `content looks like it contains secrets: ${secrets.join(", ")}`);
}

function indexDerived(page: WikiPage) {
  db.prepare(`DELETE FROM wiki_links WHERE page_id = ?`).run(page.id);
  db.prepare(`DELETE FROM wiki_citations WHERE page_id = ?`).run(page.id);
  const link = db.prepare(`INSERT OR IGNORE INTO wiki_links (page_id, to_slug) VALUES (?, ?)`);
  for (const s of parseLinks(page.body)) if (s !== page.slug) link.run(page.id, s);
  const cite = db.prepare(`INSERT OR IGNORE INTO wiki_citations (page_id, entry_id) VALUES (?, ?)`);
  for (const id of parseCitations(page.body)) cite.run(page.id, id);
}

function writeRevision(p: WikiPage, action: WikiRevision["action"], meta: PageMeta): number {
  const res = db
    .prepare(
      `INSERT INTO wiki_revisions (page_id, action, title, body, author, job_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(p.id, action, p.title, p.body, meta.author, meta.jobId ?? null, meta.reason ?? null);
  return Number(res.lastInsertRowid);
}

export function createPage(projectId: number | null, input: { slug?: string; title: string; body?: string; locked?: boolean }, meta: PageMeta): WikiPage {
  if (projectId != null && !getProject(projectId)) throw new HttpError(404, "project not found");
  const title = input.title?.trim() ?? "";
  const body = (input.body ?? "").trim();
  guardPage(title, body);
  const slug = slugify(input.slug || title);
  const existing = getPageBySlug(projectId, slug);
  if (existing && !existing.deleted_at) throw new HttpError(409, `page "${slug}" already exists`);
  const page = transaction(() => {
    if (existing) {
      // Re-creating a deleted slug revives the row so its history stays together.
      db.prepare(`UPDATE wiki_pages SET title = ?, body = ?, locked = ?, source = ?, deleted_at = NULL, updated_at = ? WHERE id = ?`).run(
        title, body, input.locked ? 1 : 0, meta.author, now(), existing.id,
      );
      const p = getPage(existing.id)!;
      indexDerived(p);
      writeRevision(p, "restore", meta);
      return p;
    }
    const res = db
      .prepare(`INSERT INTO wiki_pages (project_id, slug, title, body, locked, source) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(projectId, slug, title, body, input.locked ? 1 : 0, meta.author);
    const p = getPage(Number(res.lastInsertRowid))!;
    indexDerived(p);
    writeRevision(p, "create", meta);
    return p;
  });
  return page;
}

export function updatePage(id: number, patch: { title?: string; body?: string; locked?: boolean }, meta: PageMeta): WikiPage {
  const cur = getPage(id);
  if (!cur || cur.deleted_at) throw new HttpError(404, "page not found");
  if (cur.locked && meta.author !== "human") throw new HttpError(423, "page is locked");
  const title = patch.title !== undefined ? patch.title.trim() : cur.title;
  const body = patch.body !== undefined ? patch.body.trim() : cur.body;
  const locked = patch.locked !== undefined ? Boolean(patch.locked) : cur.locked;
  guardPage(title, body);
  if (title === cur.title && body === cur.body && locked === cur.locked) return cur;
  const contentChanged = title !== cur.title || body !== cur.body;
  return transaction(() => {
    db.prepare(`UPDATE wiki_pages SET title = ?, body = ?, locked = ?, source = ?, updated_at = ? WHERE id = ?`).run(
      title, body, locked ? 1 : 0, contentChanged ? meta.author : cur.source, now(), id,
    );
    const p = getPage(id)!;
    indexDerived(p);
    if (contentChanged) writeRevision(p, "update", meta);
    return p;
  });
}

export function deletePage(id: number, meta: PageMeta): WikiPage {
  const cur = getPage(id);
  if (!cur || cur.deleted_at) throw new HttpError(404, "page not found");
  if (cur.locked && meta.author !== "human") throw new HttpError(423, "page is locked");
  return transaction(() => {
    db.prepare(`UPDATE wiki_pages SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), id);
    const p = getPage(id)!;
    writeRevision(p, "delete", meta);
    return p;
  });
}

export function restorePage(id: number, meta: PageMeta): WikiPage {
  const cur = getPage(id);
  if (!cur) throw new HttpError(404, "page not found");
  if (!cur.deleted_at) return cur;
  return transaction(() => {
    db.prepare(`UPDATE wiki_pages SET deleted_at = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
    const p = getPage(id)!;
    writeRevision(p, "restore", meta);
    return p;
  });
}

export function revertPage(id: number, revisionId: number, meta: PageMeta): WikiPage {
  const r = db.prepare(`SELECT * FROM wiki_revisions WHERE id = ? AND page_id = ?`).get(revisionId, id);
  if (!r) throw new HttpError(404, "revision not found");
  const rev = toRevision(r);
  const cur = getPage(id);
  if (cur?.deleted_at) restorePage(id, meta);
  return updatePage(id, { title: rev.title, body: rev.body }, { ...meta, reason: meta.reason ?? `revision #${revisionId} 로 되돌림` });
}

export function pageRevisions(pageId: number): WikiRevision[] {
  return db.prepare(`SELECT * FROM wiki_revisions WHERE page_id = ? ORDER BY id DESC`).all(pageId).map(toRevision);
}

export function backlinks(page: WikiPage): { id: number; slug: string; title: string }[] {
  return db
    .prepare(
      `SELECT p.id, p.slug, p.title FROM wiki_links l JOIN wiki_pages p ON p.id = l.page_id
       WHERE l.to_slug = ? AND ${page.project_id == null ? "p.project_id IS NULL" : "p.project_id = ?"} AND p.deleted_at IS NULL
       ORDER BY p.title`,
    )
    .all(page.slug, ...scopeArgs(page.project_id))
    .map((r) => ({ id: Number(r.id), slug: String(r.slug), title: String(r.title) }));
}

export function citedEntries(page: WikiPage): Entry[] {
  return db
    .prepare(`SELECT e.* FROM wiki_citations c JOIN entries e ON e.id = c.entry_id WHERE c.page_id = ? ORDER BY e.id`)
    .all(page.id)
    .map(rowToEntry);
}

export function pagesCitingEntry(entryId: number): (Pick<WikiPage, "id" | "slug" | "title" | "project_id">)[] {
  return db
    .prepare(
      `SELECT p.id, p.slug, p.title, p.project_id FROM wiki_citations c JOIN wiki_pages p ON p.id = c.page_id
       WHERE c.entry_id = ? AND p.deleted_at IS NULL ORDER BY p.title`,
    )
    .all(entryId)
    .map((r) => ({ id: Number(r.id), slug: String(r.slug), title: String(r.title), project_id: r.project_id == null ? null : Number(r.project_id) }));
}

export function missingLinks(projectId: number | null): { from: string; to: string }[] {
  return db
    .prepare(
      `SELECT p.slug AS from_slug, l.to_slug FROM wiki_links l JOIN wiki_pages p ON p.id = l.page_id
       WHERE ${scopeWhere(projectId).replace("project_id", "p.project_id")} AND p.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM wiki_pages q WHERE q.slug = l.to_slug AND IFNULL(q.project_id, 0) = IFNULL(p.project_id, 0) AND q.deleted_at IS NULL)`,
    )
    .all(...scopeArgs(projectId))
    .map((r) => ({ from: String(r.from_slug), to: String(r.to_slug) }));
}

// ----------------------------------------------------------------- search

export interface WikiHit {
  page: WikiPage;
  score: number;
  snippet: string;
}

export function searchWiki(query: string, opts: { projectId?: number | null; allProjects?: boolean; limit?: number } = {}): WikiHit[] {
  const terms = extractTerms(query);
  if (!terms.length) return [];
  const where = ["w.deleted_at IS NULL"];
  const args: (string | number)[] = [];
  if (!opts.allProjects) {
    // Project wiki + global wiki.
    where.push("(w.project_id IS NULL OR w.project_id = ?)");
    args.push(opts.projectId ?? -1);
  }
  const long = terms.flatMap((t) => t.variants.filter((v) => v.length >= 3));
  const short = terms.flatMap((t) => t.variants.filter((v) => v.length < 3));
  const found = new Map<number, WikiPage>();
  if (long.length) {
    for (const r of db
      .prepare(`SELECT w.* FROM wiki_fts f JOIN wiki_pages w ON w.id = f.rowid WHERE wiki_fts MATCH ? AND ${where.join(" AND ")} LIMIT 200`)
      .all(long.map((v) => `"${v.replace(/"/g, '""')}"`).join(" OR "), ...args))
      found.set(Number(r.id), toPage(r));
  }
  if (short.length) {
    const esc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
    for (const r of db
      .prepare(
        `SELECT w.* FROM wiki_pages w WHERE ${where.join(" AND ")} AND (${short.map(() => "(w.title LIKE ? ESCAPE '\\' OR w.body LIKE ? ESCAPE '\\')").join(" OR ")}) LIMIT 200`,
      )
      .all(...args, ...short.flatMap((s) => [`%${esc(s)}%`, `%${esc(s)}%`])))
      found.set(Number(r.id), toPage(r));
  }
  const hits: WikiHit[] = [];
  for (const page of found.values()) {
    const title = page.title.toLowerCase();
    const body = page.body.toLowerCase();
    let score = 0;
    let matched = 0;
    let first = -1;
    for (const t of terms) {
      let best = 0;
      for (const v of t.variants) {
        const w = v.length / t.variants[0].length;
        let s = 0;
        if (title.includes(v)) s += 3;
        const i = body.indexOf(v);
        if (i >= 0) {
          s += 1 + Math.min(body.split(v).length - 2, 5) * 0.15;
          if (first < 0 || i < first) first = i;
        }
        best = Math.max(best, s * w);
      }
      if (best > 0) matched++;
      score += best;
    }
    if (!matched) continue;
    score *= 0.5 + matched / terms.length;
    if (page.project_id != null) score *= 1.1;
    const start = Math.max(0, first - 100);
    const snippet = first < 0 ? page.body.slice(0, 240) : `${start > 0 ? "…" : ""}${page.body.slice(start, start + 320)}`;
    hits.push({ page, score, snippet: snippet.replace(/\s+/g, " ") });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, opts.limit ?? 10);
}

// -------------------------------------------------------------- job queue

let wakeWorker: (() => void) | null = null;
export function onWikiJobQueued(fn: () => void) {
  wakeWorker = fn;
}

const scopeKey = (projectId: number | null) => projectId ?? 0;

/** Queue a compose job: the LLM organizes these turn records into pages of one wiki. */
export function enqueueCompose(projectId: number | null, turnIds: number[], instruction?: string): WikiJob {
  if (projectId != null && !getProject(projectId)) throw new HttpError(404, "project not found");
  const ids = [...new Set(turnIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((x, y) => x - y);
  if (!ids.length) throw new HttpError(400, "no turns to compose");
  if (ids.length > config.wiki.composeMaxTurns) throw new HttpError(400, `too many turns (max ${config.wiki.composeMaxTurns})`);
  const found = db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE id IN (${ids.map(() => "?").join(",")})`).get(...ids);
  if (Number(found?.n) !== ids.length) throw new HttpError(404, "some turns do not exist");
  const payload: ComposeJobPayload = { turns: ids, ...(instruction?.trim() ? { instruction: instruction.trim().slice(0, 1000) } : {}) };
  const res = db.prepare(`INSERT INTO wiki_jobs (project_id, kind, payload) VALUES (?, 'compose', ?)`).run(projectId, JSON.stringify(payload));
  wakeWorker?.();
  return getJob(Number(res.lastInsertRowid))!;
}

/**
 * Turns that can feed a wiki: a project's turns, or every turn for the global
 * wiki. `composed` says whether the turn was already organized into this wiki.
 */
export function composableTurns(projectId: number | null, f: { sessionId?: string; uncomposed?: boolean; limit?: number } = {}) {
  const where = ["1=1"];
  const args: (string | number)[] = [scopeKey(projectId)];
  if (projectId != null) {
    where.push("t.project_id = ?");
    args.push(projectId);
  }
  if (f.sessionId) {
    where.push("t.session_id = ?");
    args.push(f.sessionId);
  }
  if (f.uncomposed) where.push("c.turn_id IS NULL");
  args.push(f.limit ?? 200);
  return db
    .prepare(
      `SELECT t.id, t.project_id, t.session_id, t.created_at, t.text, p.name AS project_name, c.created_at AS composed_at
       FROM turns t LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN wiki_composed c ON c.turn_id = t.id AND c.scope = ?
       WHERE ${where.join(" AND ")} ORDER BY t.id DESC LIMIT ?`,
    )
    .all(...args)
    .map((r) => ({
      id: Number(r.id),
      project_id: r.project_id == null ? null : Number(r.project_id),
      project_name: r.project_name == null ? null : String(r.project_name),
      session_id: String(r.session_id),
      created_at: String(r.created_at),
      // text starts with the first user message; stop at the next role/tool marker.
      prompt: String(r.text).replace(/^\[user\]\n/, "").split(/\n\n\[(?:assistant|user|tool call)/)[0].slice(0, 200),
      chars: String(r.text).length,
      composed_at: r.composed_at == null ? null : String(r.composed_at),
    }));
}

export function markComposed(projectId: number | null, turnIds: number[], jobId: number) {
  const ins = db.prepare(`INSERT OR REPLACE INTO wiki_composed (scope, turn_id, job_id) VALUES (?, ?, ?)`);
  transaction(() => {
    for (const id of turnIds) ins.run(scopeKey(projectId), id, jobId);
  });
}

/** Progress kept on the job row so a retry skips chunks that already went through. */
export function saveJobProgress(id: number, result: unknown) {
  db.prepare(`UPDATE wiki_jobs SET result = ? WHERE id = ?`).run(JSON.stringify(result), id);
}

export function getJob(id: number): WikiJob | null {
  const r = db.prepare(`SELECT * FROM wiki_jobs WHERE id = ?`).get(id);
  return r ? toJob(r) : null;
}

export function claimDueJob(): WikiJob | null {
  const r = db
    .prepare(`SELECT id FROM wiki_jobs WHERE status = 'pending' AND run_after <= ? ORDER BY run_after, id LIMIT 1`)
    .get(now());
  if (!r) return null;
  const res = db.prepare(`UPDATE wiki_jobs SET status = 'processing' WHERE id = ? AND status = 'pending'`).run(Number(r.id));
  return res.changes ? getJob(Number(r.id)) : null;
}

export function nextJobDueInMs(): number | null {
  const r = db.prepare(`SELECT MIN(run_after) AS t FROM wiki_jobs WHERE status = 'pending'`).get();
  if (!r?.t) return null;
  return Math.max(0, new Date(String(r.t)).getTime() - Date.now());
}

export function finishJob(id: number, status: WikiJob["status"], result: unknown, error: string | null = null) {
  db.prepare(`UPDATE wiki_jobs SET status = ?, result = ?, error = ?, processed_at = ? WHERE id = ?`).run(
    status,
    result == null ? null : JSON.stringify(result),
    error,
    now(),
    id,
  );
}

export function listJobs(f: { projectId?: number | null; status?: string; limit?: number } = {}) {
  const where = ["1=1"];
  const args: (string | number)[] = [];
  if (f.projectId !== undefined) {
    where.push(f.projectId == null ? "j.project_id IS NULL" : "j.project_id = ?");
    if (f.projectId != null) args.push(f.projectId);
  }
  if (f.status) {
    where.push("j.status = ?");
    args.push(f.status);
  }
  args.push(f.limit ?? 50);
  return db
    .prepare(
      `SELECT j.*, p.name AS project_name FROM wiki_jobs j LEFT JOIN projects p ON p.id = j.project_id
       WHERE ${where.join(" AND ")} ORDER BY j.id DESC LIMIT ?`,
    )
    .all(...args)
    .map((r) => ({ ...toJob(r), project_name: r.project_name == null ? null : String(r.project_name) }));
}

export function retryJob(id: number): WikiJob {
  const j = getJob(id);
  if (!j) throw new HttpError(404, "job not found");
  if (j.status === "processing") throw new HttpError(409, "job is running");
  db.prepare(`UPDATE wiki_jobs SET status = 'pending', error = NULL, run_after = ? WHERE id = ?`).run(now(), id);
  wakeWorker?.();
  return getJob(id)!;
}

export function wikiStats() {
  const one = (sql: string) => Number(Object.values(db.prepare(sql).get() ?? { n: 0 })[0]);
  return {
    pages: one(`SELECT COUNT(*) FROM wiki_pages WHERE deleted_at IS NULL`),
    wikiPending: one(`SELECT COUNT(*) FROM wiki_jobs WHERE status IN ('pending','processing')`),
    wikiErrors: one(`SELECT COUNT(*) FROM wiki_jobs WHERE status = 'error'`),
  };
}
