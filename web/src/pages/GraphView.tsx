import "./graph.css";
import cytoscape, { type Core, type EdgeSingular, type ElementDefinition, type NodeSingular } from "cytoscape";
import fcose from "cytoscape-fcose";
import layoutUtilities from "cytoscape-layout-utilities";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GraphData, type GraphJob, type GraphNode } from "../api.ts";
import { CATEGORY_LABEL, CATEGORY_ORDER, CategoryBadge, Empty, ErrorBox, JOB_STATUS_LABEL, Markdown, SCOPE_LABEL, StateBadge, act, go, isHistory, usePoll, useData } from "../lib.tsx";
import { EntityChips, KIND_LABEL, KindIcon, LINK_LABEL, LINK_TYPES, LinkList } from "./GraphPages.tsx";
import { ScopeTabs } from "./WikiPages.tsx";
import { Icon } from "../components/Icon.tsx";
import { SkeletonText } from "../components/Skeleton.tsx";
import { fitViewport, isolatedIds, isolatedKey, placeIsolated, placeLabels, sortIsolated, type Insets, type LabelCandidate } from "../graph-layout.ts";

// The interactive graph (cytoscape). Loaded lazily so the rest of the UI does not pay for it.

const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const LEGEND_CATS = CATEGORY_ORDER.filter((c) => c !== "standing");
const isRunning = (j: GraphJob) => j.status === "pending" || j.status === "processing";

cytoscape.use(fcose);
// fcose's packComponents silently does nothing unless layout-utilities is registered (G-081).
cytoscape.use(layoutUtilities);

/**
 * fcose (force-directed with spectral start): spreads clusters apart where cose pulled every
 * memory into one ball. Edges pull by kind (ADR-0047):
 *  - memory → entity "mentions": the more memories mention the entity (data "hub"), the
 *    longer and looser — the project's own name no longer ties everything to the middle;
 *  - because / depends_on / supersedes: short and stiff, so a chain of reasons reads as a unit;
 *  - related: in between.
 * (Cognee's story view loosens containment edges and tightens semantic ones the same way.)
 */
const hubOf = (e: EdgeSingular) => (e.data("type") === "mentions" ? Math.max(1, Number(e.data("hub")) || 1) : 1);
const edgeLength = (e: EdgeSingular) => {
  const t = e.data("type");
  return t === "mentions" ? 80 + 16 * Math.sqrt(hubOf(e)) : t === "related" ? 70 : 55;
};
const edgeElasticity = (e: EdgeSingular) => {
  const t = e.data("type");
  return t === "mentions" ? 0.45 / Math.sqrt(hubOf(e)) : t === "related" ? 0.55 : 0.7;
};
const LAYOUT = {
  name: "fcose",
  quality: "default",
  animate: false,
  padding: 40,
  nodeSeparation: 110,
  nodeRepulsion: () => 16000,
  idealEdgeLength: edgeLength,
  edgeElasticity,
  gravity: 0.2,
  numIter: 2500,
  packComponents: true,
};

// ------------------------------------------------------------------ labels
// Names stay the same size on screen at any zoom (like a map), and only names that fit are
// drawn — no two overlap and none covers an entity: entities first (most-mentioned first),
// the best-connected memories next, every memory title once zoomed in, at most one name per
// ~2400 px². Recomputed after every viewport change (placeLabels, graph-layout.ts). A
// cytoscape size threshold alone could not do it: it depends on the screen's pixel ratio (a
// Retina screen showed every name) and never stops two names overlapping. Same idea as
// Cognee's label claimer, Logseq's label grid and SiYuan's label budget.

/** On-screen label size (px): memories 11, entities 11–15 by how many memories mention them. */
const labelPx = (n: NodeSingular) =>
  n.data("kind") === "entity" ? 11 + 4 * Math.min(1, Math.max(0, (Number(n.data("deg")) - 2) / 22)) : 11;
/** Memory titles show from this zoom and hide again below the lower one (no flicker at the edge). */
const MEMORY_LABEL_SHOW = 0.95;
const MEMORY_LABEL_HIDE = 0.8;
/** Below this zoom "mentions" edges almost vanish: typed links and the clusters' shape show. */
const MENTIONS_FAR_ZOOM = 0.6;
/** Widest a memory title / an entity name gets on screen before the ellipsis (px). */
const MEMORY_LABEL_MAX = 160;
const ENTITY_LABEL_MAX = 400;

