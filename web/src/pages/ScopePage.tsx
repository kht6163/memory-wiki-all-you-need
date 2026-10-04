import "./scope.css";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, type Entry, type Policy, type Project, type Scope, type Source } from "../api.ts";
import { act, CATEGORY_LABEL, CATEGORY_ORDER, CategoryBadge, changed, confirmDialog, Empty, ErrorBox, errorText, go, isHistory, Markdown, MOD_LABEL, softDelete, SOURCE_LABEL, SourceBadge, StateBadge, Tags, Time, toast, useData } from "../lib.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Icon } from "../components/Icon.tsx";
import { Menu } from "../components/Menu.tsx";
import { mergeCandidates, mergeSummary, PROJECT_REASON_HINT, PROJECT_REASON_LABEL, rankMergeCandidates, similarPartners } from "../project-merge.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { SkeletonList } from "../components/Skeleton.tsx";
import { ScopeTabs } from "./WikiPages.tsx";

interface Props {
  scope: Scope;
  projectId?: number;
  /** Only show standing instructions (global "고정 지시" page). */
  standingOnly?: boolean;
}

// ------------------------------------------------------------ hash-query filters

type Sort = "pinned" | "updated" | "title";
const SORT_LABEL: Record<Sort, string> = { pinned: "고정 먼저", updated: "최근 수정", title: "제목" };
const SOURCES: Source[] = ["human", "llm", "agent"];
const SOURCE_CHIP: Record<Source, string> = { human: "사람", llm: "LLM", agent: "에이전트" };

interface Filters {
  q: string;
  cats: string[];
  srcs: Source[];
  sort: Sort;
  history: boolean;
}

function hashParts(): [string, URLSearchParams] {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const i = raw.indexOf("?");
  return i < 0 ? [raw, new URLSearchParams()] : [raw.slice(0, i), new URLSearchParams(raw.slice(i + 1))];
}

