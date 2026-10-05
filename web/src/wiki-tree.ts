// Wiki page tree (ADR-0036), pure: no React, no DOM (server tests import it).
// Pages carry parent_id; a page whose parent is missing (another wiki, the
// trash, a broken row) or that sits in a cycle is shown at the top level, so
// every live page appears exactly once.

export interface TreePage {
  id: number;
  parent_id: number | null;
  slug: string;
  title: string;
}

export interface TreeNode<P extends TreePage> {
  page: P;
  children: TreeNode<P>[];
}

/** Nodes in the order the pages came (the server orders by title), children likewise. */
export function buildTree<P extends TreePage>(pages: P[]): TreeNode<P>[] {
  const nodes = new Map(pages.map((p) => [p.id, { page: p, children: [] as TreeNode<P>[] }]));
  // Accepted edges only: a page goes under its parent unless the parent already
  // hangs (through accepted edges) under this page — the edge that would close a cycle.
  const up = new Map<number, number>();
  const hangsUnder = (from: number, target: number) => {
    for (let at: number | undefined = from, n = 0; at !== undefined && n <= pages.length; at = up.get(at), n++) if (at === target) return true;
    return false;
  };
  const roots: TreeNode<P>[] = [];
  for (const p of pages) {
    const parent = p.parent_id == null ? undefined : nodes.get(p.parent_id);
    if (parent && !hangsUnder(parent.page.id, p.id)) up.set(p.id, parent.page.id);
  }
  for (const p of pages) {
    const at = up.get(p.id);
    if (at === undefined) roots.push(nodes.get(p.id)!);
    else nodes.get(at)!.children.push(nodes.get(p.id)!);
  }
  return roots;
}

/** The pages above `id`, top first (empty for a top-level page). */
export function ancestors<P extends TreePage>(pages: P[], id: number): P[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out: P[] = [];
  const seen = new Set<number>([id]);
  for (let at = byId.get(id)?.parent_id ?? null; at != null; ) {
    const p = byId.get(at);
    if (!p || seen.has(p.id)) break;
    seen.add(p.id);
    out.unshift(p);
    at = p.parent_id;
  }
  return out;
}

/** Ids of every page under `id` (not `id` itself): what a parent picker must leave out besides the page. */
export function descendantIds<P extends TreePage>(pages: P[], id: number): Set<number> {
  const kids = new Map<number, number[]>();
  for (const p of pages) if (p.parent_id != null) kids.set(p.parent_id, [...(kids.get(p.parent_id) ?? []), p.id]);
  const out = new Set<number>();
  const stack = [...(kids.get(id) ?? [])];
  while (stack.length) {
    const at = stack.pop()!;
    if (out.has(at) || at === id) continue;
    out.add(at);
    stack.push(...(kids.get(at) ?? []));
  }
  return out;
}

/** Keeps nodes that match and every node on the way to one (so a match is shown where it lives). */
export function filterTree<P extends TreePage>(nodes: TreeNode<P>[], match: (p: P) => boolean): TreeNode<P>[] {
  const out: TreeNode<P>[] = [];
  for (const n of nodes) {
    const children = filterTree(n.children, match);
    if (match(n.page) || children.length) out.push({ page: n.page, children });
  }
  return out;
}

export interface FlatRow<P extends TreePage> {
  page: P;
  depth: number;
  childCount: number;
  open: boolean;
}

/** Rows to render: a node's children follow it while it is open (`closed` holds collapsed ids; `all` ignores it). */
export function flatten<P extends TreePage>(nodes: TreeNode<P>[], closed: Set<number>, all = false, depth = 0, out: FlatRow<P>[] = []): FlatRow<P>[] {
  for (const n of nodes) {
    const open = all || !closed.has(n.page.id);
    out.push({ page: n.page, depth, childCount: n.children.length, open });
    if (open && n.children.length) flatten(n.children, closed, all, depth + 1, out);
  }
  return out;
}

/** Ids of every node that has children (for "expand all / collapse all"). */
export function parentIds<P extends TreePage>(nodes: TreeNode<P>[], out = new Set<number>()): Set<number> {
  for (const n of nodes)
    if (n.children.length) {
      out.add(n.page.id);
      parentIds(n.children, out);
    }
  return out;
}
