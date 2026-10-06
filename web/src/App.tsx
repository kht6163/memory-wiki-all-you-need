import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { version } from "../package.json";
import { api, type Project, type Stats } from "./api.ts";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { Dialog } from "./components/Dialog.tsx";
import { Icon, type IconName } from "./components/Icon.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { Empty, MOD_LABEL, THEME_ICON, THEME_LABEL, go, isTypingTarget, readLocal, useData, useRoute, useTheme, writeLocal, type Theme } from "./lib.tsx";
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
import { DebugPage } from "./pages/DebugPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SkillEdit, SkillsList } from "./pages/SkillsPage.tsx";
import { EntitiesPage, EntityPage } from "./pages/GraphPages.tsx";

const GraphPage = lazy(() => import("./pages/GraphView.tsx").then((m) => ({ default: m.GraphPage })));
import { ReviewPage } from "./pages/ReviewPage.tsx";
import { ScopePage } from "./pages/ScopePage.tsx";
import { WikiCompose, WikiEdit, WikiHome, WikiJobsPage, WikiPageView } from "./pages/WikiPages.tsx";

const num = (s: string | null | undefined) => (s && /^\d+$/.test(s) ? Number(s) : undefined);

const PROJECTS_SHOWN = 8;
const PROJECTS_COLLAPSED_KEY = "sidebar:projects-collapsed";
/** g-chord targets (§4.4). */
const G_TARGETS: Record<string, string> = { h: "/", w: "/w/0", m: "/global", r: "/review", t: "/turns", a: "/activity" };

