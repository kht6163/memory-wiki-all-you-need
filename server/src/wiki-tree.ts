import { db } from "./db.ts";
import { MAX_TREE_DEPTH, listPages, type WikiPage } from "./wiki.ts";

// Suggested page tree for a wiki whose pages are still flat (ADR-0036).
// Suggest-only: nothing here writes (G-066); a person applies the moves they
// want (POST /api/wiki/tree/apply → movePages). Two precise rules, no fuzzy
// prefix matching (that is where "review-log" would land under "review"):
//  - continuation: "experiments-2" goes under "experiments" when that page exists;
//  - index: a page named like a list ("adr-index", "…목록", "…목차", "Index")
//    becomes the parent of two or more of its members: for "<prefix>-index" the
//    linked pages named "<prefix>-…", for any other list the linked pages that
//    link back to it.
// Only pages without a parent move; "overview" never moves and never holds.

export interface TreeSuggestion {
  page: { id: number; slug: string; title: string };
  parent: { id: number; slug: string; title: string };
  reason: "continuation" | "index";
}

type TreePage = Pick<WikiPage, "id" | "slug" | "title" | "parent_id">;

const INDEX_SLUG = /(^|-)index$/;
const INDEX_TITLE = /목록|목차|\bindex\b/i;
const CONTINUATION = /^(.+)-(\d{1,3})$/;

export const isIndexPage = (p: Pick<WikiPage, "slug" | "title">) => INDEX_SLUG.test(p.slug) || INDEX_TITLE.test(p.title);

/** Pure: suggestions for `pages` (live, one wiki) given each page's outgoing link slugs. */
export function suggestTree(pages: TreePage[], links: Map<number, Set<string>>): TreeSuggestion[] {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const byId = new Map(pages.map((p) => [p.id, p]));
  const parentOf = new Map(pages.map((p) => [p.id, p.parent_id != null && byId.has(p.parent_id) ? p.parent_id : null]));
  const ref = (p: TreePage) => ({ id: p.id, slug: p.slug, title: p.title });
  // A parent that is not a live page here (trash, gone) counts as top level, as the web shows it.
  const movable = (p: TreePage) => (p.parent_id == null || !byId.has(p.parent_id)) && p.slug !== "overview";

  // Candidate parent per page: continuation first (most specific), then the
  // index page with the fewest links (the narrowest list that names it).
  const wanted = new Map<number, { parent: TreePage; reason: TreeSuggestion["reason"] }>();
  for (const p of pages) {
    if (!movable(p)) continue;
    const m = CONTINUATION.exec(p.slug);
    const base = m ? bySlug.get(m[1]) : undefined;
    if (base && base.id !== p.id && base.slug !== "overview") wanted.set(p.id, { parent: base, reason: "continuation" });
  }
  // Which linked pages an index holds: "<prefix>-index" only pages named "<prefix>-…"
  // (adr-index → adr-0001-…, not the analysis page it also cites); any other
  // list page only pages that link back to it (a list and its members point at each other).
  const members = (h: TreePage): TreePage[] => {
    const linked = [...(links.get(h.id) ?? [])].map((s) => bySlug.get(s)).filter((t): t is TreePage => Boolean(t) && t!.id !== h.id);
    const prefix = /^(.+)-index$/.exec(h.slug)?.[1];
    return prefix ? linked.filter((t) => t.slug.startsWith(`${prefix}-`)) : linked.filter((t) => links.get(t.id)?.has(h.slug));
  };
  const indexes = pages
    .filter((h) => h.slug !== "overview" && isIndexPage(h))
    .map((h) => ({ h, targets: members(h) }))
    .filter((x) => x.targets.length >= 2)
    .sort((a, b) => a.targets.length - b.targets.length || a.h.id - b.h.id);
  for (const { h, targets } of indexes)
    for (const t of targets) if (movable(t) && !wanted.has(t.id)) wanted.set(t.id, { parent: h, reason: "index" });

  // Accept in a fixed order, skipping any move that would make a cycle or a too-deep tree.
  const out: TreeSuggestion[] = [];
  const depthOf = (id: number): number => {
    let d = 0;
    for (let at: number | null | undefined = id, n = 0; at != null && n <= MAX_TREE_DEPTH + 1; at = parentOf.get(at), n++) d++;
    return d;
  };
  // Levels below a page, over live pages and the moves accepted so far (checkParent counts trashed children too;
  // they are not in `pages`, so a rare suggestion may still be refused on apply — never applied wrongly).
  const heightOf = (id: number, guard = 0): number => {
    if (guard > MAX_TREE_DEPTH) return guard;
    let h = 0;
    for (const [kid, up] of parentOf) if (up === id) h = Math.max(h, 1 + heightOf(kid, guard + 1));
    return h;
  };
  for (const id of [...wanted.keys()].sort((a, b) => a - b)) {
    const { parent, reason } = wanted.get(id)!;
    let cycle = false;
    for (let at: number | null | undefined = parent.id, n = 0; at != null && n <= MAX_TREE_DEPTH + 1; at = parentOf.get(at), n++)
      if (at === id) cycle = true;
    if (cycle || depthOf(parent.id) + 1 + heightOf(id) > MAX_TREE_DEPTH) continue;
    parentOf.set(id, parent.id);
    out.push({ page: ref(byId.get(id)!), parent: ref(parent), reason });
  }
  return out;
}

/** Suggestions for one wiki (project id, or null for the global wiki), from the live pages and their links. */
export function suggestedTree(projectId: number | null): TreeSuggestion[] {
  const pages = listPages(projectId);
  const links = new Map<number, Set<string>>();
  const ids = pages.map((p) => p.id);
  if (ids.length)
    for (const r of db.prepare(`SELECT page_id, to_slug FROM wiki_links WHERE page_id IN (${ids.map(() => "?").join(",")})`).all(...ids)) {
      const id = Number(r.page_id);
      if (!links.has(id)) links.set(id, new Set());
      links.get(id)!.add(String(r.to_slug));
    }
  return suggestTree(pages, links);
}

