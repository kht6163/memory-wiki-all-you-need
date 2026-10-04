import { db, now, transaction, type Project } from "./db.ts";
import { HttpError, getPolicy, getProject, projectAliases } from "./store.ts";
import { slugify } from "./wiki.ts";

// Project merge: a project's key comes from the git origin (G-007), so
// renaming or adding an origin splits one project into two. Merging moves
// everything the source project owns into the target in one transaction and
// leaves the source key (and the source's own aliases) as aliases of the
// target, so old checkouts keep landing in the merged project.

export interface MergeCounts {
  entries: number;
  turns: number;
  wiki_pages: number;
  wiki_jobs: number;
  review_jobs: number;
  review_proposals_pending: number;
}

export interface WikiConflict {
  slug: string;
  source_page_id: number;
  target_page_id: number;
  /** The source page is renamed to this. */
  new_slug: string;
}

export interface MergePlan {
  source: Pick<Project, "id" | "key" | "name">;
  target: Pick<Project, "id" | "key" | "name">;
  counts: MergeCounts;
  wiki_conflicts: WikiConflict[];
  policy: "target" | "source" | "both" | "none";
  description: "target" | "source" | "none";
  aliases: string[];
}

const one = (sql: string, ...args: (number | string)[]) => Number(Object.values(db.prepare(sql).get(...args) ?? { n: 0 })[0] ?? 0);

/** The `into` of a request: missing → "into is required", not a positive integer → "invalid id". */
function targetIdOf(into: unknown): number {
  if (into == null || into === "") throw new HttpError(400, "into is required");
  const v = String(into);
  if (!/^\d+$/.test(v) || !Number(v)) throw new HttpError(400, "invalid id");
  return Number(v);
}

/** Same limit as setPolicy (store.ts) — a merged policy must stay editable. */
const POLICY_MAX = 4000;
const mergedPolicy = (targetText: string, sourceText: string, sourceName: string) =>
  `${targetText}\n\n--- (merged from ${sourceName}) ---\n${sourceText}`;

function load(sourceId: number, into: unknown) {
  const targetId = targetIdOf(into);
  if (sourceId === targetId) throw new HttpError(400, "cannot merge a project into itself");
  const source = getProject(sourceId);
  const target = getProject(targetId);
  if (!source || !target) throw new HttpError(404, "project not found");
  return { source, target };
}

/**
 * 409 while anything may still write to either project (curation, compose, review, backfill).
 * The target's turns only while one is being curated: it picked its candidates before the
 * merge and would miss the moved memories (a near duplicate). A pending target turn is
 * curated after the merge with the moved memories in view, so it does not block (the
 * target is usually the project in use). A global backfill writes by memory id only.
 */
function assertIdle(s: number, t: number) {
  const busy =
    one(`SELECT COUNT(*) FROM wiki_jobs WHERE status IN ('pending','processing') AND project_id IN (?, ?)`, s, t) +
    one(`SELECT COUNT(*) FROM review_jobs WHERE status IN ('pending','processing') AND project_id IN (?, ?)`, s, t) +
    one(
      `SELECT COUNT(*) FROM graph_jobs WHERE status IN ('pending','processing') AND json_valid(payload)
         AND json_extract(payload, '$.projectId') IN (?, ?)`,
      s,
      t,
    ) +
    one(`SELECT COUNT(*) FROM turns WHERE status IN ('pending','processing') AND project_id = ?`, s) +
    one(`SELECT COUNT(*) FROM turns WHERE status = 'processing' AND project_id = ?`, t);
  if (busy) throw new HttpError(409, "a job is running for one of these projects — try again when it finishes");
}

function counts(s: number): MergeCounts {
  return {
    entries: one(`SELECT COUNT(*) FROM entries WHERE project_id = ?`, s),
    turns: one(`SELECT COUNT(*) FROM turns WHERE project_id = ?`, s),
    wiki_pages: one(`SELECT COUNT(*) FROM wiki_pages WHERE project_id = ?`, s),
    wiki_jobs: one(`SELECT COUNT(*) FROM wiki_jobs WHERE project_id = ?`, s),
    review_jobs: one(`SELECT COUNT(*) FROM review_jobs WHERE project_id = ?`, s),
    review_proposals_pending: one(
      `SELECT COUNT(*) FROM review_proposals WHERE status = 'pending' AND job_id IN (SELECT id FROM review_jobs WHERE project_id = ?)`,
      s,
    ),
  };
}