export function App() {
  const route = useRoute();
  const [p0, p1, p2] = route.path;
  const projects = useData(() => api.projects(), []);
  const stats = useData(() => api.stats(), []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => setMenuOpen(false), [route]);
  // Keep counters fresh while turns are being curated in the background.
  useEffect(() => {
    const t = setInterval(() => {
      stats.reload();
      projects.reload();
    }, 15000);
    return () => clearInterval(t);
  }, [stats.reload, projects.reload]);

  // Drawer: focus the first link on open; close when the viewport grows past the breakpoint.
  useEffect(() => {
    if (menuOpen) sidebarRef.current?.querySelector<HTMLElement>("a, button")?.focus();
  }, [menuOpen]);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 861px)");
    const on = () => mq.matches && setMenuOpen(false);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // Project of the current route (project memory / wiki pages, or ?project=).
  const routeProject = p0 === "p" || p0 === "w" || p0 === "skills" ? num(p1) || undefined : num(route.query.get("project")) || undefined;
  const newMemoryHref = routeProject
    ? `/new?scope=project&project=${routeProject}`
    : p0 === "user"
      ? "/new?scope=user"
      : p0 === "standing"
        ? "/new?scope=global&category=standing"
        : "/new?scope=global";
  const editHref =
    p0 === "e" && num(p1) && !p2 ? `/e/${p1}/edit` : p0 === "w" && p2 && !p2.startsWith("~") && !route.path[3] ? `/w/${p1}/${encodeURIComponent(p2)}/edit` : undefined;

  // Global shortcuts (§4.4). Single keys are ignored while typing or while a dialog is open.
  const latest = useRef({ menuOpen, newMemoryHref, editHref });
  latest.current = { menuOpen, newMemoryHref, editHref };
  const gAt = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cur = latest.current;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.key === "Escape" && cur.menuOpen) {
        setMenuOpen(false);
        menuBtn.current?.focus();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target) || document.querySelector("dialog[open]")) return;
      const k = e.key;
      if (gAt.current && Date.now() - gAt.current < 1000) {
        gAt.current = 0;
        const to = G_TARGETS[k];
        if (to !== undefined) {
          e.preventDefault();
          go(to);
        }
        return;
      }
      if (k === "/") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (k === "g") gAt.current = Date.now();
      else if (k === "c") go(cur.newMemoryHref);
      else if (k === "e" && cur.editHref) go(cur.editHref);
      else if (k === "?") setHelpOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    else if (p2 === "~new") page = <WikiEdit key={`new-${scope}-${route.query.get("slug") ?? ""}-${route.query.get("parent") ?? ""}`} scope={scope} initialSlug={route.query.get("slug") ?? undefined} />;
    else if (p3 === "edit") page = <WikiEdit key={`edit-${scope}-${p2}`} scope={scope} slug={p2} />;
    else page = <WikiPageView key={`${scope}-${p2}`} scope={scope} slug={p2} />;
  } else if (p0 === "wiki-jobs") page = <WikiJobsPage scope={route.query.has("project") ? num(route.query.get("project")) ?? 0 : undefined} />;
  else if (p0 === "graph")
    page = <GraphPage key={route.query.toString()} projectId={num(route.query.get("project"))} initialFocus={route.query.get("focus") ?? undefined} />;
  else if (p0 === "entities") page = <EntitiesPage />;
  else if (p0 === "review") page = <ReviewPage key={route.query.toString()} projectId={num(route.query.get("project"))} />;
  else if (p0 === "entity" && num(p1)) page = <EntityPage key={p1} id={num(p1)!} />;
  else if (p0 === "activity") page = <ActivityPage />;
  else if (p0 === "turns" && num(p1)) page = <TurnPage id={num(p1)!} />;
  else if (p0 === "turns") page = <TurnsPage projectId={num(route.query.get("project"))} status={route.query.get("status") ?? undefined} />;
  else if (p0 === "search") page = <SearchPage q={route.query.get("q") ?? ""} />;
  else if (p0 === "trash") page = <TrashPage />;
  else if (p0 === "preview") page = <PreviewPage projectId={num(route.query.get("project"))} />;
  else if (p0 === "debug") page = <DebugPage />;
  else if (p0 === "settings") page = <SettingsPage onChange={stats.reload} />;
  else if (p0 === "skills" && num(p1) !== undefined && (!p2 || p2 === "~new" || num(p2))) {
    const scope = num(p1)!;
    if (!p2) page = <SkillsList key={`skills-${scope}`} scope={scope} />;
    else if (p2 === "~new") page = <SkillEdit key={`skill-new-${scope}`} scope={scope} />;
    else if (num(p2)) page = <SkillEdit key={`skill-${p2}`} scope={scope} id={num(p2)} />;
  }
  else
    page = (
      <div className="page">
        <Empty
          icon="circle-alert"
          title="페이지를 찾을 수 없습니다"
          action={
            <a className="btn" href="#/">
              홈으로
            </a>
          }
        />
      </div>
    );

  const s = stats.data;

  return (
    <div className="layout">
      <header className="topbar">
        <button ref={menuBtn} className="icon-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="메뉴" aria-expanded={menuOpen} aria-controls="sidebar">
          <Icon name="menu" size={18} />
        </button>
        <a className="brand" href="#/">
          <img src="/favicon.svg" alt="" /> Memory Wiki
        </a>
        <button className="icon-btn" onClick={() => setPaletteOpen(true)} aria-label="검색">
          <Icon name="search" size={18} />
        </button>
      </header>
      {menuOpen && <button className="drawer-backdrop" aria-label="메뉴 닫기" tabIndex={-1} onClick={() => setMenuOpen(false)} />}
      <aside id="sidebar" ref={sidebarRef} className={`sidebar${menuOpen ? " open" : ""}`}>
        <a className="brand desktop" href="#/">
          <img src="/favicon.svg" alt="" /> Memory Wiki
        </a>
        <button className="nav-search" onClick={() => setPaletteOpen(true)} title={`검색 (${MOD_LABEL}K 또는 /)`}>
          <Icon name="search" />
          <span>검색…</span>
          <kbd>{MOD_LABEL === "⌘" ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <nav aria-label="주 메뉴">
          <NavItem href="#/" icon="home" label="홈" active={!p0} />

          <div className="nav-label">메모리</div>
          <NavItem href="#/standing" icon="pin" label="고정 지시" active={p0 === "standing"} />
          <NavItem href="#/user" icon="user" label="사용자 프로필" active={p0 === "user"} />
          <NavItem href="#/global" icon="globe" label="전역 메모리" active={p0 === "global"} />
          <NavItem href="#/graph" icon="share-2" label="그래프" active={p0 === "graph"}>
            {s && s.graphPending > 0 && (
              <span className="pill live" title="그래프 붙이기 대기">
                {s.graphPending}
              </span>
            )}
          </NavItem>
          <NavItem href="#/entities" icon="tag" label="엔티티" active={p0 === "entities" || p0 === "entity"}>
            {s && s.entities > 0 && <span className="count">{s.entities}</span>}
          </NavItem>

          <div className="nav-label">위키</div>
          <NavItem href="#/w/0" icon="book-open" label="전역 위키" active={p0 === "w" && p1 === "0"} />
          <NavItem href="#/skills/0" icon="lightbulb" label="전역 스킬" active={p0 === "skills" && p1 === "0"}>
            {s && s.skillsPending > 0 && (
              <span className="pill" title="에이전트가 만들거나 고친 스킬이 승인을 기다립니다(모든 범위)">
                승인 {s.skillsPending}
              </span>
            )}
            {s && s.globalSkills > 0 && <span className="count">{s.globalSkills}</span>}
          </NavItem>

          <ProjectsNav projects={projects.data} activeId={(p0 === "p" || p0 === "w" || p0 === "skills") && num(p1) ? num(p1) : undefined} projectsActive={p0 === "projects"} />

          <div className="nav-label">관리</div>
          <NavItem href="#/review" icon="check-check" label="메모리 점검" active={p0 === "review"}>
            {s && s.reviewRunning > 0 && (
              <span className="pill live" title="점검 중">
                점검 중
              </span>
            )}
            {s && s.reviewProposals > 0 && <span className="count">{s.reviewProposals}</span>}
          </NavItem>
          <NavItem href="#/activity" icon="activity" label="활동" active={p0 === "activity"} />
          <NavItem href="#/turns" icon="messages-square" label="턴 기록" active={p0 === "turns"}>
            {s && s.pending > 0 && (
              <span className="pill live" title="정리 대기">
                {s.pending}
              </span>
            )}
            {s && s.errors > 0 && (
              <span className="pill bad" title="정리 실패">
                {s.errors}
              </span>
            )}
          </NavItem>
          <NavItem href="#/wiki-jobs" icon="file-cog" label="위키 작업" active={p0 === "wiki-jobs"}>
            {s && s.wikiPending > 0 && (
              <span className="pill live" title="위키 정리 대기">
                {s.wikiPending}
              </span>
            )}
            {s && s.wikiErrors > 0 && (
              <span className="pill bad" title="위키 정리 실패">
                {s.wikiErrors}
              </span>
            )}
          </NavItem>
          <NavItem href="#/preview" icon="eye" label="주입 미리보기" active={p0 === "preview"} />
          <NavItem href="#/debug" icon="file-text" label="디버그 모드" active={p0 === "debug"} />
          <NavItem href="#/settings" icon="wrench" label="설정" active={p0 === "settings"} />
          <NavItem href="#/trash" icon="trash-2" label="휴지통" active={p0 === "trash"}>
            {s && s.trash > 0 && <span className="count">{s.trash}</span>}
          </NavItem>
        </nav>
        <SidebarFooter stats={s} />
      </aside>
      <main className="main" inert={menuOpen}>
        <Suspense fallback={null}>{page}</Suspense>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} projects={projects.data} projectId={routeProject} newMemoryHref={newMemoryHref} composeOn={s?.wikiCompose ?? true} />
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ToastProvider />
    </div>
  );
}

