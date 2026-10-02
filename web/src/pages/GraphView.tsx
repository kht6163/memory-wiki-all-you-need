import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GraphData, type GraphNode } from "../api.ts";
import { CATEGORY_LABEL, CATEGORY_ORDER, CategoryBadge, ErrorBox, Markdown, SCOPE_LABEL, act, go, useData } from "../lib.tsx";
import { EntityChips, KIND_LABEL, LINK_TYPES, LinkList } from "./GraphPages.tsx";
import { ScopeTabs } from "./WikiPages.tsx";

// The interactive graph (cytoscape). Loaded lazily so the rest of the UI does not pay for it.

const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function GraphPage({ projectId, initialFocus }: { projectId?: number; initialFocus?: string }) {
  const projects = useData(() => api.projects(), []);
  const graph = useData(() => api.graph(projectId), [projectId]);
  const jobs = useData(() => api.graphJobs(), []);
  const [showEntities, setShowEntities] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(initialFocus ?? null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);

  const mine = (j: { payload: { projectId?: number | null } }) => (j.payload.projectId ?? undefined) === projectId;
  const running = jobs.data?.find((j) => mine(j) && (j.status === "pending" || j.status === "processing"));
  const failed = jobs.data?.find((j) => mine(j) && j.status === "error");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      jobs.reload();
      graph.reload();
    }, 5000);
    return () => clearInterval(t);
  }, [running?.id, jobs.reload, graph.reload]);

  const elements = useMemo(() => buildElements(graph.data, { showEntities, hidden, focus }), [graph.data, showEntities, hidden, focus]);

  useEffect(() => {
    if (!box.current) return;
    const c = cytoscape({ container: box.current, elements: [], style: graphStyle(), wheelSensitivity: 0.3, minZoom: 0.1, maxZoom: 3 });
    c.on("tap", "node", (ev) => setSelected(ev.target.data("raw") as GraphNode));
    c.on("tap", (ev) => ev.target === c && setSelected(null));
    c.on("dbltap", "node", (ev) => {
      const raw = ev.target.data("raw") as GraphNode;
      go(raw.type === "memory" ? `/e/${raw.entryId}` : `/entity/${raw.entityId}`);
    });
    cy.current = c;
    // Re-read colors when the OS theme flips.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => c.style(graphStyle());
    mq.addEventListener("change", onTheme);
    return () => {
      mq.removeEventListener("change", onTheme);
      c.destroy();
      cy.current = null;
    };
  }, []);

  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    c.elements().remove();
    c.add(elements);
    c.layout({ name: "cose", animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 70, nodeOverlap: 20, componentSpacing: 120, padding: 30, randomize: true } as cytoscape.LayoutOptions).run();
  }, [elements]);

  // Highlight search matches.
  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    c.nodes().removeClass("match dim");
    const needle = q.trim().toLowerCase();
    if (!needle) return;
    const hits = c.nodes().filter((n) => String(n.data("label")).toLowerCase().includes(needle));
    c.nodes().not(hits).addClass("dim");
    hits.addClass("match");
    if (hits.length) c.animate({ fit: { eles: hits, padding: 80 } }, { duration: 300 });
  }, [q, elements]);

  const project = projects.data?.find((p) => p.id === projectId);
  const memCount = graph.data?.nodes.filter((n) => n.type === "memory").length ?? 0;
  const entCount = graph.data?.nodes.filter((n) => n.type === "entity").length ?? 0;
  const linkCount = graph.data?.edges.filter((e) => e.type !== "mentions").length ?? 0;
  const toggleCat = (c: string) => {
    const next = new Set(hidden);
    next.has(c) ? next.delete(c) : next.add(c);
    setHidden(next);
  };

  return (
    <article className="page wide graph-page">
      <header className="page-head">
        <h1>메모리 그래프{project ? ` · ${project.name}` : ""}</h1>
        {projectId && <ScopeTabs scope={projectId} active="graph" />}
        <p className="lead">
          메모리(점)와 엔티티(네모)가 이어진 지식 그래프입니다. 메모리끼리는 이유·전제·대체·관련 관계로 잇습니다. 턴이 정리될 때 LLM이 함께 채우고, 메모리 화면에서 직접 고칠 수 있습니다.
        </p>
        <div className="toolbar graph-toolbar">
          <select value={projectId ?? ""} onChange={(e) => go(e.target.value ? `/graph?project=${e.target.value}` : "/graph")}>
            <option value="">전체</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input className="graph-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="노드 찾기" />
          <label className="check">
            <input type="checkbox" checked={showEntities} onChange={(e) => setShowEntities(e.target.checked)} /> 엔티티
          </label>
          {focus && (
            <button className="btn small" onClick={() => setFocus(null)}>
              전체 보기
            </button>
          )}
          <button className="btn small" onClick={() => cy.current?.layout({ name: "cose", animate: false, randomize: true, nodeOverlap: 20, componentSpacing: 120 } as cytoscape.LayoutOptions).run()}>
            다시 배치
          </button>
          <span className="muted small right">
            메모리 {memCount} · 엔티티 {entCount} · 관계 {linkCount}
            {graph.data?.truncated ? " · 일부만 표시" : ""}
          </span>
        </div>
        <div className="legend">
          {CATEGORY_ORDER.filter((c) => c !== "standing").map((c) => (
            <button key={c} className={`legend-item${hidden.has(c) ? " off" : ""}`} onClick={() => toggleCat(c)}>
              <span className="swatch" style={{ background: `var(--c-${c})` }} />
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
        {failed && !running && (
          <div className="notice small">
            그래프 붙이기가 실패했습니다 ({failed.result?.done?.length ?? 0}/{failed.payload.entries.length}): {failed.error}{" "}
            <button className="btn small" onClick={() => act(() => api.retryGraphJob(failed.id)).then(() => jobs.reload())}>
              이어서 다시 실행
            </button>
          </div>
        )}
        <BackfillBar unlinked={graph.data?.unlinked ?? 0} projectId={projectId} running={running} onStart={() => jobs.reload()} />
      </header>
      <ErrorBox error={graph.error} />
      <div className="graph-wrap">
        <div ref={box} className="graph-canvas" />
        {graph.data && memCount === 0 && <div className="graph-empty muted">표시할 메모리가 없습니다.</div>}
        {selected && <NodePanel node={selected} onFocus={() => setFocus(selected.id)} onClose={() => setSelected(null)} />}
      </div>
      <p className="muted small">노드를 누르면 정보, 두 번 누르면 상세 화면으로 갑니다. 휠로 확대하고 끌어서 옮깁니다.</p>
    </article>
  );
}

function buildElements(data: GraphData | undefined, f: { showEntities: boolean; hidden: Set<string>; focus: string | null }): ElementDefinition[] {
  if (!data) return [];
  let nodes = data.nodes.filter((n) => (n.type === "memory" ? !f.hidden.has(n.category) : f.showEntities));
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
  // Entities mentioned by a single visible memory add clutter without connecting anything.
  if (!f.focus) {
    const deg = new Map<string, number>();
    for (const e of edges) if (e.type === "mentions") deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    const lonely = new Set(nodes.filter((n) => n.type === "entity" && (deg.get(n.id) ?? 0) < 2).map((n) => n.id));
    nodes = nodes.filter((n) => !lonely.has(n.id));
    edges = edges.filter((e) => !lonely.has(e.target));
  }
  return [
    ...nodes.map((n) => ({
      data: {
        id: n.id,
        label: n.label.length > 40 ? `${n.label.slice(0, 38)}…` : n.label,
        kind: n.type,
        category: n.type === "memory" ? n.category : n.kind,
        size: n.type === "entity" ? Math.min(60, 22 + n.count * 4) : 16,
        raw: n,
      },
      classes: n.id === f.focus ? "focus" : undefined,
    })),
    ...edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, type: e.type } })),
  ];
}

