// Sparse-graph placement for the memory graph (pure, no DOM/React/cytoscape so it can be tested from
// server/test). cose stacks unconnected nodes into a tall column, and fitting that to the screen makes
// every label unreadable. Instead GraphView lays out only the connected part with cose and puts the
// isolated nodes in a compact grid below or beside it, shaped so the whole picture fits the viewport
// at the largest zoom.

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface IsolatedNode {
  id: string;
  /** Primary sort key (e.g. the category's position in the legend). */
  group: number;
  /** Secondary sort key (e.g. the memory id); ties fall back to the node id. */
  order: number;
}
export interface GridOptions {
  /** Cell size in model units; a memory node's label is at most 140px wide at 10px. */
  cellW?: number;
  cellH?: number;
  /** Space between the connected part and the grid. */
  gap?: number;
  /** Zoom past which labels are readable anyway; above it the shape closest to the viewport wins. */
  enoughZoom?: number;
}
export interface GridPlan {
  placement: "below" | "beside" | "alone";
  cols: number;
  rows: number;
  /** The fit zoom of the whole picture (connected part + grid) in the given viewport. */
  zoom: number;
  /** Width / height of the whole picture. */
  aspect: number;
}

export const GRID_DEFAULTS = { cellW: 160, cellH: 52, gap: 80, enoughZoom: 1 } as const;

/** Ids of nodes without any edge to another visible node, in the input order. */
export function isolatedIds(nodeIds: readonly string[], edges: readonly { source: string; target: string }[]): string[] {
  const linked = new Set<string>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    linked.add(e.source);
    linked.add(e.target);
  }
  return nodeIds.filter((id) => !linked.has(id));
}

/** The fields of a graph node the grid order needs (a subset of api.ts GraphNode). */
export type LayoutNode = { id: string; type: "memory"; entryId: number; category: string } | { id: string; type: "entity"; entityId: number };

/**
 * Grid sort key for a graph node: memories by legend category, then id; a category missing from
 * the legend goes after the known ones (never before them); entities always come last.
 */
export function isolatedKey(node: LayoutNode, categoryOrder: readonly string[]): IsolatedNode {
  if (node.type === "entity") return { id: node.id, group: categoryOrder.length + 1, order: node.entityId };
  const i = categoryOrder.indexOf(node.category);
  return { id: node.id, group: i < 0 ? categoryOrder.length : i, order: node.entryId };
}

/** Deterministic grid order: group, then order, then id — independent of the input order. */
export function sortIsolated(nodes: readonly IsolatedNode[]): string[] {
  return [...nodes]
    .sort((a, b) => a.group - b.group || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((n) => n.id);
}

/** Pick where the grid goes and how many columns it gets so the overall fit zoom is largest. */
export function planGrid(n: number, anchor: Box | null, view: { w: number; h: number }, opts: GridOptions = {}): GridPlan {
  const { cellW, cellH, gap, enoughZoom } = { ...GRID_DEFAULTS, ...opts };
  const vw = Math.max(1, view.w);
  const vh = Math.max(1, view.h);
  if (n <= 0) return { placement: anchor ? "below" : "alone", cols: 0, rows: 0, zoom: Infinity, aspect: vw / vh };
  // How far a picture's shape is from the viewport's (0 = same aspect).
  const skew = (aspect: number) => Math.abs(Math.log(aspect / (vw / vh)));
  const aw = anchor ? Math.max(0, anchor.x2 - anchor.x1) : 0;
  const ah = anchor ? Math.max(0, anchor.y2 - anchor.y1) : 0;
  let best: GridPlan | null = null;
  const placements: GridPlan["placement"][] = anchor ? ["below", "beside"] : ["alone"];
  for (const placement of placements)
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      // Skip column counts that give the same rows as a smaller one (wider grid, same height).
      if (cols > 1 && Math.ceil(n / (cols - 1)) === rows) continue;
      const gw = cols * cellW;
      const gh = rows * cellH;
      const W = placement === "below" ? Math.max(aw, gw) : placement === "beside" ? aw + gap + gw : gw;
      const H = placement === "below" ? ah + gap + gh : placement === "beside" ? Math.max(ah, gh) : gh;
      const zoom = Math.min(vw / W, vh / H);
      const aspect = W / H;
      // Larger fit zoom wins until labels are readable anyway; then the shape closest to the
      // viewport. Exact ties keep the earlier candidate (below before beside, fewer columns).
      const z = Math.min(zoom, enoughZoom);
      const bz = best ? Math.min(best.zoom, enoughZoom) : -1;
      if (!best || z > bz + 1e-9 || (Math.abs(z - bz) <= 1e-9 && skew(aspect) < skew(best.aspect) - 1e-9)) best = { placement, cols, rows, zoom, aspect };
    }
  return best!;
}

/**
 * Grid positions (node centers) for the isolated nodes, in the given order (row by row).
 * With an anchor (the connected part's bounding box) the grid starts below it, left-aligned, or
 * beside it, top-aligned; without one it is centered on the origin.
 */
export function placeIsolated(ids: readonly string[], anchor: Box | null, view: { w: number; h: number }, opts: GridOptions = {}): Map<string, Point> {
  const out = new Map<string, Point>();
  if (!ids.length) return out;
  const { cellW, cellH, gap } = { ...GRID_DEFAULTS, ...opts };
  const plan = planGrid(ids.length, anchor, view, opts);
  let x0: number;
  let y0: number;
  if (!anchor) {
    x0 = -(plan.cols * cellW) / 2;
    y0 = -(plan.rows * cellH) / 2;
  } else if (plan.placement === "below") {
    x0 = anchor.x1;
    y0 = anchor.y2 + gap;
  } else {
    x0 = anchor.x2 + gap;
    y0 = anchor.y1;
  }
  ids.forEach((id, i) => {
    const col = i % plan.cols;
    const row = Math.floor(i / plan.cols);
    out.set(id, { x: x0 + (col + 0.5) * cellW, y: y0 + (row + 0.5) * cellH });
  });
  return out;
}

/** Space the floating toolbar (top) and legend (bottom) cover over the canvas, in px. */
export interface Insets {
  top: number;
  bottom: number;
}

/**
 * Viewport that fits `box` (model coordinates) into the canvas part the overlays
 * leave free, with `pad` px around it, centered there. Cytoscape's own fit pads all
 * sides equally, so nodes ended up under the toolbar or the legend.
 */
export function fitViewport(
  box: Box,
  view: { w: number; h: number },
  insets: Insets,
  pad = 40,
  zoomRange: { min: number; max: number } = { min: 0.1, max: 3 },
): { zoom: number; pan: Point } {
  const bw = Math.max(box.x2 - box.x1, 1);
  const bh = Math.max(box.y2 - box.y1, 1);
  const availW = Math.max(view.w - 2 * pad, 1);
  const availH = Math.max(view.h - insets.top - insets.bottom - 2 * pad, 1);
  const zoom = Math.min(Math.max(Math.min(availW / bw, availH / bh), zoomRange.min), zoomRange.max);
  return {
    zoom,
    pan: {
      x: (view.w - bw * zoom) / 2 - box.x1 * zoom,
      y: insets.top + pad + (availH - bh * zoom) / 2 - box.y1 * zoom,
    },
  };
}
