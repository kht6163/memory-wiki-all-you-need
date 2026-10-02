import { Suspense, lazy, useEffect, useState } from "react";
import { api } from "./api.ts";
import { go, useData, useRoute } from "./lib.tsx";
import { EditPage } from "./pages/EditPage.tsx";
import { EntryPage } from "./pages/EntryPage.tsx";
import {
  ActivityPage,
  HomePage,
  PreviewPage,
  ProjectsPage,
  SearchPage,
  TrashPage,
  TurnPage,
  TurnsPage,
} from "./pages/OtherPages.tsx";
import { EntitiesPage, EntityPage } from "./pages/GraphPages.tsx";

const GraphPage = lazy(() => import("./pages/GraphView.tsx").then((m) => ({ default: m.GraphPage })));
import { ScopePage } from "./pages/ScopePage.tsx";
import { WikiCompose, WikiEdit, WikiHome, WikiJobsPage, WikiPageView } from "./pages/WikiPages.tsx";

const num = (s: string | null | undefined) => (s && /^\d+$/.test(s) ? Number(s) : undefined);

export function App() {
  const route = useRoute();
  const [p0, p1, p2] = route.path;
  const projects = useData(() => api.projects(), []);
  const stats = useData(() => api.stats(), []);
  const [q, setQ] = useState(route.query.get("q") ?? "");
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [route]);
  // Keep counters fresh while turns are being curated in the background.
  useEffect(() => {
    const t = setInterval(() => {
      stats.reload();
      projects.reload();
    }, 15000);
    return () => clearInterval(t);
  }, [stats.reload, projects.reload]);

  let page;
  if (!p0) page = <HomePage />;
  else if (p0 === "global") page = <ScopePage scope="global" />;
  else if (p0 === "user") page = <ScopePage scope="user" />;
  else if (p0 === "standing") page = <ScopePage scope="global" standingOnly />;
  else if (p0 === "projects") page = <ProjectsPage />;
  else if (p0 === "p" && num(p1)) page = <ScopePage key={p1} scope="project" projectId={num(p1)} />;
  else if (p0 === "e" && num(p1) && p2 === "edit") page = <EditPage key={`edit-${p1}`} id={num(p1)} />;
  else if (p0 === "e" && num(p1)) page = <EntryPage id={num(p1)!} />;
  else if (p0 === "new")
    page = (
      <EditPage
        key={route.query.toString()}
        defaults={{
          scope: (route.query.get("scope") as "global" | "user" | "project") ?? "global",
          project: num(route.query.get("project")),
          category: route.query.get("category") ?? undefined,
        }}
      />
    );
  else if (p0 === "w" && p1 !== undefined && num(p1) !== undefined) {
    const scope = num(p1)!;
    const p3 = route.path[3];
    if (!p2) page = <WikiHome key={scope} scope={scope} />;
    else if (p2 === "~compose") page = <WikiCompose key={`compose-${scope}`} scope={scope} />;
    else if (p2 === "~new") page = <WikiEdit key={`new-${scope}-${route.query.get("slug") ?? ""}`} scope={scope} initialSlug={route.query.get("slug") ?? undefined} />;
    else if (p3 === "edit") page = <WikiEdit key={`edit-${scope}-${p2}`} scope={scope} slug={p2} />;
    else page = <WikiPageView key={`${scope}-${p2}`} scope={scope} slug={p2} />;
  } else if (p0 === "wiki-jobs") page = <WikiJobsPage scope={route.query.has("project") ? num(route.query.get("project")) ?? 0 : undefined} />;
  else if (p0 === "graph")
    page = <GraphPage key={route.query.toString()} projectId={num(route.query.get("project"))} initialFocus={route.query.get("focus") ?? undefined} />;
  else if (p0 === "entities") page = <EntitiesPage />;
  else if (p0 === "entity" && num(p1)) page = <EntityPage key={p1} id={num(p1)!} />;
  else if (p0 === "activity") page = <ActivityPage />;
  else if (p0 === "turns" && num(p1)) page = <TurnPage id={num(p1)!} />;
  else if (p0 === "turns") page = <TurnsPage projectId={num(route.query.get("project"))} status={route.query.get("status") ?? undefined} />;
  else if (p0 === "search") page = <SearchPage q={route.query.get("q") ?? ""} />;
  else if (p0 === "trash") page = <TrashPage />;
  else if (p0 === "preview") page = <PreviewPage projectId={num(route.query.get("project"))} />;
  else page = <div className="page">페이지를 찾을 수 없습니다.</div>;

  const active = (cond: boolean) => (cond ? "active" : undefined);
  const s = stats.data;

  return (
    <div className="layout">
      <header className="topbar">
        <button className="menu-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="메뉴">
          ☰
        </button>
        <a className="brand" href="#/">
          <img src="/favicon.svg" alt="" /> Memory Wiki
        </a>
      </header>
      <aside className={`sidebar${menuOpen ? " open" : ""}`}>
        <a className="brand desktop" href="#/">
          <img src="/favicon.svg" alt="" /> Memory Wiki
        </a>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) go(`/search?q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="메모리·대화 검색" />
        </form>
        <nav>
          <a className={active(!p0)} href="#/">
            홈
          </a>
          <a className={active(p0 === "w" && p1 === "0")} href="#/w/0">
            전역 위키
          </a>
          <a className={active(p0 === "standing")} href="#/standing">
            고정 지시
          </a>
          <a className={active(p0 === "user")} href="#/user">
            사용자 프로필
          </a>
          <a className={active(p0 === "global")} href="#/global">
            전역 메모리
          </a>
          <a className={active(p0 === "graph")} href="#/graph">
            그래프{s && s.graphPending > 0 && <span className="pill">{s.graphPending}</span>}
          </a>
          <a className={active(p0 === "entities" || p0 === "entity")} href="#/entities">
            엔티티{s && s.entities > 0 && <span className="count">{s.entities}</span>}
          </a>
          <div className="nav-group">
            <a className={`nav-group-title ${active(p0 === "projects") ?? ""}`} href="#/projects">
              프로젝트
            </a>
            {projects.data?.map((p) => (
              <a key={p.id} className={`sub ${active((p0 === "p" || p0 === "w") && num(p1) === p.id) ?? ""}`} href={`#/w/${p.id}`} title={p.key}>
                <span>{p.name}</span>
                <span className="count">{p.entry_count}</span>
              </a>
            ))}
          </div>
          <div className="nav-sep" />
          <a className={active(p0 === "activity")} href="#/activity">
            활동
          </a>
          <a className={active(p0 === "wiki-jobs")} href="#/wiki-jobs">
            위키 작업{s && s.wikiPending > 0 && <span className="pill">{s.wikiPending}</span>}
            {s && s.wikiErrors > 0 && <span className="pill bad">{s.wikiErrors}</span>}
          </a>
          <a className={active(p0 === "turns")} href="#/turns">
            턴 기록{s && s.pending > 0 && <span className="pill">{s.pending}</span>}
            {s && s.errors > 0 && <span className="pill bad">{s.errors}</span>}
          </a>
          <a className={active(p0 === "preview")} href="#/preview">
            주입 미리보기
          </a>
          <a className={active(p0 === "trash")} href="#/trash">
            휴지통{s && s.trash > 0 && <span className="count">{s.trash}</span>}
          </a>
        </nav>
      </aside>
      <main className="main">
        <Suspense fallback={null}>{page}</Suspense>
      </main>
    </div>
  );
}