function graphStyle(): cytoscape.StylesheetJson {
  const text = cssVar("--text", "#1f2328");
  const muted = cssVar("--muted", "#6b7079");
  const border = cssVar("--border-strong", "#d2d2cc");
  const surface = cssVar("--surface", "#fff");
  const accent = cssVar("--accent", "#4f46e5");
  const cats = CATEGORY_ORDER.map((c) => ({ selector: `node[kind = "memory"][category = "${c}"]`, style: { "background-color": cssVar(`--c-${c}`, muted) } }));
  const linkColor: Record<string, string> = { because: cssVar("--c-failure", "#c2410c"), depends_on: cssVar("--c-preference", "#0369a1"), supersedes: muted, related: cssVar("--c-decision", "#7e22ce") };
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "font-size": 10,
        color: text,
        "text-valign": "bottom",
        "text-margin-y": 4,
        "min-zoomed-font-size": 8,
        "text-wrap": "ellipsis",
        "text-max-width": "140px",
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
        shape: "round-rectangle",
        "background-color": surface,
        "border-color": accent,
        "border-width": 2,
        "font-size": 12,
        "font-weight": "bold",
        "text-valign": "center",
        "text-margin-y": 0,
        width: "label",
        height: 22,
        padding: "6px",
        "min-zoomed-font-size": 0,
      },
    },
    { selector: "edge", style: { width: 1, "line-color": border, "curve-style": "bezier", opacity: 0.7 } },
    ...LINK_TYPES.map((t) => ({
      selector: `edge[type = "${t}"]`,
      style: {
        width: 2,
        "line-color": linkColor[t],
        "target-arrow-color": linkColor[t],
        "target-arrow-shape": t === "related" ? "none" : "triangle",
        "line-style": t === "supersedes" ? "dashed" : "solid",
        opacity: 0.9,
      },
    })),
    { selector: "node:selected, node.focus", style: { "border-width": 3, "border-color": accent } },
    { selector: "node.match", style: { "border-width": 3, "border-color": accent, "min-zoomed-font-size": 0 } },
    { selector: "node.dim", style: { opacity: 0.25 } },
  ] as cytoscape.StylesheetJson;
}