function NavItem({ href, icon, label, active, sub, title, children }: { href: string; icon?: IconName; label: string; active: boolean; sub?: boolean; title?: string; children?: ReactNode }) {
  return (
    <a className={`nav-item${sub ? " sub" : ""}`} href={href} aria-current={active ? "page" : undefined} title={title}>
      {icon && <Icon name={icon} />}
      <span className="nav-text">{label}</span>
      {children}
    </a>
  );
}

function ProjectsNav({ projects, activeId, projectsActive }: { projects: Project[] | undefined; activeId?: number; projectsActive: boolean }) {
  const [collapsed, setCollapsed] = useState(() => readLocal(PROJECTS_COLLAPSED_KEY) === "1");
  const toggle = () => {
    writeLocal(PROJECTS_COLLAPSED_KEY, collapsed ? null : "1");
    setCollapsed(!collapsed);
  };
  const sorted = [...(projects ?? [])].sort((a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? ""));
  const shown = sorted.slice(0, PROJECTS_SHOWN);
  // Keep the active project visible even when it is not among the most recent.
  const active = activeId ? sorted.find((p) => p.id === activeId) : undefined;
  if (active && !shown.includes(active)) shown.push(active);
  return (
    <>
      <button className="nav-label" onClick={toggle} aria-expanded={!collapsed}>
        프로젝트
        <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={12} />
      </button>
      {!collapsed && (
        <>
          {shown.map((p) => (
            <NavItem key={p.id} href={`#/w/${p.id}`} icon="folder" label={p.name} title={p.key} active={p.id === activeId}>
              <span className="count">{p.entry_count}</span>
            </NavItem>
          ))}
          <a className="nav-item more" href="#/projects" aria-current={projectsActive ? "page" : undefined}>
            <span className="nav-text">{sorted.length > PROJECTS_SHOWN ? `모두 보기 (${sorted.length})` : "모든 프로젝트"}</span>
          </a>
        </>
      )}
    </>
  );
}