function readFilters(): Filters {
  const [, p] = hashParts();
  const list = (k: string) => (p.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const sort = p.get("sort");
  return {
    q: p.get("q") ?? "",
    cats: list("cat"),
    srcs: list("src").filter((s): s is Source => (SOURCES as string[]).includes(s)),
    sort: sort === "updated" || sort === "title" ? sort : "pinned",
    history: p.get("history") === "1",
  };
}

/** Writes filters into the hash query without firing hashchange (no scroll jump, no history spam). Other params are kept. */
function writeFilters(f: Filters) {
  const [path, p] = hashParts();
  const put = (k: string, v: string | null) => (v ? p.set(k, v) : p.delete(k));
  put("q", f.q.trim() ? f.q : null);
  put("cat", f.cats.join(","));
  put("src", f.srcs.join(","));
  put("sort", f.sort === "pinned" ? null : f.sort);
  put("history", f.history ? "1" : null);
  const qs = p.toString();
  history.replaceState(history.state, "", `#${path}${qs ? `?${qs}` : ""}`);
}

function useHashFilters(): [Filters, (patch: Partial<Filters>) => void] {
  const [f, setF] = useState<Filters>(readFilters);
  useEffect(() => {
    // A link to this page with a different query (e.g. from the palette) re-syncs the state.
    const on = () => setF(readFilters());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const update = (patch: Partial<Filters>) =>
    setF((cur) => {
      const next = { ...cur, ...patch };
      writeFilters(next);
      return next;
    });
  return [f, update];
}

const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

function sortEntries(xs: Entry[], sort: Sort): Entry[] {
  if (sort === "pinned") return xs; // server order: pinned DESC, updated_at DESC
  const out = [...xs];
  if (sort === "updated") out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  else out.sort((a, b) => a.title.localeCompare(b.title, "ko"));
  return out;
}

// ------------------------------------------------------------------- page

export function ScopePage({ scope, projectId, standingOnly }: Props) {
  const entries = useData(() => api.entries({ scope, project_id: projectId }), [scope, projectId]);
  const project = useData(() => (projectId ? api.project(projectId) : Promise.resolve(null)), [projectId]);
  const [f, setF] = useHashFilters();
  const filterRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => (entries.data ?? []).filter((e) => !standingOnly || e.category === "standing"), [entries.data, standingOnly]);
  const historyCount = all.filter(isHistory).length;
  const visible = f.history ? all : all.filter((e) => !isHistory(e));

  const needle = f.q.trim().toLowerCase();
  const textMatch = (e: Entry) => !needle || `${e.title}\n${e.body}\n${e.tags.join(" ")}\n${(e.keywords ?? []).join(" ")}`.toLowerCase().includes(needle);
  const catMatch = (e: Entry) => standingOnly || !f.cats.length || f.cats.includes(e.category);
  const srcMatch = (e: Entry) => !f.srcs.length || f.srcs.includes(e.source);

  // Chip counts reflect what a click would produce: every other filter applied.
  const forCatCounts = visible.filter((e) => textMatch(e) && srcMatch(e));
  const forSrcCounts = visible.filter((e) => textMatch(e) && catMatch(e));
  const presentCats = CATEGORY_ORDER.filter((c) => visible.some((e) => e.category === c) || f.cats.includes(c));
  const extraCats = [...new Set(visible.map((e) => e.category))].filter((c) => !CATEGORY_ORDER.includes(c));
  const catChips = [...presentCats, ...extraCats];

  const list = sortEntries(
    visible.filter((e) => textMatch(e) && catMatch(e) && srcMatch(e)),
    f.sort,
  );
  const order = [...CATEGORY_ORDER, ...extraCats];
  const groups = order.map((c) => ({ category: c, items: list.filter((e) => e.category === c) })).filter((g) => g.items.length);
  const filtering = Boolean(needle || (!standingOnly && f.cats.length) || f.srcs.length);
  const clearFilters = () => setF({ q: "", cats: [], srcs: [] });

  const activeSection = useActiveSection(groups.map((g) => `cat-${g.category}`));

  const title = standingOnly ? "고정 지시" : scope === "global" ? "전역 메모리" : scope === "user" ? "사용자 프로필" : `${project.data?.name ?? "프로젝트"} 메모리`;
  const lead = standingOnly
    ? "모든 세션의 프롬프트에 항상 들어가는 사용자 지시입니다. LLM과 에이전트는 수정할 수 없습니다."
    : scope === "global"
      ? "모든 프로젝트에 공통으로 적용되는 기억입니다."
      : scope === "user"
        ? "사용자에 대한 기억 — 선호, 작업 방식, 교정 사항."
        : null;
  const newHref = `#/new?scope=${scope}${projectId ? `&project=${projectId}` : ""}${standingOnly ? "&category=standing" : ""}`;
  const showPolicy = !standingOnly && (scope === "global" || (scope === "project" && Boolean(projectId)));

  const onFilterKey = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Escape") {
      if (f.q) setF({ q: "" });
      else filterRef.current?.blur();
    }
  };

  const toolbar = (
    <div className="scope-toolbar">
      <div className="scope-toolbar-row">
        <input
          ref={filterRef}
          className="filter"
          type="search"
          placeholder="이 페이지에서 찾기…"
          aria-label="메모리 필터"
          value={f.q}
          onChange={(e) => setF({ q: e.target.value })}
          onKeyDown={onFilterKey}
        />
        <select aria-label="정렬" value={f.sort} onChange={(e) => setF({ sort: e.target.value as Sort })}>
          {(Object.keys(SORT_LABEL) as Sort[]).map((s) => (
            <option key={s} value={s}>
              {SORT_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="scope-toolbar-row" role="group" aria-label="필터">
        {!standingOnly &&
          catChips.map((c) => (
            <button key={c} type="button" className="chip" aria-pressed={f.cats.includes(c)} onClick={() => setF({ cats: toggle(f.cats, c) })}>
              <span className={`cat-dot cat-${c}`} aria-hidden />
              {CATEGORY_LABEL[c] ?? c}
              <span className="count">{forCatCounts.filter((e) => e.category === c).length}</span>
            </button>
          ))}
        {!standingOnly && catChips.length > 0 && <span className="chip-sep" aria-hidden />}
        {SOURCES.map((s) => (
          <button key={s} type="button" className="chip" aria-pressed={f.srcs.includes(s)} onClick={() => setF({ srcs: toggle(f.srcs, s) })} title={SOURCE_LABEL[s]}>
            <span className={`chip-dot src-${s}`} aria-hidden />
            {SOURCE_CHIP[s]}
            <span className="count">{forSrcCounts.filter((e) => e.source === s).length}</span>
          </button>
        ))}
        {historyCount > 0 && (
          <>
            <span className="chip-sep" aria-hidden />
            <button type="button" className="chip" aria-pressed={f.history} onClick={() => setF({ history: !f.history })} title="새 메모리로 대체됐거나 기한이 지나 프롬프트에 들어가지 않는 메모리">
              <Icon name="rotate-ccw" size={14} />
              {f.history ? `지난 사실 ${historyCount}개 숨기기` : `지난 사실 ${historyCount}개 보기`}
            </button>
          </>
        )}
        {filtering && (
          <button type="button" className="btn ghost small" onClick={clearFilters}>
            <Icon name="x" size={14} />
            필터 지우기
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="with-toc scope-page">
      <article className="page">
        <PageHeader
          crumbs={scope === "project" ? <a href="#/projects">프로젝트</a> : <a href="#/">홈</a>}
          title={title}
          lead={lead}
          busy={entries.loading && Boolean(entries.data)}
          actions={
            <>
              {scope === "project" && projectId && (
                <a className="btn" href={`#/preview?project=${projectId}`}>
                  <Icon name="eye" />
                  주입 미리보기
                </a>
              )}
              <a className="btn primary" href={newHref} title="새 메모리 (c)">
                <Icon name="plus" />새 메모리
              </a>
              {project.data && <ProjectMenu project={project.data} />}
            </>
          }
          tabs={!standingOnly && <ScopeTabs scope={projectId ?? 0} active={scope === "user" ? "user" : "memory"} />}
          toolbar={toolbar}
        >
          {project.data && <ProjectHeader key={project.data.id} project={project.data} onSaved={project.reload} />}
          {showPolicy && <PolicyCard projectId={scope === "project" ? (projectId ?? null) : null} />}
        </PageHeader>
        <ErrorBox error={entries.error ?? project.error} />
        {entries.loading && !entries.data && <SkeletonList />}
        {entries.data &&
          !groups.length &&
          (filtering ? (
            <Empty
              icon="search"
              title="일치하는 메모리가 없습니다"
              action={
                <button className="btn ghost" onClick={clearFilters}>
                  필터 지우기
                </button>
              }
            />
          ) : (
            <Empty
              icon="sticky-note"
              title={historyCount && !f.history ? "현재 유효한 메모리가 없습니다" : "아직 메모리가 없습니다"}
              action={
                <a className="btn primary" href={newHref}>
                  <Icon name="plus" />새 메모리
                </a>
              }
            >
              pi에서 작업하면 턴이 끝날 때마다 LLM이 정리해 추가합니다.
            </Empty>
          ))}
        {groups.map((g) => (
          <section key={g.category} id={`cat-${g.category}`} className="cat-section" aria-labelledby={`cat-${g.category}-h`}>
            <div className="section-head">
              <h2 id={`cat-${g.category}-h`}>
                <span className={`cat-dot-lg cat-${g.category}`} aria-hidden />
                {CATEGORY_LABEL[g.category] ?? g.category}
                <span className="count">{g.items.length}</span>
              </h2>
            </div>
            <div className="list">
              {g.items.map((e) => (
                <EntryCard key={e.id} entry={e} />
              ))}
            </div>
          </section>
        ))}
        {f.history && historyCount > 0 && groups.length > 0 && (
          <p className="history-note">흐리게 표시된 메모리는 대체됐거나 기한이 지난 이력입니다. 프롬프트에는 들어가지 않습니다.</p>
        )}
      </article>
      {groups.length > 1 && (
        <nav className="toc" aria-label="분류 목차">
          <div className="toc-title">목차</div>
          {groups.map((g) => (
            <a
              key={g.category}
              href={`#cat-${g.category}`}
              className={activeSection === `cat-${g.category}` ? "active" : undefined}
              aria-current={activeSection === `cat-${g.category}` ? "true" : undefined}
              onClick={(ev) => {
                ev.preventDefault();
                document.getElementById(`cat-${g.category}`)?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              {CATEGORY_LABEL[g.category] ?? g.category} <span className="count">{g.items.length}</span>
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}

/** Id of the section nearest the top of the viewport (TOC highlight). */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join("|");
  useEffect(() => {
    if (!ids.length || typeof IntersectionObserver === "undefined") return;
    const seen = new Map<string, boolean>();
    const obs = new IntersectionObserver(
      (records) => {
        for (const r of records) seen.set(r.target.id, r.isIntersecting);
        const first = ids.find((id) => seen.get(id));
        if (first) setActive(first);
      },
      { rootMargin: "-10% 0px -55% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return active;
}

// --------------------------------------------------------------- project header

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ kind: "ok", title: "복사됨", description: text });
  } catch {
    toast({ kind: "error", title: "복사하지 못했습니다", description: "브라우저가 클립보드 접근을 막았습니다." });
  }
}

function ProjectHeader({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(project.description);
  const [saving, setSaving] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const pencilRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!editing) return;
    const el = areaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  const start = () => {
    setDesc(project.description);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    requestAnimationFrame(() => pencilRef.current?.focus());
  };
  const save = async () => {
    if (saving) return;
    if (desc === project.description) return cancel();
    setSaving(true);
    const r = await act(() => api.updateProject(project.id, { description: desc }), { success: "설명을 저장했습니다" });
    setSaving(false);
    if (r !== undefined) {
      onSaved();
      cancel();
    }
  };

  return (
    <div className="project-meta">
      <div className="project-line">
        <button type="button" className="key-chip" onClick={() => copyText(project.key)} title="프로젝트 키 복사" aria-label={`프로젝트 키 ${project.key} 복사`}>
          <span>{project.key}</span>
          <Icon name="copy" size={13} />
        </button>
        {project.last_seen_at && (
          <span>
            마지막 사용 <Time iso={project.last_seen_at} />
          </span>
        )}
        {project.aliases && project.aliases.length > 0 && (
          <span className="project-aliases" title="합쳐진 프로젝트의 키 — 이 키로 들어오는 요청도 이 프로젝트로 연결됩니다">
            이전 주소: {project.aliases.join(", ")}
          </span>
        )}
      </div>
      {editing ? (
        <div className="desc-editor">
          <textarea
            ref={areaRef}
            rows={3}
            value={desc}
            aria-label="프로젝트 설명"
            placeholder="프로젝트 설명 (사람이 보는 용도, Markdown)"
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
          <div className="row">
            <button className="btn primary small" onClick={save} disabled={saving} aria-busy={saving}>
              저장 <kbd>{MOD_LABEL === "⌘" ? "⌘↵" : "Ctrl+↵"}</kbd>
            </button>
            <button className="btn ghost small" onClick={cancel}>
              취소 <kbd>Esc</kbd>
            </button>
          </div>
        </div>
      ) : (
        <div className="project-desc-row">
          {project.description ? (
            <Markdown>{project.description}</Markdown>
          ) : (
            <button type="button" className="btn ghost small" onClick={start}>
              <Icon name="plus" size={14} />
              설명 추가
            </button>
          )}
          {project.description && (
            <button ref={pencilRef} type="button" className="icon-btn" onClick={start} title="설명 편집" aria-label="설명 편집">
              <Icon name="pencil" size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** "더 보기" menu in the page actions (merge and delete live here, both behind type-to-confirm). */
function ProjectMenu({ project }: { project: Project }) {
  const [merging, setMerging] = useState(false);
  const remove = async () => {
    const ok = await confirmDialog({
      title: "프로젝트 삭제",
      body: <p>프로젝트 "{project.name}"와 모든 메모리·턴 기록·위키를 영구 삭제합니다. 되돌릴 수 없습니다.</p>,
      confirmLabel: "영구 삭제",
      danger: true,
      confirmText: project.name,
    });
    if (ok && (await act(() => api.deleteProject(project.id), { success: "프로젝트를 삭제했습니다" })) !== undefined) go("/projects");
  };

  return (
    <>
      <Menu
        label="더 보기"
        items={[
          { label: "프로젝트 키 복사", icon: "copy", run: () => copyText(project.key) },
          { label: "턴 기록", icon: "messages-square", href: `#/turns?project=${project.id}` },
          { label: "다른 프로젝트에 합치기…", icon: "git-merge", run: () => setMerging(true) },
          { label: "프로젝트 삭제…", icon: "trash-2", danger: true, run: remove },
        ]}
      />
      {merging && <ProjectMergeDialog source={project} onClose={() => setMerging(false)} />}
    </>
  );
}

// --------------------------------------------------------------- project merge

/**
 * Merge this project into another (G-007: a changed git origin splits one project in two).
 * Step 1 picks the target (palette-style list, ↑↓ / Enter); step 2 shows the server's preview and
 * asks for the source name before the irreversible POST (G-036).
 */
export function ProjectMergeDialog({ source, initialTarget, onClose }: { source: Project; initialTarget?: Project; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [target, setTarget] = useState<Project | null>(initialTarget ?? null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeRef = useRef<HTMLInputElement>(null);
  const projects = useData(() => api.projects(), []);
  // Suggested partners (api.similarProjects) float to the top; a failed fetch just leaves the plain order.
  const similar = useData(() => api.similarProjects(500).catch(() => []), []);
  const partners = useMemo(() => similarPartners(similar.data ?? [], source.id), [similar.data, source.id]);
  const items = rankMergeCandidates(mergeCandidates(projects.data ?? [], source.id, q), partners);
  const preview = useData(() => (target ? api.mergePreview(source.id, target.id) : Promise.resolve(null)), [source.id, target?.id]);
  // useData keeps the previous result while reloading: only show a preview of the chosen target.
  const pv = preview.data && target && preview.data.target.id === target.id ? preview.data : null;
  const summary = pv ? mergeSummary(pv) : null;
  const typedOk = typed.trim() === source.name;
  const canMerge = Boolean(pv) && !preview.error && typedOk && !busy;

  // Suggestions arrive after the plain list and reorder it: start again from the top.
  useEffect(() => setSel(0), [q, partners]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  useEffect(() => {
    // Steps swap the focused control; data-autofocus only runs when the dialog opens.
    if (target) typeRef.current?.focus();
    else searchRef.current?.focus();
  }, [target]);

  const choose = (p: Project) => {
    setTyped("");
    setTarget(p);
  };
  const back = () => {
    setTarget(null);
    setTyped("");
  };
  const merge = async () => {
    if (!target || !canMerge) return;
    setBusy(true);
    // quiet + changed() after leaving: a refetch on this page would ask for the deleted source project (404s).
    const r = await act(() => api.mergeProject(source.id, target.id), { success: "합쳤습니다", quiet: true });
    setBusy(false);
    if (r !== undefined) {
      onClose();
      go(`/p/${r.target.id}`);
      setTimeout(changed, 100);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!items.length) return;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setSel((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = items[Math.min(sel, items.length - 1)];
      if (p) choose(p);
    }
  };

  const listId = `pmerge-pick-${source.id}`;
  return (
    <Dialog
      open
      onClose={onClose}
      className="pmerge-dialog"
      title={target ? `"${source.name}"을(를) "${target.name}"에 합치기` : `"${source.name}"을(를) 어느 프로젝트에 합칠까요?`}
      footer={
        target ? (
          <>
            <button type="button" className="btn ghost" onClick={back} disabled={busy}>
              다른 프로젝트 고르기
            </button>
            <span className="pmerge-foot-gap" />
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              취소
            </button>
            <button type="button" className="btn solid-danger" onClick={merge} disabled={!canMerge} aria-busy={busy}>
              합치기
            </button>
          </>
        ) : undefined
      }
    >
      {!target ? (
        <>
          <p className="pmerge-hint">
            git origin이 바뀌어 같은 프로젝트가 둘로 나뉘었을 때 씁니다. 고른 프로젝트로 메모리·턴 기록·위키를 옮기고, "{source.name}"의 키는 그 프로젝트를 가리키게 됩니다.
          </p>
          <ErrorBox error={projects.error} />
          <div className="pmerge-box">
            <div className="palette-input">
              <Icon name="search" />
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKey}
                placeholder="합칠 대상 프로젝트 검색"
                aria-label="합칠 대상 프로젝트 검색"
                role="combobox"
                aria-expanded={items.length > 0}
                aria-controls={listId}
                aria-activedescendant={items.length ? `${listId}-${sel}` : undefined}
                autoComplete="off"
                spellCheck={false}
                data-autofocus=""
              />
              {projects.loading && <div className="palette-loading" />}
            </div>
            <div className="palette-list" id={listId} role="listbox" ref={listRef} aria-label="합칠 대상 프로젝트">
              {items.map((p, i) => (
                <div
                  key={p.id}
                  id={`${listId}-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === sel}
                  className="palette-item"
                  onMouseMove={() => setSel(i)}
                  onClick={() => choose(p)}
                >
                  <Icon name="folder" size={16} />
                  <span className="palette-label">{p.name}</span>
                  {partners.get(p.id)?.map((r) => (
                    <span key={r} className={`reason-chip reason-${r}`} title={PROJECT_REASON_HINT[r]}>
                      {PROJECT_REASON_LABEL[r]}
                    </span>
                  ))}
                  <span className="hint pmerge-key">{p.key}</span>
                </div>
              ))}
              {!projects.loading && projects.data && items.length === 0 && (
                <div className="palette-empty">{q.trim() ? "일치하는 프로젝트가 없습니다" : "합칠 수 있는 다른 프로젝트가 없습니다"}</div>
              )}
            </div>
            <div className="palette-foot">↑↓ 이동 · ↵ 고르기 · esc 닫기</div>
          </div>
        </>
      ) : (
        <div className="pmerge-preview" aria-busy={preview.loading}>
          <ErrorBox error={preview.error} />
          {preview.error && (
            <p className="pmerge-retry">
              <button type="button" className="btn" onClick={preview.reload} disabled={preview.loading}>
                {preview.loading ? "다시 불러오는 중…" : "다시 시도"}
              </button>
            </p>
          )}
          {!pv && !preview.error && <p className="hint">미리보기를 불러오는 중…</p>}
          {summary && pv && (
            <>
              <section aria-labelledby={`${listId}-moves`}>
                <h3 id={`${listId}-moves`}>옮겨지는 것</h3>
                {summary.moves.length ? (
                  <ul>
                    {summary.moves.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                ) : (
                  <p>옮길 메모리·턴 기록·위키가 없습니다.</p>
                )}
              </section>
              {summary.renames.length > 0 && (
                <section aria-labelledby={`${listId}-renames`}>
                  <h3 id={`${listId}-renames`}>이름이 바뀌는 위키 페이지</h3>
                  <p className="hint">"{pv.target.name}" 위키에 같은 주소의 페이지가 있어 "{pv.source.name}" 쪽 페이지의 주소를 바꿉니다.</p>
                  <ul className="pmerge-renames">
                    {summary.renames.map((r) => (
                      <li key={r.from}>
                        <code>{r.from}</code> → <code>{r.to}</code>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section aria-labelledby={`${listId}-keeps`}>
                <h3 id={`${listId}-keeps`}>"{pv.target.name}"에 남는 것</h3>
                <ul>
                  <li>{summary.policy}</li>
                  <li>{summary.description}</li>
                </ul>
              </section>
              {summary.aliases.length > 0 && (
                <section aria-labelledby={`${listId}-aliases`}>
                  <h3 id={`${listId}-aliases`}>"{pv.target.name}"로 연결되는 키</h3>
                  <p className="hint">합친 뒤 이 키로 들어오는 pi 요청도 "{pv.target.name}"의 메모리를 받습니다. 같은 키로 프로젝트가 다시 생기지 않습니다.</p>
                  <ul className="pmerge-aliases">
                    {summary.aliases.map((a) => (
                      <li key={a}>
                        <code>{a}</code>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <p className="pmerge-warn" role="note">
                <Icon name="alert-triangle" size={14} />
                <span>
                  되돌릴 수 없습니다. 합친 뒤 "{pv.source.name}" 프로젝트는 사라집니다. 필요하면 먼저 데이터를 백업하세요.
                </span>
              </p>
            </>
          )}
          <form
            className="dialog-confirm-text"
            onSubmit={(e) => {
              e.preventDefault();
              merge();
            }}
          >
            <label>
              <span>
                확인하려면 <b>{source.name}</b>을(를) 입력하세요
              </span>
              <input ref={typeRef} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
            </label>
          </form>
        </div>
      )}
    </Dialog>
  );
}

// --------------------------------------------------------------- policy card

function PolicyCard({ projectId }: { projectId: number | null }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .policy(projectId)
      .then((p) => alive && (setPolicy(p), setError(null)))
      .catch((e: unknown) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [projectId]);

  const start = () => {
    setText(policy?.text ?? "");
    setEditing(true);
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const r = await act(() => api.setPolicy(projectId, text), { success: "정리 방침을 저장했습니다" });
    setSaving(false);
    if (r) {
      setPolicy(r);
      setEditing(false);
    }
  };

  const set = Boolean(policy?.text.trim());
  const label = projectId ? "이 프로젝트의 정리 방침" : "전역 정리 방침";

  return (
    <details className="card policy-card">
      <summary>
        <Icon name="chevron-right" size={14} className="chev" />
        <Icon name="file-cog" size={14} />
        <strong>{label}</strong>
        <span className={set ? "badge" : "badge faint"}>{policy ? (set ? "설정됨" : "비어 있음") : "…"}</span>
        <span className="faint">{policy?.updated_at ? <>수정 <Time iso={policy.updated_at} /></> : policy ? "아직 설정되지 않음" : null}</span>
      </summary>
      <div className="policy-body">
        <p className="hint">서버 LLM이 메모리를 정리·점검·위키 정리할 때 따르는 규칙입니다. 사람만 쓸 수 있습니다.</p>
        <ErrorBox error={error} />
        {editing ? (
          <>
            <textarea
              value={text}
              rows={6}
              autoFocus
              aria-label={label}
              placeholder={"예: 일회성 디버깅 내용은 메모리로 남기지 않는다.\n예: 배포 절차는 위키에만 정리한다."}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  save();
                }
              }}
            />
            <div className="row">
              <button className="btn primary small" onClick={save} disabled={saving} aria-busy={saving}>
                저장 <kbd>{MOD_LABEL === "⌘" ? "⌘↵" : "Ctrl+↵"}</kbd>
              </button>
              <button className="btn ghost small" onClick={() => setEditing(false)}>
                취소
              </button>
            </div>
          </>
        ) : (
          <>
            {set ? <pre className="policy-preview">{policy?.text}</pre> : <p className="hint">아직 정한 규칙이 없습니다. 서버 기본 규칙만 적용됩니다.</p>}
            <div className="row">
              <button className="btn small" onClick={start} disabled={!policy}>
                <Icon name="pencil" size={14} />
                {set ? "방침 편집" : "방침 쓰기"}
              </button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}

// ------------------------------------------------------------------ entry row

export function EntryCard({ entry: e, showScope }: { entry: Entry; showScope?: boolean }) {
  const hist = isHistory(e);
  return (
    <div className={`list-row entry-row${e.pinned ? " pinned" : ""}${hist ? " is-history" : ""}`}>
      <div className="entry-row-head">
        <div className="entry-row-titlewrap">
          <a className="entry-row-title" href={`#/e/${e.id}`}>
            {e.pinned && (
              <span className="pin-icon" title="고정됨" role="img" aria-label="고정됨">
                <Icon name="pin" size={14} />
              </span>
            )}
            <span>{e.title}</span>
          </a>
          <StateBadge e={e} />
        </div>
        <div className="entry-row-actions">
          <a className="icon-btn" href={`#/e/${e.id}/edit`} title="편집" aria-label={`'${e.title}' 편집`}>
            <Icon name="pencil" size={15} />
          </a>
          <button
            type="button"
            className="icon-btn danger"
            title="삭제"
            aria-label={`'${e.title}' 삭제`}
            onClick={() => softDelete({ title: e.title, remove: () => api.deleteEntry(e.id), restore: () => api.restoreEntry(e.id) })}
          >
            <Icon name="trash-2" size={15} />
          </button>
        </div>
      </div>
      {e.body && (
        <div className="entry-row-body md-clamp">
          <Markdown>{e.body}</Markdown>
        </div>
      )}
      <div className="entry-row-meta">
        {showScope && <CategoryBadge category={e.category} />}
        <SourceBadge source={e.source} />
        <Tags tags={e.tags} />
        <Time iso={e.updated_at} />
      </div>
    </div>
  );
}