function NodePanel({ node, onFocus, onClose }: { node: GraphNode; onFocus: () => void; onClose: () => void }) {
  const entry = useData(() => (node.type === "memory" ? api.entry(node.entryId) : Promise.resolve(null)), [node.id]);
  const entity = useData(() => (node.type === "entity" ? api.entity(node.entityId) : Promise.resolve(null)), [node.id]);
  return (
    <aside className="graph-panel">
      <button className="btn small ghost right" onClick={onClose} aria-label="닫기">
        ✕
      </button>
      {node.type === "memory" && entry.data && (
        <>
          <div className="small">
            <CategoryBadge category={entry.data.entry.category} /> {entry.data.entry.scope === "project" ? entry.data.project?.name : SCOPE_LABEL[entry.data.entry.scope]}
          </div>
          <h3>
            <a href={`#/e/${node.entryId}`}>{entry.data.entry.title}</a>
          </h3>
          {entry.data.entry.body && (
            <div className="small">
              <Markdown>{entry.data.entry.body.length > 600 ? `${entry.data.entry.body.slice(0, 600)}…` : entry.data.entry.body}</Markdown>
            </div>
          )}
          <EntityChips entities={entry.data.entities} />
          <LinkList links={entry.data.links} />
        </>
      )}
      {node.type === "entity" && entity.data && (
        <>
          <div className="small muted">엔티티 · {KIND_LABEL[entity.data.entity.kind] ?? entity.data.entity.kind}</div>
          <h3>
            <a href={`#/entity/${node.entityId}`}>{entity.data.entity.name}</a>
          </h3>
          {entity.data.entity.description && <p className="small">{entity.data.entity.description}</p>}
          <div className="small muted">메모리 {entity.data.memories.length}개</div>
          <ul className="plain-list small">
            {entity.data.memories.slice(0, 12).map((m) => (
              <li key={m.id}>
                <a href={`#/e/${m.id}`}>{m.title}</a> <span className="muted">{m.project_name ?? SCOPE_LABEL[m.scope]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="row">
        <button className="btn small" onClick={onFocus}>
          주변만 보기
        </button>
      </div>
    </aside>
  );
}

function BackfillBar({ unlinked, projectId, running, onStart }: { unlinked: number; projectId?: number; running?: { result: { done?: number[] } | null; payload: { entries: number[] } }; onStart: () => void }) {
  if (running)
    return (
      <div className="notice small">
        LLM이 기존 메모리에 그래프를 붙이는 중… {running.result?.done?.length ?? 0}/{running.payload.entries.length}
      </div>
    );
  if (!unlinked) return null;
  return (
    <div className="notice small">
      엔티티가 없는 메모리가 {unlinked}개 있습니다.{" "}
      <button className="btn small" onClick={() => act(() => api.backfill(projectId)).then(onStart)}>
        {projectId ? "이 프로젝트" : "전체"} 그래프 붙이기
      </button>
    </div>
  );
}