/** Pages (live or in the trash — the slug index holds both) whose slug the target already uses. */
function wikiConflicts(source: Project, target: Project): WikiConflict[] {
  const rows = db
    .prepare(
      `SELECT sp.id AS source_page_id, tp.id AS target_page_id, sp.slug
       FROM wiki_pages sp JOIN wiki_pages tp ON tp.project_id = ? AND tp.slug = sp.slug
       WHERE sp.project_id = ? ORDER BY sp.slug`,
    )
    .all(target.id, source.id);
  if (!rows.length) return [];
  const taken = new Set(
    db
      .prepare(`SELECT slug FROM wiki_pages WHERE project_id IN (?, ?)`)
      .all(source.id, target.id)
      .map((r) => String(r.slug)),
  );
  const suffix = slugify(source.name);
  return rows.map((r) => {
    const slug = String(r.slug);
    const base = slugify(`${slug}-${suffix}`);
    let next = base;
    for (let n = 2; taken.has(next); n++) next = `${base.slice(0, 80 - String(n).length - 1)}-${n}`;
    taken.add(next);
    return { slug, source_page_id: Number(r.source_page_id), target_page_id: Number(r.target_page_id), new_slug: next };
  });
}

function plan(sourceId: number, into: unknown): MergePlan & { _s: Project; _t: Project } {
  const { source, target } = load(sourceId, into);
  assertIdle(source.id, target.id);
  const tp = getPolicy(target.id).text.trim();
  const sp = getPolicy(source.id).text.trim();
  // Refuse rather than store a policy the policy editor could no longer save.
  if (tp && sp && mergedPolicy(tp, sp, source.name).length > POLICY_MAX) throw new HttpError(400, `policy is too long (max ${POLICY_MAX})`);
  return {
    source: { id: source.id, key: source.key, name: source.name },
    target: { id: target.id, key: target.key, name: target.name },
    counts: counts(source.id),
    wiki_conflicts: wikiConflicts(source, target),
    policy: tp && sp ? "both" : tp ? "target" : sp ? "source" : "none",
    description: target.description.trim() ? "target" : source.description.trim() ? "source" : "none",
    aliases: [source.key, ...projectAliases(source.id)],
    _s: source,
    _t: target,
  };
}

/** What a merge of sourceId into targetId would do, without changing anything. */
export function mergePreview(sourceId: number, into: unknown): MergePlan {
  const { _s, _t, ...p } = plan(sourceId, into);
  return p;
}