function SidebarFooter({ stats: s }: { stats: Stats | undefined }) {
  const [theme, setTheme] = useTheme();
  const jobs = s ? s.pending + s.wikiPending + s.graphPending + s.reviewRunning + s.embedPending : 0;
  const failures = s ? s.errors + s.wikiErrors : 0;
  return (
    <div className="sidebar-foot">
      <div className="foot-line" title={
          s
            ? `정리 대기 ${s.pending} · 위키 ${s.wikiPending} · 그래프 ${s.graphPending} · 점검 ${s.reviewRunning}${s.embed ? ` · 임베딩 ${s.embedPending}${s.embedError ? " (임베딩 서버 오류)" : ""}` : ""}`
            : undefined
        }
      >
        <span className={`live-dot${jobs ? "" : " idle"}`} aria-hidden="true" />
        백그라운드 작업 <span className="tabular">{jobs}</span>
      </div>
      {s?.debug && (
        <a className="foot-line warn" href="#/debug" title="디버그 모드: 요청과 프롬프트를 날짜별 파일로 기록 중">
          <Icon name="file-text" size={14} />
          디버그 기록 중
        </a>
      )}
      {failures > 0 && s && (
        <a className="foot-line bad" href={s.errors > 0 ? "#/turns?status=error" : "#/wiki-jobs"}>
          <Icon name="alert-triangle" size={14} />
          실패 <span className="tabular">{failures}</span>
        </a>
      )}
      <div className="foot-row">
        <div className="btn-group theme-toggle" role="group" aria-label="테마">
          {(["system", "light", "dark"] as Theme[]).map((t) => (
            <button key={t} className="btn" aria-pressed={theme === t} aria-label={THEME_LABEL[t]} title={THEME_LABEL[t]} onClick={() => setTheme(t)}>
              <Icon name={THEME_ICON[t]} size={14} />
            </button>
          ))}
        </div>
        <span className="version">v{version}</span>
      </div>
    </div>
  );
}

const SHORTCUTS: [string[], string][] = [
  [[`${MOD_LABEL}`, "K"], "명령 팔레트 열기·닫기"],
  [["/"], "명령 팔레트 열기"],
  [["g", "h"], "홈"],
  [["g", "w"], "전역 위키"],
  [["g", "m"], "전역 메모리"],
  [["g", "r"], "메모리 점검"],
  [["g", "t"], "턴 기록"],
  [["g", "a"], "활동"],
  [["c"], "새 메모리 (현재 범위)"],
  [["e"], "현재 메모리·위키 페이지 편집"],
  [["?"], "단축키 도움말"],
  [["esc"], "닫기"],
];

function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="단축키" className="wide">
      <dl className="shortcut-list">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={label} style={{ display: "contents" }}>
            <dt>
              {keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
      <p className="hint" style={{ marginTop: 16 }}>
        입력란에 글을 쓰는 중에는 한 글자 단축키가 동작하지 않습니다.
      </p>
    </Dialog>
  );
}