const widths = new Map<string, number>();
let measure: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, px: number, bold: boolean): number {
  const key = `${px}|${bold ? 1 : 0}|${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    if (measure === undefined) measure = document.createElement("canvas").getContext("2d");
    if (measure) {
      measure.font = `${bold ? "bold " : ""}${px}px Helvetica Neue, Helvetica, sans-serif`;
      w = measure.measureText(text).width;
    } else w = text.length * px * 0.7;
    if (widths.size > 20_000) widths.clear();
    widths.set(key, w);
  }
  return w;
}

/**
 * Sets each node's label size for the current zoom, fades "mentions" edges when zoomed out
 * and hides the names that would overlap. While a node is hovered or selected, only it and
 * its neighbours are candidates (the rest is faded).
 */
function updateLabels(c: Core) {
  const z = c.zoom();
  const vw = c.width();
  const vh = c.height();
  const prev = c.scratch("memoryTitles") === true;
  const memoryTitles = prev ? z >= MEMORY_LABEL_HIDE : z >= MEMORY_LABEL_SHOW;
  c.scratch("memoryTitles", memoryTitles);
  const focusing = c.nodes(".faded").nonempty();
  // Sizes depend on the zoom only: a pan keeps them (a refresh clears "labelZoom" to redo them).
  if (c.scratch("labelZoom") !== z) {
    c.scratch("labelZoom", z);
    c.batch(() => {
      c.nodes().forEach((n) => {
        const px = labelPx(n);
        const max = n.data("kind") === "entity" ? ENTITY_LABEL_MAX : MEMORY_LABEL_MAX;
        n.data({ fs: px / z, tm: 3 / z, tmw: max / z });
      });
      c.edges('[type = "mentions"]').toggleClass("far", z < MENTIONS_FAR_ZOOM);
    });
  }
  const candidates: LabelCandidate[] = [];
  const obstacles: { id: string; box: { x1: number; y1: number; x2: number; y2: number }; priority: number }[] = [];
  c.nodes().forEach((n) => {
    const p = n.renderedPosition();
    const r = n.renderedWidth() / 2;
    if (p.x + r < 0 || p.x - r > vw || p.y + r < 0 || p.y - r > vh) return;
    // Faded = outside the hovered/selected node's neighbourhood; a search hit still counts.
    if (n.hasClass("faded") && !n.hasClass("match")) return;
    const entity = n.data("kind") === "entity";
    // Entity squares block names (they covered "ClickHouse" once); memory dots are small and
    // so many that treating them as obstacles hid every name in the dense middle.
    if (entity) obstacles.push({ id: n.id(), box: { x1: p.x - r, x2: p.x + r, y1: p.y - r, y2: p.y + r }, priority: 1000 + Number(n.data("deg") ?? 0) });
    const label = String(n.data("label") ?? "");
    if (!label || n.hasClass("dim")) return;
    const forced = n.selected() || n.hasClass("match") || n.hasClass("focus") || n.hasClass("hover");
    const key = n.data("key") === true;
    if (!entity && !forced && !focusing && !memoryTitles && !key) return;
    const px = labelPx(n);
    const w = Math.min(textWidth(label, px, entity), entity ? ENTITY_LABEL_MAX : MEMORY_LABEL_MAX) + 4;
    const top = p.y + r + 3;
    const box = { x1: p.x - w / 2, x2: p.x + w / 2, y1: top, y2: top + px * 1.3 };
    const deg = Number(n.data("deg") ?? 0);
    const priority = forced ? 1e6 : (focusing ? 1e5 : 0) + (entity ? 1000 + deg : key ? 500 + deg : deg);
    candidates.push({ id: n.id(), box, priority });
  });
  const shown = placeLabels(candidates, { obstacles, budget: Math.max(32, Math.floor((vw * vh) / 2400)) });
  c.batch(() =>
    c.nodes().forEach((n) => {
      const hide = !shown.has(n.id());
      if (n.hasClass("nolabel") !== hide) n.toggleClass("nolabel", hide);
    }),
  );
}

/** Hover/selection focus: the node and its neighbours stay, everything else fades (LightRAG, Obsidian, Quartz…). */
function highlight(c: Core, n: NodeSingular | null) {
  c.batch(() => {
    c.elements().removeClass("faded hl hover");
    if (!n || n.removed()) return;
    const near = n.closedNeighborhood();
    c.elements().not(near).addClass("faded");
    near.edges().addClass("hl");
    n.addClass("hover");
  });
}

/** How far the floating toolbar/notices (top) and legend/hint (bottom) reach into the canvas. */
function overlayInsets(c: Core): Insets {
  const canvas = c.container();
  const stage = canvas?.parentElement;
  if (!canvas || !stage) return { top: 0, bottom: 0 };
  const r = canvas.getBoundingClientRect();
  let top = 0;
  let bottom = 0;
  for (const el of stage.querySelectorAll<HTMLElement>(".graph-top, .graph-legend, .graph-hint")) {
    const b = el.getBoundingClientRect();
    if (!b.height) continue;
    if (b.top - r.top < r.height / 2) top = Math.max(top, b.bottom - r.top);
    else bottom = Math.max(bottom, r.bottom - b.top);
  }
  return { top, bottom };
}

/** Fit `eles` into the part of the canvas the overlays leave free (cytoscape's fit pads evenly). */
function fitClear(c: Core, eles = c.elements(), animate = false, pad = 40) {
  if (!eles.length) return;
  // Without labels: they keep their screen size, so their model-space box depends on the current zoom.
  const bb = eles.boundingBox({ includeLabels: false });
  const v = fitViewport(bb, { w: c.width(), h: c.height() }, overlayInsets(c), pad, { min: c.minZoom(), max: c.maxZoom() });
  if (animate) c.animate({ zoom: v.zoom, pan: v.pan }, { duration: 250 });
  else c.viewport({ zoom: v.zoom, pan: v.pan });
}

/**
 * cose for the connected part only; nodes without edges go into a compact grid next to it
 * (graph-layout.ts) so fit-to-screen keeps labels readable instead of shrinking a tall column.
 */
function runLayout(c: Core, randomize: boolean) {
  const lone = new Set(
    isolatedIds(
      c.nodes().map((n) => n.id()),
      c.edges().map((e) => ({ source: e.source().id(), target: e.target().id() })),
    ),
  );
  const isolated = c.nodes().filter((n) => lone.has(n.id()));
  if (!isolated.length) {
    const all = c.layout({ ...LAYOUT, randomize, fit: false } as cytoscape.LayoutOptions);
    all.one("layoutstop", () => fitClear(c));
    all.run();
    return;
  }
  const connected = c.elements().not(isolated);
  const place = () => {
    const box = connected.nodes().length ? connected.nodes().boundingBox({ includeLabels: false }) : null;
    const order = sortIsolated(isolated.map((n) => isolatedKey({ ...(n.data("raw") as GraphNode), id: n.id() }, CATEGORY_ORDER)));
    const pos = placeIsolated(order, box, { w: c.width(), h: c.height() });
    c.batch(() => isolated.forEach((n) => void n.position(pos.get(n.id()) ?? { x: 0, y: 0 })));
    fitClear(c);
  };
  if (!connected.nodes().length) return place();
  const layout = connected.layout({ ...LAYOUT, randomize, fit: false } as cytoscape.LayoutOptions);
  layout.one("layoutstop", place);
  layout.run();
}

export function GraphPage({ projectId, initialFocus }: { projectId?: number; initialFocus?: string }) {
  const projects = useData(() => api.projects(), []);
  const graph = useData(() => api.graph(projectId), [projectId]);
  const jobs = useData(() => api.graphJobs(), []);
  const [showEntities, setShowEntities] = useState(true);
  // History (superseded / expired memories) is hidden unless asked for.
  const [showHistory, setShowHistory] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(initialFocus ?? null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [q, setQ] = useState("");
  const [dismissedJob, setDismissedJob] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Jobs come newest first; the latest one for this scope decides what the status bar says.
  const job = jobs.data?.find((j) => (j.payload.projectId ?? undefined) === projectId);
  const running = job && isRunning(job) ? job : undefined;
  usePoll(() => jobs.reload(), 3000, Boolean(running));
  // Refresh the graph when the running job advances or finishes (not on every poll: each refresh re-lays out).
  const progress = `${job?.id}:${job?.status}:${job?.result?.done?.length ?? 0}`;
  const lastProgress = useRef<string | null>(null);
  useEffect(() => {
    if (!jobs.data) return;
    const prev = lastProgress.current;
    lastProgress.current = progress;
    if (prev !== null && prev !== progress) graph.reload();
  }, [progress, jobs.data, graph.reload]);

  const elements = useMemo(
    () => buildElements(graph.data, { showEntities, showHistory, hidden, focus }),
    [graph.data, showEntities, showHistory, hidden, focus],
  );
  const pastCount = graph.data?.nodes.filter(isPast).length ?? 0;

  useEffect(() => {
    if (!box.current) return;
    // hideEdgesOnViewport: no edges while panning/zooming (cytoscape's performance advice; LightRAG hides them on move too).
    const c = cytoscape({ container: box.current, elements: [], style: graphStyle(), wheelSensitivity: 0.3, minZoom: 0.1, maxZoom: 3, hideEdgesOnViewport: true });
    (c as unknown as { layoutUtilities(o: object): unknown }).layoutUtilities({ desiredAspectRatio: Math.max(0.5, c.width() / Math.max(1, c.height())), componentSpacing: 40 });
    c.on("tap", "node", (ev) => setSelected(ev.target.data("raw") as GraphNode));
    c.on("tap", (ev) => ev.target === c && setSelected(null));
    c.on("dbltap", "node", (ev) => {
      const raw = ev.target.data("raw") as GraphNode;
      go(raw.type === "memory" ? `/e/${raw.entryId}` : `/entity/${raw.entityId}`);
    });
    cy.current = c;
    // Names are re-placed once a zoom, pan, resize, layout or selection settles.
    let relabelTimer = 0;
    const relabel = () => {
      window.clearTimeout(relabelTimer);
      relabelTimer = window.setTimeout(() => cy.current === c && updateLabels(c), 40);
    };
    c.on("viewport resize layoutstop select unselect dragfree", relabel);
    c.scratch("relabel", relabel);
    // Hover (or the selected node when not hovering) shows its neighbourhood, the rest fades.
    let hoverTimer = 0;
    const refocus = (n: NodeSingular | null) => {
      window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => {
        if (cy.current !== c) return;
        const sel = c.nodes(":selected");
        highlight(c, n ?? (sel.nonempty() ? sel[0] : null));
        relabel();
      }, 30);
    };
    c.on("mouseover", "node", (ev) => refocus(ev.target as NodeSingular));
    c.on("mouseout", "node", () => refocus(null));
    c.on("select unselect", "node", () => refocus(null));
    c.scratch("refocus", refocus);
    // Re-read colors when the theme changes: OS flip (for "system") or the in-app toggle.
    // rAF so the new data-theme has been applied before the tokens are read.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => requestAnimationFrame(() => cy.current === c && c.style(graphStyle()));
    mq.addEventListener("change", onTheme);
    window.addEventListener("theme:changed", onTheme);
    return () => {
      mq.removeEventListener("change", onTheme);
      window.removeEventListener("theme:changed", onTheme);
      window.clearTimeout(relabelTimer);
      window.clearTimeout(hoverTimer);
      c.destroy();
      cy.current = null;
    };
  }, []);

  // Apply element changes as a diff so a refresh keeps existing nodes where they are.
  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    const next = new Set(elements.map((e) => String(e.data.id)));
    const fresh = c.nodes().length === 0;
    let changed = false;
    c.batch(() => {
      const gone = c.elements().filter((el) => !next.has(el.id()));
      changed = gone.length > 0;
      gone.remove();
      const add: ElementDefinition[] = [];
      for (const def of elements) {
        const el = c.getElementById(String(def.data.id));
        if (el.empty()) add.push(def);
        else {
          el.data(def.data);
          // Only the data-driven classes; hover/selection fading and label state are runtime.
          const cls = typeof def.classes === "string" ? def.classes.split(" ") : (def.classes ?? []);
          for (const k of ["focus", "past"]) el.toggleClass(k, cls.includes(k));
        }
      }
      c.add(add);
      if (add.length) changed = true;
    });
    // Same set of nodes and edges (a plain refresh): keep the current picture. Sizes were reset
    // by the new data; the hover/selection highlight is re-applied to the new elements.
    c.scratch("labelZoom", null);
    (c.scratch("refocus") as ((n: NodeSingular | null) => void) | undefined)?.(null);
    (c.scratch("relabel") as (() => void) | undefined)?.();
    if (!changed || !c.nodes().length) return;
    runLayout(c, fresh);
  }, [elements]);

  // Highlight search matches.
  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    c.nodes().removeClass("match dim");
    (c.scratch("relabel") as (() => void) | undefined)?.();
    const needle = q.trim().toLowerCase();
    if (!needle) return;
    const hits = c.nodes().filter((n) => String((n.data("raw") as GraphNode).label).toLowerCase().includes(needle));
    c.nodes().not(hits).addClass("dim");
    hits.addClass("match");
    if (hits.length) fitClear(c, hits, true, 80);
  }, [q, elements]);

  // The drawer closed (X, Esc, another scope): drop cytoscape's selection too, or its
  // neighbourhood highlight would keep the rest of the graph faded.
  useEffect(() => {
    if (!selected) cy.current?.nodes(":selected").unselect();
  }, [selected]);

  // Esc closes the drawer (unless typing).
  useEffect(() => {
    if (!selected) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      setSelected(null);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [selected]);

  const project = projects.data?.find((p) => p.id === projectId);
  const memCount = graph.data?.nodes.filter((n) => n.type === "memory").length ?? 0;
  const entCount = graph.data?.nodes.filter((n) => n.type === "entity").length ?? 0;
  const linkCount = graph.data?.edges.filter((e) => e.type !== "mentions").length ?? 0;
  const unlinked = graph.data?.unlinked ?? 0;
  const toggleCat = (c: string) => {
    const next = new Set(hidden);
    next.has(c) ? next.delete(c) : next.add(c);
    setHidden(next);
  };
  const fit = () => cy.current && fitClear(cy.current, cy.current.elements(), true);
  const relayout = () => cy.current && runLayout(cy.current, true);
  const startBackfill = () => act(() => api.backfill(projectId), { success: "그래프 붙이기를 시작했습니다" }).then((r) => r !== undefined && jobs.reload());
  const scopeName = projectId ? (project ? `"${project.name}"` : "이 프로젝트") : "전체";

  // An empty canvas with unlinked memories is the moment to offer the backfill as the main action.
  const offerEmpty = Boolean(graph.data && !running && unlinked > 0 && entCount === 0 && linkCount === 0);
  const showJob = job && (running || ((job.status === "error" || job.status === "cancelled") && dismissedJob !== job.id));

  return (
    <article className="graph-page" aria-busy={graph.loading}>
      <header className="graph-head">
        <div className="graph-head-row">
          <h1>
            메모리 그래프
            {project && <span className="graph-head-scope">{project.name}</span>}
          </h1>
          <span className="graph-stats" aria-live="polite">
            메모리 {memCount} · 엔티티 {entCount} · 관계 {linkCount}
            {graph.data?.truncated ? " · 일부만 표시" : ""}
          </span>
          {graph.loading && graph.data && <span className="live-dot" title="불러오는 중" aria-label="불러오는 중" />}
        </div>
        {projectId && <ScopeTabs scope={projectId} active="graph" />}
      </header>

      <div className={`graph-stage${selected ? " has-drawer" : ""}`}>
        <div ref={box} className="graph-canvas" aria-label="메모리 그래프 캔버스" role="application" />

        <div className="graph-top">
        <div className="graph-float graph-toolbar" role="toolbar" aria-label="그래프 도구">
          <select value={projectId ?? ""} onChange={(e) => go(e.target.value ? `/graph?project=${e.target.value}` : "/graph")} aria-label="범위">
            <option value="">전체</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div className="search-field graph-search">
            <Icon name="search" size={14} />
            <input
              ref={searchRef}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setQ("");
                  searchRef.current?.blur();
                }
              }}
              placeholder="노드 찾기"
              aria-label="노드 찾기"
            />
          </div>
          <button className="chip" aria-pressed={showEntities} onClick={() => setShowEntities(!showEntities)} title="엔티티 노드 표시">
            <span className="entity-swatch" aria-hidden="true" />
            엔티티
          </button>
          {pastCount > 0 && (
            <button className="chip" aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)} title="대체되거나 만료된 메모리(이력)도 표시">
              <Icon name="rotate-ccw" size={13} />
              이력 {pastCount}
            </button>
          )}
          {focus && (
            <button className="chip" aria-pressed onClick={() => setFocus(null)} title="주변만 보기를 끄고 전체 그래프 보기">
              <Icon name="crosshair" size={13} />
              주변만 보는 중
              <Icon name="x" size={12} />
            </button>
          )}
          <span className="graph-toolbar-sep" aria-hidden="true" />
          <button className="icon-btn" onClick={fit} aria-label="화면에 맞추기" title="화면에 맞추기">
            <Icon name="scan" />
          </button>
          <button className="icon-btn" onClick={relayout} aria-label="다시 배치" title="다시 배치">
            <Icon name="rotate-ccw" />
          </button>
        </div>

        {showJob && job && <JobBar job={job} scopeName={scopeName} onChanged={() => jobs.reload()} onDismiss={() => setDismissedJob(job.id)} />}
        {!showJob && !offerEmpty && !running && unlinked > 0 && (
          <div className="graph-float graph-jobbar">
            <span className="graph-jobbar-text">
              엔티티가 없는 메모리 <b className="mono-num">{unlinked}</b>개
            </span>
            <button className="btn small" onClick={startBackfill}>
              <Icon name="share-2" size={14} />
              그래프 붙이기
            </button>
          </div>
        )}
        </div>

        <div className="graph-float graph-legend" role="group" aria-label="분류 범례 (누르면 숨김/표시)">
          {LEGEND_CATS.map((c) => (
            <button key={c} className="chip legend-chip" aria-pressed={!hidden.has(c)} onClick={() => toggleCat(c)} title={hidden.has(c) ? `${CATEGORY_LABEL[c]} 표시` : `${CATEGORY_LABEL[c]} 숨기기`}>
              <span className="swatch" style={{ background: `var(--c-${c})` }} />
              {CATEGORY_LABEL[c]}
            </button>
          ))}
          <span className="graph-legend-links" aria-label="관계 종류">
            {LINK_TYPES.map((t) => (
              <span key={t} className={`link-type lt-${t}`} title={LINK_LABEL[t].name}>
                {LINK_LABEL[t].out}
              </span>
            ))}
          </span>
        </div>

        <p className="graph-float graph-hint">올리면 연결 강조 · 누르면 정보 · 두 번 누르면 열기 · 휠로 확대</p>

        {graph.loading && !graph.data && (
          <div className="graph-center" aria-busy="true">
            <span className="graph-loading">
              <Icon name="loader" className="spin" />
              그래프를 불러오는 중…
            </span>
          </div>
        )}
        {graph.error && (
          <div className="graph-center">
            <ErrorBox error={graph.error} />
          </div>
        )}
        {offerEmpty && (
          <div className="graph-center">
            <Empty
              icon="share-2"
              title="아직 이어진 그래프가 없습니다"
              action={
                <button className="btn primary" onClick={startBackfill}>
                  <Icon name="share-2" />
                  그래프 붙이기
                </button>
              }
            >
              엔티티가 없는 메모리가 {unlinked}개 있습니다. LLM이 {scopeName} 메모리를 읽고 엔티티와 관계를 붙입니다.
            </Empty>
          </div>
        )}
        {graph.data && !offerEmpty && memCount === 0 && !running && (
          <div className="graph-center">
            <Empty icon="sticky-note" title="표시할 메모리가 없습니다">
              {projectId ? "이 프로젝트에 메모리가 쌓이면 그래프가 그려집니다." : "메모리가 쌓이면 그래프가 그려집니다."}
            </Empty>
          </div>
        )}

        {selected && <NodePanel key={selected.id} node={selected} onFocus={() => setFocus(selected.id)} focused={focus === selected.id} onClose={() => setSelected(null)} />}
      </div>
    </article>
  );
}

/** Backfill job status: label + progress, with cancel (queued/running) or resume (failed/cancelled). */
function JobBar({ job, scopeName, onChanged, onDismiss }: { job: GraphJob; scopeName: string; onChanged: () => void; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const done = job.result?.done?.length ?? 0;
  const total = job.payload.entries.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const running = isRunning(job);
  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    const r = await act(fn, { success });
    setBusy(false);
    if (r !== undefined) onChanged();
  };
  return (
    <div className={`graph-float graph-jobbar is-${job.status}`} role="status">
      <span className={`status st-${job.status}`}>{JOB_STATUS_LABEL[job.status] ?? job.status}</span>
      <span className="graph-jobbar-text">
        {running ? `${scopeName} 그래프 붙이기` : job.status === "error" ? "그래프 붙이기 실패" : "그래프 붙이기를 멈췄습니다"}
        <span className="faint mono-num">
          {" "}
          {done}/{total}
        </span>
        {job.status === "error" && job.error && (
          <span className="graph-jobbar-error" title={job.error}>
            {job.error}
          </span>
        )}
      </span>
      {running && (
        <span className="job-meter" role="progressbar" aria-label="진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
      {running ? (
        <button className="btn small ghost" disabled={busy} aria-busy={busy} onClick={() => run(() => api.cancelGraphJob(job.id), "그래프 붙이기를 취소했습니다")}>
          <Icon name="x" size={14} />
          취소
        </button>
      ) : (
        <>
          <button className="btn small" disabled={busy} aria-busy={busy} onClick={() => run(() => api.retryGraphJob(job.id), "이어서 다시 실행합니다")}>
            <Icon name="rotate-ccw" size={14} />
            이어서 다시 실행
          </button>
          <button className="icon-btn" onClick={onDismiss} aria-label="알림 닫기" title="닫기">
            <Icon name="x" size={14} />
          </button>
        </>
      )}
    </div>
  );
}

/** Memory node ids that are history (superseded / expired); shown only with "이력". An older server sends no flag: current. */
const isPast = (n: GraphNode) => n.type === "memory" && n.active === false;

function buildElements(
  data: GraphData | undefined,
  f: { showEntities: boolean; showHistory: boolean; hidden: Set<string>; focus: string | null },
): ElementDefinition[] {
  if (!data) return [];
  // The focused node stays even when it is history ("그래프에서 보기" from a replaced memory).
  let nodes = data.nodes.filter((n) =>
    n.type === "memory" ? !f.hidden.has(n.category) && (f.showHistory || !isPast(n) || n.id === f.focus) : f.showEntities,
  );
  let ids = new Set(nodes.map((n) => n.id));
  let edges = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  if (f.focus && ids.has(f.focus)) {
    // Two hops around the focused node: memory → entity → other memories.
    const keep = new Set([f.focus]);
    for (let hop = 0; hop < 2; hop++)
      for (const e of edges) {
        if (keep.has(e.source)) keep.add(e.target);
        else if (keep.has(e.target)) keep.add(e.source);
      }
    nodes = nodes.filter((n) => keep.has(n.id));
    ids = keep;
    edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  }
  // How many visible memories mention each entity (its hub size, for the layout and the style).
  const deg = new Map<string, number>();
  for (const e of edges) if (e.type === "mentions") deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  // Entities mentioned by a single visible memory add clutter without connecting anything.
  if (!f.focus) {
    const lonely = new Set(nodes.filter((n) => n.type === "entity" && (deg.get(n.id) ?? 0) < 2).map((n) => n.id));
    nodes = nodes.filter((n) => !lonely.has(n.id));
    edges = edges.filter((e) => !lonely.has(e.target));
  }
  // A memory's degree: mentions count once, a typed link twice (it says more). The top tenth
  // (degree ≥ 3) are "key" memories, named even at the overview (Cognee's key labels, R2R's
  // degree percentile).
  const mdeg = new Map<string, number>();
  for (const e of edges) {
    if (e.type === "mentions") mdeg.set(e.source, (mdeg.get(e.source) ?? 0) + 1);
    else for (const end of [e.source, e.target]) mdeg.set(end, (mdeg.get(end) ?? 0) + 2);
  }
  const memDegs = nodes.filter((n) => n.type === "memory").map((n) => mdeg.get(n.id) ?? 0).sort((a, b) => b - a);
  const keyCut = Math.max(3, memDegs[Math.floor(memDegs.length * 0.1)] ?? Infinity);
  const maxDeg = Math.max(3, ...deg.values());
  // Sizes grow with the square root (LightRAG, Cognee, Quartz): a hub no longer dwarfs the rest.
  const sizeOf = (n: GraphNode) =>
    n.type === "entity"
      ? 12 + 26 * Math.sqrt(Math.max(0, (deg.get(n.id) ?? 0) - 2) / (maxDeg - 2))
      : Math.min(22, 10 + 3 * Math.sqrt(mdeg.get(n.id) ?? 0));
  return [
    ...nodes.map((n) => ({
      data: {
        id: n.id,
        label: n.label.length > 40 ? `${n.label.slice(0, 38)}…` : n.label,
        kind: n.type,
        category: n.type === "memory" ? n.category : n.kind,
        size: sizeOf(n),
        deg: n.type === "entity" ? (deg.get(n.id) ?? 0) : (mdeg.get(n.id) ?? 0),
        key: n.type === "memory" && (mdeg.get(n.id) ?? 0) >= keyCut,
        raw: n,
        // Label size, gap and width in model units; updateLabels keeps them constant on screen.
        fs: 11,
        tm: 3,
        tmw: n.type === "entity" ? ENTITY_LABEL_MAX : MEMORY_LABEL_MAX,
      },
      classes: [n.id === f.focus ? "focus" : "", isPast(n) ? "past" : ""].join(" ").trim() || undefined,
    })),
    ...edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, type: e.type, hub: e.type === "mentions" ? (deg.get(e.target) ?? 1) : 1 } })),
  ];
}

function graphStyle(): cytoscape.StylesheetJson {
  const text = cssVar("--color-text", "#18181b");
  const muted = cssVar("--color-text-2", "#5f6170");
  const border = cssVar("--color-border-strong", "#d4d4da");
  const surface = cssVar("--color-surface", "#ffffff");
  const accent = cssVar("--color-accent", "#5b5bd6");
  const cats = CATEGORY_ORDER.map((c) => ({ selector: `node[kind = "memory"][category = "${c}"]`, style: { "background-color": cssVar(`--c-${c}`, muted) } }));
  // Same hues as the .lt-* relation badges.
  const linkColor: Record<string, string> = {
    because: cssVar("--color-info-text", "#0d74ce"),
    depends_on: cssVar("--color-warn-text", "#ab6400"),
    supersedes: cssVar("--color-danger-text", "#ce2c31"),
    related: muted,
  };
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        // Constant on screen whatever the zoom; which names show is updateLabels' job.
        "font-size": "data(fs)",
        color: text,
        "text-valign": "bottom",
        "text-margin-y": "data(tm)",
        "text-wrap": "ellipsis",
        "text-max-width": "data(tmw)",
        width: "data(size)",
        height: "data(size)",
        "border-width": 1,
        "border-color": surface,
      },
    },
    ...cats,
    {
      selector: 'node[kind = "entity"]',
      style: {
        // A square sized by how many memories mention it (data "size", square root); the name sits
        // under it (a box sized to its label would stay as an empty box when the name is hidden).
        shape: "round-rectangle",
        "background-color": surface,
        "border-color": accent,
        "border-width": 2,
        "font-weight": "bold",
        "text-background-color": surface,
        "text-background-opacity": 0.8,
        "text-background-padding": "1px",
      },
    },
    { selector: "edge", style: { width: 1, "line-color": border, "curve-style": "bezier", opacity: 0.7 } },
    // Mentions are most of the edges: thin, and fainter the bigger the hub, so links stand out.
    { selector: 'edge[type = "mentions"]', style: { width: 0.7, "curve-style": "haystack", opacity: "mapData(hub, 2, 40, 0.5, 0.12)" } },
    ...LINK_TYPES.map((t) => ({
      selector: `edge[type = "${t}"]`,
      style: {
        // "related" is the most common link and says the least: thinner and lighter than the typed ones.
        width: t === "related" ? 1.2 : 2,
        "line-color": linkColor[t],
        "target-arrow-color": linkColor[t],
        "target-arrow-shape": t === "related" ? "none" : "triangle",
        "line-style": t === "supersedes" ? "dashed" : "solid",
        opacity: t === "related" ? 0.55 : 0.9,
      },
    })),
    // Zoomed out, "mentions" (most of the edges) nearly vanish: typed links and the clusters show.
    { selector: "edge.far", style: { opacity: 0.05 } },
    // A memory that is history (superseded / expired), shown only with "이력".
    { selector: "node.past", style: { opacity: 0.55, "border-style": "dashed", "border-width": 2, "border-color": muted } },
    // Hover / selection: the node's own edges stand out, everything else fades.
    { selector: "edge.hl", style: { opacity: 1, width: 2.5 } },
    { selector: 'edge.hl[type = "mentions"]', style: { opacity: 0.8, width: 1.5, "line-color": accent } },
    { selector: "node.faded", style: { opacity: 0.15 } },
    { selector: "edge.faded", style: { opacity: 0.03 } },
    { selector: "node:selected, node.focus", style: { "border-width": 3, "border-color": accent } },
    { selector: "node.match", style: { "border-width": 3, "border-color": accent } },
    { selector: "node.dim", style: { opacity: 0.25 } },
    // A search hit stays visible even outside a hovered/selected neighbourhood.
    { selector: "node.match", style: { opacity: 1 } },
    // Named nodes are drawn last, so no other node's shape covers a name; a name that would
    // overlap a more important one is not drawn (updateLabels).
    { selector: "node", style: { "z-index": 10 } },
    { selector: "node.nolabel", style: { label: "", "z-index": 0 } },
  ] as cytoscape.StylesheetJson;
}

function NodePanel({ node, onFocus, focused, onClose }: { node: GraphNode; onFocus: () => void; focused: boolean; onClose: () => void }) {
  const entry = useData(() => (node.type === "memory" ? api.entry(node.entryId) : Promise.resolve(null)), [node.id]);
  const entity = useData(() => (node.type === "entity" ? api.entity(node.entityId) : Promise.resolve(null)), [node.id]);
  const href = node.type === "memory" ? `#/e/${node.entryId}` : `#/entity/${node.entityId}`;
  const error = entry.error ?? entity.error;
  const e = entry.data?.entry;
  return (
    <aside className="graph-drawer" aria-label={node.type === "memory" ? "메모리 정보" : "엔티티 정보"}>
      <div className="graph-drawer-head">
        <span className="graph-drawer-kind">
          {node.type === "memory" ? (
            <>
              <Icon name="sticky-note" size={14} />
              메모리 <span className="mono-num">#{node.entryId}</span>
            </>
          ) : (
            <>
              <KindIcon kind={node.kind} />
              엔티티 · {KIND_LABEL[node.kind] ?? node.kind}
            </>
          )}
        </span>
        <button className="icon-btn" onClick={onClose} aria-label="정보 닫기" title="닫기 (Esc)">
          <Icon name="x" />
        </button>
      </div>
      <div className="graph-drawer-body">
        <ErrorBox error={error} />
        {node.type === "memory" && !entry.data && !error && <SkeletonText lines={5} />}
        {node.type === "entity" && !entity.data && !error && <SkeletonText lines={5} />}
        {node.type === "memory" && entry.data && e && (
          <div>
            <div className="graph-drawer-meta">
              <CategoryBadge category={e.category} />
              <span className="faint small">{e.scope === "project" ? entry.data.project?.name ?? "프로젝트" : SCOPE_LABEL[e.scope]}</span>
              <StateBadge e={e} />
            </div>
            <h3>
              <a href={href}>{e.title}</a>
            </h3>
            {e.body && (
              <div className="graph-drawer-md">
                <Markdown>{e.body.length > 600 ? `${e.body.slice(0, 600)}…` : e.body}</Markdown>
              </div>
            )}
            {entry.data.entities.length > 0 && <div className="graph-drawer-label">엔티티</div>}
            <EntityChips entities={entry.data.entities} />
            {entry.data.links.length > 0 && <div className="graph-drawer-label">관계</div>}
            <LinkList links={entry.data.links} />
          </div>
        )}
        {node.type === "entity" && entity.data && (
          <>
            <h3>
              <a href={href}>{entity.data.entity.name}</a>
            </h3>
            {entity.data.entity.description && <p className="small muted">{entity.data.entity.description}</p>}
            <div className="graph-drawer-label">
              메모리 <span className="count">{entity.data.memories.length}</span>
            </div>
            <div className="list graph-drawer-list">
              {entity.data.memories.slice(0, 12).map((m) => (
                <a key={m.id} className={`list-row${isHistory(m) ? " is-history" : ""}`} href={`#/e/${m.id}`}>
                  <span className="graph-drawer-row-title">{m.title}</span>
                  <span className="faint small">
                    {m.project_name ?? SCOPE_LABEL[m.scope]} {isHistory(m) && <StateBadge e={m} linked={false} />}
                  </span>
                </a>
              ))}
            </div>
            {entity.data.memories.length > 12 && (
              <a className="small" href={href}>
                {entity.data.memories.length - 12}개 더 보기
              </a>
            )}
          </>
        )}
      </div>
      <div className="graph-drawer-foot">
        <button className="btn small" onClick={onFocus} disabled={focused} aria-pressed={focused}>
          <Icon name="crosshair" size={14} />
          주변만 보기
        </button>
        <a className="btn small primary" href={href}>
          <Icon name="external-link" size={14} />
          열기
        </a>
      </div>
    </aside>
  );
}