const LINK_RE = /\[\[([^\]|#\n]+)((?:#[^\]|\n]*)?)((?:\|[^\]\n]*)?)\]\]/g;

/** Point [[old]] links at the renamed pages; the visible text stays what it was. */
function rewriteLinks(body: string, renamed: Map<string, string>): string {
  return body.replace(LINK_RE, (m, target: string, anchor: string, label: string) => {
    const next = renamed.get(slugify(target));
    if (!next) return m;
    return `[[${next}${anchor}${label || `|${target.trim()}`}]]`;
  });
}

/**
 * Moves everything of sourceId into targetId and deletes the source row.
 * One transaction: either all of it happens or nothing does.
 */
export function mergeProject(sourceId: number, into: unknown) {
  return transaction(() => {
    const { _s: source, _t: target, ...p } = plan(sourceId, into);
    const s = source.id;
    const t = target.id;
    const before = { ...p.counts };
    const reason = `project merge: ${source.name} (${source.key}) → ${target.name} (${target.key})`;

    // 1. Wiki slug conflicts: rename the source page while it is still in the
    // source wiki, then make source pages that linked to it follow the rename.
    // Every page whose slug or body changes gets one revision saying why.
    const renamed = new Map(p.wiki_conflicts.map((c) => [c.slug, c.new_slug]));
    const renamedFrom = new Map(p.wiki_conflicts.map((c) => [c.source_page_id, c.slug]));
    const at = now();
    for (const c of p.wiki_conflicts) {
      db.prepare(`UPDATE wiki_pages SET slug = ?, updated_at = ? WHERE id = ?`).run(c.new_slug, at, c.source_page_id);
    }
    if (renamed.size) {
      const pages = db.prepare(`SELECT id, title, body FROM wiki_pages WHERE project_id = ?`).all(s);
      const revise = db.prepare(`INSERT INTO wiki_revisions (page_id, action, title, body, author, reason) VALUES (?, 'update', ?, ?, 'human', ?)`);
      for (const pg of pages) {
        const id = Number(pg.id);
        const body = String(pg.body);
        const next = rewriteLinks(body, renamed);
        const from = renamedFrom.get(id);
        if (next === body && from == null) continue;
        if (next !== body) db.prepare(`UPDATE wiki_pages SET body = ?, updated_at = ? WHERE id = ?`).run(next, at, id);
        const why = [from != null ? `renamed from ${from}` : "", next !== body ? "links to renamed pages updated" : ""].filter(Boolean).join("; ");
        revise.run(id, String(pg.title), next, `${reason} — ${why}`);
      }
      const relink = db.prepare(
        `UPDATE OR IGNORE wiki_links SET to_slug = ? WHERE to_slug = ? AND page_id IN (SELECT id FROM wiki_pages WHERE project_id = ?)`,
      );
      for (const [from, to] of renamed) relink.run(to, from, s);
      // A link that could not move (the page already linked the new slug) is a duplicate.
      for (const from of renamed.keys()) {
        db.prepare(`DELETE FROM wiki_links WHERE to_slug = ? AND page_id IN (SELECT id FROM wiki_pages WHERE project_id = ?)`).run(from, s);
      }
      // A renamed page no longer links to itself.
      db.prepare(
        `DELETE FROM wiki_links WHERE page_id IN (SELECT id FROM wiki_pages WHERE project_id = ?)
           AND to_slug = (SELECT slug FROM wiki_pages w WHERE w.id = wiki_links.page_id)`,
      ).run(s);
    }

    // 2. Everything that names the project.
    for (const table of ["entries", "turns", "wiki_pages", "wiki_jobs", "review_jobs"]) {
      db.prepare(`UPDATE ${table} SET project_id = ? WHERE project_id = ?`).run(t, s);
    }
    db.prepare(`UPDATE OR IGNORE wiki_composed SET scope = ? WHERE scope = ?`).run(t, s);
    db.prepare(`DELETE FROM wiki_composed WHERE scope = ?`).run(s);
    db.prepare(
      `UPDATE graph_jobs SET payload = json_set(payload, '$.projectId', ?) WHERE json_valid(payload) AND json_extract(payload, '$.projectId') = ?`,
    ).run(t, s);
    // Pairs dismissed as "different projects" now speak for the target (the pair with the target itself goes).
    db.prepare(
      `INSERT OR IGNORE INTO project_pair_dismissed (a, b, created_at)
       SELECT min(?, o), max(?, o), created_at FROM
         (SELECT CASE WHEN a = ? THEN b ELSE a END AS o, created_at FROM project_pair_dismissed WHERE a = ? OR b = ?)
       WHERE o != ?`,
    ).run(t, t, s, s, s, t);
    db.prepare(`DELETE FROM project_pair_dismissed WHERE a = ? OR b = ?`).run(s, s);

    // 3. Curation policy: the target's wins; the source's is kept under it.
    const tp = getPolicy(t).text.trim();
    const sp = getPolicy(s).text.trim();
    const policy = p.policy === "both" ? mergedPolicy(tp, sp, source.name) : p.policy === "source" ? sp : null;
    if (policy != null) {
      db.prepare(
        `INSERT INTO curation_policies (project_id, text, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
      ).run(t, policy, at);
    }
    db.prepare(`DELETE FROM curation_policies WHERE project_id = ?`).run(s);

    // 4. Description, last seen.
    const description = p.description === "source" ? source.description.trim() : target.description;
    const seen = [target.last_seen_at, source.last_seen_at].filter((x): x is string => Boolean(x)).sort().pop() ?? null;
    db.prepare(`UPDATE projects SET description = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`).run(description, seen, at, t);

    // 5. Aliases: the source's own move first (the delete below would cascade them away).
    db.prepare(`UPDATE project_aliases SET project_id = ? WHERE project_id = ?`).run(t, s);
    db.prepare(`INSERT INTO project_aliases (key, project_id) VALUES (?, ?)`).run(source.key, t);

    // 6. The source row goes last, once nothing points at it any more (ON DELETE CASCADE).
    const left = counts(s);
    if (Object.values(left).some((n) => n > 0)) throw new Error(`project merge left rows in project #${s}: ${JSON.stringify(left)}`);
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(s);

    console.log(
      `[project] merged #${s} ${source.key} into #${t} ${target.key}: ${before.entries} memories, ${before.turns} turns, ` +
        `${before.wiki_pages} wiki pages (${p.wiki_conflicts.length} renamed), ${before.wiki_jobs} wiki jobs, ${before.review_jobs} review jobs; ` +
        `policy ${p.policy}, description ${p.description}`,
    );
    const merged = getProject(t)!;
    return {
      target: { ...merged, aliases: projectAliases(t) },
      moved: before,
      wiki_conflicts: p.wiki_conflicts,
      aliases: p.aliases,
    };
  });
}
