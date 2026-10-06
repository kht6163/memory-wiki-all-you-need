import "./wiki.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { missingLinks } from "../wikilinks.ts";
import { api, type ComposeTurn, type Entry, type WikiLint, type WikiPage, type WikiRevision } from "../api.ts";
import {
  ACTION_LABEL,
  Diff,
  Empty,
  ErrorBox,
  JOB_STATUS_LABEL,
  MOD_LABEL,
  Markdown,
  SOURCE_LABEL,
  SourceBadge,
  StateBadge,
  Time,
  act,
  confirmDialog,
  go,
  isHistory,
  leaveTo,
  slugify,
  softDelete,
  errorText,
  toastError,
  useData,
  useLeaveGuard,
  usePoll,
} from "../lib.tsx";
import { Icon } from "../components/Icon.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SkeletonList, SkeletonPage } from "../components/Skeleton.tsx";
import { ChildPages, ParentSelect, TreeCrumbs, TreeSuggestCard, WikiTreeList, WikiTreeRail } from "./WikiTree.tsx";

/** Tabs shared by a project's (or the global) wiki, memory and turn views. */
export function ScopeTabs({ scope, active }: { scope: number; active: "wiki" | "memory" | "user" | "turns" | "jobs" | "graph" | "skills" }) {
  const tabs =
    scope === 0
      ? [
          ["wiki", "위키", "#/w/0"],
          ["memory", "전역 메모리", "#/global"],
          ["user", "사용자 프로필", "#/user"],
          ["skills", "스킬", "#/skills/0"],
          ["jobs", "위키 작업", "#/wiki-jobs?project=0"],
        ]
      : [
          ["wiki", "위키", `#/w/${scope}`],
          ["memory", "메모리", `#/p/${scope}`],
          ["graph", "그래프", `#/graph?project=${scope}`],
          ["turns", "턴 기록", `#/turns?project=${scope}`],
          ["skills", "스킬", `#/skills/${scope}`],
          ["jobs", "위키 작업", `#/wiki-jobs?project=${scope}`],
        ];
  return (
    <nav className="tabs">
      {tabs.map(([key, label, href]) => (
        <a key={key} href={href} className={active === key ? "active" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}

function useScopeName(scope: number) {
  const project = useData(() => (scope ? api.project(scope) : Promise.resolve(null)), [scope]);
  return { project: project.data, name: scope ? project.data?.name ?? "프로젝트" : "전역" };
}

/** Turn-record compose switch (ADR-0038); assumed on until the server answers, so nothing flickers in the usual case. */
function useComposeOn(): boolean {
  const settings = useData(() => api.settings(), []);
  return settings.data?.wikiCompose.enabled ?? true;
}

const ComposeOffNote = ({ children }: { children?: ReactNode }) => (
  <div className="callout info" role="note">
    <Icon name="info" size={16} />
    <span className="callout-text">
      턴 기록으로 위키 정리가 꺼져 있습니다.{children} <a href="#/settings">설정</a>
    </span>
  </div>
);

const pageHref = (scope: number, slug: string) => `#/w/${scope}/${encodeURIComponent(slug)}`;
const newPageHref = (scope: number, slug: string) => `#/w/${scope}/~new?slug=${encodeURIComponent(slug)}`;

// ------------------------------------------------------------- wiki home

const readHomeFilter = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("q") ?? "";

/** Keeps the page filter in the hash (`#/w/<scope>?q=…`) without firing hashchange (no scroll jump, no re-route per key). */
function writeHomeFilter(scope: number, q: string) {
  const next = `#/w/${scope}${q ? `?${new URLSearchParams({ q })}` : ""}`;
  if (window.location.hash !== next) history.replaceState(history.state, "", next);
}

export function WikiHome({ scope }: { scope: number }) {
  const { project, name } = useScopeName(scope);
  const pages = useData(() => api.wikiPages(scope || null), [scope]);
  const jobs = useData(() => api.wikiJobs(scope || null), [scope]);
  const [filter, setFilterState] = useState(readHomeFilter);
  const setFilter = (q: string) => {
    setFilterState(q);
    writeHomeFilter(scope, q);
  };
  useEffect(() => {
    // A link to this page with another ?q= (palette, back/forward) re-syncs the field.
    const on = () => setFilterState(readHomeFilter());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const composeOn = useComposeOn();
  const pending = jobs.data?.find((j) => j.kind === "compose" && (j.status === "pending" || j.status === "processing"));
  // A job waiting while compose is off does not move: no polling then.
  usePoll(jobs.reload, 4000, Boolean(pending) && (composeOn || pending?.status === "processing"));
  // When a compose job finishes, the page list changes: refetch once it disappears.
  const hadPending = useRef(false);
  useEffect(() => {
    if (hadPending.current && !pending) pages.reload();
    hadPending.current = Boolean(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id]);

  const overview = pages.data?.find((p) => p.slug === "overview");
  const others = useMemo(() => pages.data?.filter((p) => p.slug !== "overview") ?? [], [pages.data]);
  const q = filter.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? others.filter((p) => p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q) || p.body.toLowerCase().includes(q)).length : others.length),
    [others, q],
  );
  // Suggestions are refetched whenever a page changes (moves included).
  const pagesVersion = useMemo(() => (pages.data ?? []).map((p) => `${p.id}:${p.updated_at}`).join(","), [pages.data]);

  return (
    <article className="page">
      <PageHeader
        crumbs={scope ? <a href="#/projects">프로젝트</a> : <a href="#/">홈</a>}
        title={`${name} 위키`}
        busy={pages.loading && Boolean(pages.data)}
        actions={
          <>
            {composeOn && (
              <a className="btn" href={`#/w/${scope}/~compose`}>
                <Icon name="messages-square" />턴 기록으로 정리
              </a>
            )}
            <a className="btn primary" href={`#/w/${scope}/~new`}>
              <Icon name="plus" />새 페이지
            </a>
          </>
        }
        tabs={<ScopeTabs scope={scope} active="wiki" />}
        toolbar={
          pending && (
            <a className="wiki-job-banner" href={`#/wiki-jobs?project=${scope}`}>
              <span className="live-dot" aria-hidden />
              {pending.status === "processing" ? "LLM이 턴 기록을 정리하는 중…" : composeOn ? "정리 작업 대기 중" : "정리 작업 대기 중 (기능 꺼짐)"}
              <span className="faint">· 턴 {pending.payload.turns?.length ?? 0}개</span>
              <Icon name="arrow-right" size={14} />
            </a>
          )
        }
      >
        {project && <code className="key">{project.key}</code>}
      </PageHeader>
      <ErrorBox error={pages.error} />
      {pages.loading && !pages.data && <SkeletonList rows={4} />}
      {pages.data?.length === 0 && (
        <Empty
          icon="book-open"
          title="아직 위키 페이지가 없습니다"
          action={
            <a className="btn primary" href={`#/w/${scope}/~new`}>
              <Icon name="plus" />새 페이지
            </a>
          }
        >
          {composeOn ? (
            <>
              직접 새 페이지를 쓰거나, <b>턴 기록으로 정리</b>로 지난 작업 대화를 LLM이 문서로 옮기게 할 수 있습니다. pi에서는 <code>/wiki-compose</code>로 현재
              세션을 정리하거나, 에이전트에게 "위키에 정리해줘"라고 하면 됩니다.
            </>
          ) : (
            <>직접 새 페이지를 쓰거나, pi 에이전트에게 "위키에 정리해줘"라고 하면 됩니다.</>
          )}
        </Empty>
      )}
      {overview && (
        <section className="card wiki-overview-card">
          <div className="wiki-overview-head">
            <a className="wiki-overview-title" href={pageHref(scope, overview.slug)}>
              {overview.title}
            </a>
            <span className="wiki-meta">
              <SourceBadge source={overview.source} /> <Time iso={overview.updated_at} />
            </span>
          </div>
          <Markdown wikiScope={scope}>{stripTitle(overview.body, overview.title)}</Markdown>
        </section>
      )}
      {others.length > 1 && <TreeSuggestCard scope={scope} version={pagesVersion} onApplied={pages.reload} />}
      {pages.data && pages.data.length > 0 && <WikiLintPanel scope={scope} />}
      {others.length > 0 && (
        <>
          <div className="section-head">
            <h2>모든 페이지</h2>
            <span className="count">{q ? `${matches} / ${others.length}` : others.length}</span>
            <input
              className="filter"
              type="search"
              value={filter}
              placeholder="제목·slug·본문으로 거르기"
              aria-label="페이지 거르기"
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setFilter("")}
            />
          </div>
          {matches ? (
            <WikiTreeList scope={scope} pages={others} filter={filter} />
          ) : (
            <div className="list">
              <Empty
                icon="search"
                title="일치하는 페이지가 없습니다"
                action={
                  <button className="btn ghost" onClick={() => setFilter("")}>
                    필터 지우기
                  </button>
                }
              />
            </div>
          )}
        </>
      )}
    </article>
  );
}

// ------------------------------------------------------------- wiki lint

const CITE_STATE: Record<WikiLint["citations"][number]["state"], string> = { deleted: "삭제됨", purged: "영구 삭제됨", superseded: "대체됨", expired: "만료" };

/** Wiki health: orphan pages, links to missing pages, citations of history memories, empty pages. */
function WikiLintPanel({ scope }: { scope: number }) {
  const lint = useData(() => api.wikiLint(scope || null), [scope]);
  const [open, setOpen] = useState(false);
  const d = lint.data;
  if (!d) return null; // loading or failed: stay quiet, the page list matters more
  const c = d.counts;
  const total = c.orphans + c.missing + c.citations + c.empty;
  if (total === 0) {
    return (
      <div className="wiki-lint is-clean" role="status">
        <Icon name="check" size={14} />
        위키 점검 · 문제 없음
      </div>
    );
  }
  const parts: [number, string][] = [
    [c.orphans, "고아 페이지"],
    [c.missing, "없는 페이지 링크"],
    [c.citations, "낡은 메모리 인용"],
    [c.empty, "빈 페이지"],
  ];
  return (
    <section className={`wiki-lint${open ? " is-open" : ""}`}>
      <button className="wiki-lint-summary" aria-expanded={open} aria-controls="wiki-lint-details" onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
        <span className="wiki-lint-label">
          <Icon name="alert-triangle" size={14} />
          위키 점검
        </span>
        <span className="wiki-lint-counts">
          {parts
            .filter(([n]) => n > 0)
            .map(([n, label]) => (
              <span key={label}>
                {label} <b>{n}</b>
              </span>
            ))}
        </span>
      </button>
      {open && (
        <div id="wiki-lint-details" className="wiki-lint-details">
          {d.missing.length > 0 && (
            <LintGroup title="없는 페이지 링크" hint="다른 페이지가 링크했지만 아직 만들어지지 않은 페이지입니다.">
              {d.missing.map((m) => (
                <li key={m.slug}>
                  <a className="btn small" href={newPageHref(scope, m.slug)}>
                    <Icon name="plus" size={14} />
                    <span className="mono">{m.slug}</span> 만들기
                  </a>
                  <span className="wiki-lint-from">
                    링크한 곳:{" "}
                    {m.from.map((f, i) => (
                      <span key={f.id}>
                        {i > 0 && ", "}
                        <a href={pageHref(scope, f.slug)}>{f.title}</a>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </LintGroup>
          )}
          {d.citations.length > 0 && (
            <LintGroup title="낡은 메모리 인용" hint="삭제됐거나 대체·만료된 메모리를 인용합니다. 페이지를 고쳐 새 메모리를 가리키게 하세요.">
              {d.citations.map((ci) => (
                <li key={`${ci.page.id}-${ci.entry_id}`}>
                  <a href={pageHref(scope, ci.page.slug)}>{ci.page.title}</a>
                  <Icon name="arrow-right" size={12} />
                  {ci.state === "purged" ? (
                    <span className="mono faint">#{ci.entry_id}</span>
                  ) : (
                    <a className="mono" href={`#/e/${ci.entry_id}`}>
                      #{ci.entry_id}
                    </a>
                  )}
                  <span className={`badge cite-state cite-${ci.state}`}>
                    {CITE_STATE[ci.state]}
                    {ci.state === "superseded" && ci.superseded_by ? " →" : ""}
                  </span>
                  {ci.state === "superseded" && ci.superseded_by && (
                    <a className="mono" href={`#/e/${ci.superseded_by}`}>
                      #{ci.superseded_by}
                    </a>
                  )}
                </li>
              ))}
            </LintGroup>
          )}
          {d.orphans.length > 0 && (
            <LintGroup title="고아 페이지" hint="어떤 페이지도 링크하지 않습니다. 개요나 관련 페이지에서 [[slug]]로 이어 주세요.">
              {d.orphans.map((p) => (
                <li key={p.id}>
                  <a href={pageHref(scope, p.slug)}>{p.title}</a> <span className="mono faint">{p.slug}</span>
                </li>
              ))}
            </LintGroup>
          )}
          {d.empty.length > 0 && (
            <LintGroup title="빈 페이지" hint="본문이 거의 없습니다.">
              {d.empty.map((p) => (
                <li key={p.id}>
                  <a href={pageHref(scope, p.slug)}>{p.title}</a>
                  <a className="btn small ghost" href={`${pageHref(scope, p.slug)}/edit`}>
                    <Icon name="pencil" size={14} />
                    편집
                  </a>
                </li>
              ))}
            </LintGroup>
          )}
        </div>
      )}
    </section>
  );
}

function LintGroup({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="wiki-lint-group">
      <div className="wiki-lint-group-title">{title}</div>
      <div className="wiki-lint-hint">{hint}</div>
      <ul>{children}</ul>
    </div>
  );
}

/** Pages written before the "no title heading" rule may repeat the title as "# Title"; hide it. */
function stripTitle(body: string, title: string): string {
  const m = body.match(/^#\s+(.+)\n+/);
  return m && m[1].trim() === title.trim() ? body.slice(m[0].length) : body;
}


// ------------------------------------------------------------- page view

interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

/** Collects h2/h3 from the rendered body, gives them ids, and tracks the one in view. */
function useHeadings(ref: RefObject<HTMLDivElement | null>, key: string) {
  const [items, setItems] = useState<TocItem[]>([]);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return setItems([]);
    const els = [...root.querySelectorAll<HTMLHeadingElement>("h2, h3")];
    els.forEach((el, i) => (el.id = `wiki-h-${i}`));
    setItems(els.map((el) => ({ id: el.id, text: el.textContent ?? "", level: el.tagName === "H2" ? 2 : 3 })));
    if (!els.length || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "0px 0px -70% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ref, key]);
  return { items, active };
}

export function WikiPageView({ scope, slug }: { scope: number; slug: string }) {
  const { name } = useScopeName(scope);
  const bySlug = useData(() => api.wikiBySlug(scope || null, slug), [scope, slug]);
  const detail = useData(() => (bySlug.data ? api.wikiPage(bySlug.data.id) : Promise.resolve(null)), [bySlug.data?.id, bySlug.data?.updated_at]);
  const missing = useData(() => api.wikiMissing(scope || null), [scope, bySlug.data?.updated_at]);
  const missingSet = useMemo(() => new Set((missing.data ?? []).map((m) => m.to)), [missing.data]);
  // The wiki's pages, for the tree rail, breadcrumbs and child pages.
  const all = useData(() => api.wikiPages(scope || null), [scope, bySlug.data?.updated_at]);
  const pages = all.data ?? [];
  const bodyRef = useRef<HTMLDivElement>(null);
  const d = detail.data;
  const { items: toc, active } = useHeadings(bodyRef, d ? `${d.page.id}:${d.page.updated_at}` : "");

  if (bySlug.error) {
    return (
      <article className="page narrow">
        <PageHeader crumbs={<a href={`#/w/${scope}`}>{name} 위키</a>} title={<span className="mono">{slug}</span>} />
        <Empty
          icon="file-text"
          title="이 페이지는 아직 없습니다"
          action={
            <a className="btn primary" href={newPageHref(scope, slug)}>
              <Icon name="plus" />
              만들기
            </a>
          }
        />
      </article>
    );
  }
  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!d) return <SkeletonPage />;
  const p = d.page;

  return (
    <div className="with-toc with-tree">
      <WikiTreeRail scope={scope} pages={pages} current={p} className="tree-left" />
      <article className="page">
        <PageHeader
          crumbs={<TreeCrumbs scope={scope} name={name} pages={pages} current={p} />}
          title={p.title}
          busy={detail.loading}
          actions={
            !p.deleted_at && (
              <>
                <button className="btn" onClick={() => act(() => api.updateWikiPage(p.id, { locked: !p.locked }), { success: p.locked ? "잠금을 해제했습니다" : "잠갔습니다" })}>
                  <Icon name="lock" />
                  {p.locked ? "잠금 해제" : "잠금"}
                </button>
                <button
                  className="btn danger ghost"
                  onClick={async () => {
                    const ok = await softDelete({
                      title: p.title,
                      remove: () => api.deleteWikiPage(p.id),
                      restore: () => api.restoreWikiPage(p.id),
                      onUndo: () => go(`/w/${scope}/${encodeURIComponent(p.slug)}`),
                    });
                    if (ok) go(`/w/${scope}`);
                  }}
                >
                  <Icon name="trash-2" />
                  삭제
                </button>
                <a className="btn primary" href={`${pageHref(scope, p.slug)}/edit`} title="편집 (e)">
                  <Icon name="pencil" />
                  편집
                </a>
              </>
            )
          }
        >
          <div className="wiki-meta wiki-page-meta">
            {p.locked && (
              <span className="badge wiki-lock-badge" title="LLM과 에이전트가 이 페이지를 수정하지 않습니다">
                <Icon name="lock" size={12} />
                잠김
              </span>
            )}
            <span>마지막 작성</span> <SourceBadge source={p.source} /> <Time iso={p.updated_at} />
          </div>
          {p.deleted_at && (
            <div className="notice">
              삭제된 페이지입니다.{" "}
              <button className="btn small" onClick={() => act(() => api.restoreWikiPage(p.id), { success: "복원했습니다" })}>
                <Icon name="rotate-ccw" size={14} />
                복원
              </button>
            </div>
          )}
        </PageHeader>
        <div className="wiki-body" ref={bodyRef}>
          <Markdown wikiScope={scope} missing={missingSet}>
            {stripTitle(p.body, p.title) || "_빈 페이지_"}
          </Markdown>
        </div>
        <ChildPages scope={scope} pages={pages} current={p} />
        <h2>수정 이력</h2>
        <ol className="history">
          {d.revisions.map((r, i) => (
            <WikiRevisionItem key={r.id} rev={r} prev={d.revisions[i + 1]} pageId={p.id} isCurrent={i === 0} />
          ))}
        </ol>
      </article>
      <aside className="toc wiki-rail" aria-label="페이지 정보">
        <WikiTreeRail scope={scope} pages={pages} current={p} className="tree-in-rail" />
        {toc.length > 1 && (
          <nav className="wiki-rail-toc" aria-label="목차">
            <div className="toc-title">목차</div>
            {toc.map((h) => (
              <a
                key={h.id}
                href={`#/w/${scope}/${encodeURIComponent(p.slug)}`}
                className={`toc-l${h.level}${active === h.id ? " active" : ""}`}
                aria-current={active === h.id ? "location" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {h.text}
              </a>
            ))}
          </nav>
        )}
        <div className="wiki-rail-section">
          <div className="toc-title">
            이 페이지를 링크한 곳 <span className="count">{d.backlinks.length}</span>
          </div>
          {d.backlinks.length ? (
            d.backlinks.map((b) => (
              <a key={b.id} href={pageHref(scope, b.slug)}>
                {b.title}
              </a>
            ))
          ) : (
            <span className="faint small">없음</span>
          )}
        </div>
        <div className="wiki-rail-section">
          <div className="toc-title">
            참조한 메모리 <span className="count">{d.cites.length}</span>
          </div>
          {d.cites.length ? d.cites.map((e) => <CitedEntry key={e.id} e={e} />) : <span className="faint small">없음</span>}
        </div>
      </aside>
    </div>
  );
}

function CitedEntry({ e }: { e: Entry }) {
  const hist = isHistory(e);
  return (
    <div className={`wiki-cite${hist || e.deleted_at ? " is-history" : ""}`}>
      <a href={`#/e/${e.id}`} title={e.body}>
        <span className="cite-id">#{e.id}</span> <span className={e.deleted_at ? "strike" : undefined}>{e.title}</span>
      </a>
      {e.deleted_at ? <span className="badge state-badge">삭제됨</span> : <StateBadge e={e} />}
    </div>
  );
}

function WikiRevisionItem({ rev, prev, pageId, isCurrent }: { rev: WikiRevision; prev?: WikiRevision; pageId: number; isCurrent: boolean }) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen(!open);
  return (
    <li className="rev">
      <div
        className="rev-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className={`dot src-${rev.author}`} />
        <strong>{SOURCE_LABEL[rev.author]}</strong> {ACTION_LABEL[rev.action]}
        <span className="muted">
          {" "}
          · <Time iso={rev.created_at} />
        </span>
        {rev.job_id && (
          <a className="muted" href="#/wiki-jobs" onClick={(e) => e.stopPropagation()}>
            {" "}
            · 작업 #{rev.job_id}
          </a>
        )}
        {!isCurrent && rev.action !== "delete" && (
          <button
            className="btn small right"
            onClick={async (e) => {
              e.stopPropagation();
              const ok = await confirmDialog({ title: "이 버전으로 되돌릴까요?", body: <p>현재 내용은 수정 이력에 남습니다.</p>, confirmLabel: "되돌리기" });
              if (ok) act(() => api.revertWikiPage(pageId, rev.id), { success: "되돌렸습니다" });
            }}
          >
            <Icon name="rotate-ccw" size={14} />이 버전으로 되돌리기
          </button>
        )}
      </div>
      {rev.reason && <div className="rev-reason">{rev.reason}</div>}
      {open && <div className="rev-body">{prev ? <Diff a={`${prev.title}\n\n${prev.body}`} b={`${rev.title}\n\n${rev.body}`} /> : <pre className="diff">{rev.body}</pre>}</div>}
    </li>
  );
}

// -------------------------------------------------------------- editor

export function WikiEdit({ scope, slug, initialSlug }: { scope: number; slug?: string; initialSlug?: string }) {
  const { name } = useScopeName(scope);
  const existing = useData(() => (slug ? api.wikiBySlug(scope || null, slug) : Promise.resolve(null)), [scope, slug]);
  // Existing page slugs, so the preview draws links to pages that do not exist yet dotted (like the page view).
  const scopePages = useData(() => api.wikiPages(scope || null), [scope]);
  // "하위 페이지 만들기" opens ~new?parent=<id>.
  const parentParam = Number(new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("parent")) || null;
  const initial = { title: initialSlug ?? "", slug: initialSlug ?? "", body: "", locked: false, parent_id: parentParam as number | null };
  const [form, setForm] = useState(initial);
  const [base, setBase] = useState(() => JSON.stringify(initial));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    const p = existing.data;
    if (!p || loaded.current) return;
    loaded.current = true;
    const next = { title: p.title, slug: p.slug, body: p.body, locked: p.locked, parent_id: p.parent_id };
    setForm(next);
    setBase(JSON.stringify(next));
  }, [existing.data]);

  const dirty = JSON.stringify(form) !== base;
  const selfSlug = existing.data?.slug ?? slugify(form.slug || form.title || "page");
  const previewMissing = useMemo(
    () => (scopePages.data ? missingLinks(form.body, scope, scopePages.data.map((p) => p.slug), selfSlug) : undefined),
    [form.body, scope, scopePages.data, selfSlug],
  );
  const route = slug ? `/w/${scope}/${encodeURIComponent(slug)}/edit` : window.location.hash.replace(/^#/, "");
  useLeaveGuard(route, dirty);

  // Auto-grow the body textarea (fallback for browsers without field-sizing).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(420, el.scrollHeight + 2)}px`;
  }, [form.body, mode]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (saving || !form.title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const { title, body, locked, parent_id } = form;
      const p = existing.data
        ? await api.updateWikiPage(existing.data.id, { title, body, locked, parent_id })
        : await api.createWikiPage({ project_id: scope || null, slug: form.slug || title, title, body, locked, parent_id });
      await act(async () => p, { success: "저장했습니다" });
      leaveTo(`/w/${scope}/${encodeURIComponent(p.slug)}`);
    } catch (e) {
      setError(errorText(e));
      toastError(e, "저장하지 못했습니다");
    } finally {
      setSaving(false);
    }
  };

  // ⌘/Ctrl+S saves from any field.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || document.querySelector("dialog[open]")) return;
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  if (slug && !existing.data && !existing.error) return <SkeletonPage />;

  const cancel = () => {
    // The guard asks before discarding when dirty.
    if (existing.data) go(`/w/${scope}/${encodeURIComponent(existing.data.slug)}`);
    else history.back();
  };

  const modeToggle = (
    <div className="btn-group edit-mode-toggle" role="group" aria-label="보기 전환">
      <button type="button" className={`btn small${mode === "edit" ? " active" : ""}`} aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>
        편집
      </button>
      <button type="button" className={`btn small${mode === "preview" ? " active" : ""}`} aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>
        미리보기
      </button>
    </div>
  );

  return (
    <article className="page wide edit-page wiki-edit">
      <PageHeader
        crumbs={
          <>
            <a href={`#/w/${scope}`}>{name} 위키</a>
            {existing.data && (
              <>
                {" "}
                / <a href={pageHref(scope, existing.data.slug)}>{existing.data.title}</a>
              </>
            )}
          </>
        }
        title={existing.data ? "페이지 편집" : "새 페이지"}
      />
      <ErrorBox error={error ?? existing.error} />
      <div className="form">
        <div className="form-row">
          <label className="grow">
            제목
            <input className="title-input" value={form.title} onChange={(e) => set("title", e.target.value)} autoFocus={!slug} />
          </label>
          {!existing.data && (
            <label>
              slug (주소)
              <input value={form.slug} placeholder={slugify(form.title || "page")} onChange={(e) => set("slug", e.target.value)} />
            </label>
          )}
          {scopePages.data && (
            <ParentSelect pages={scopePages.data} self={existing.data} value={form.parent_id} onChange={(v) => set("parent_id", v)} />
          )}
          <label className="check">
            <input type="checkbox" checked={form.locked} onChange={(e) => set("locked", e.target.checked)} />
            잠금 (LLM·에이전트 수정 금지)
          </label>
        </div>
        <div className="edit-split" data-mode={mode}>
          <div className="edit-source-pane">
            <div className="edit-pane-head">
              <span className="field-label pane-label" id="wf-body">
                본문 (Markdown · <code>[[slug]]</code> 페이지 링크 · <code>[#id]</code> 메모리 참조)
              </span>
              {modeToggle}
            </div>
            <textarea ref={bodyRef} className="edit-body" aria-labelledby="wf-body" value={form.body} onChange={(e) => set("body", e.target.value)} autoFocus={Boolean(slug)} />
          </div>
          <div className="edit-preview-pane">
            <div className="edit-pane-head">
              <span className="field-label pane-label">미리보기</span>
              {mode === "preview" && modeToggle}
            </div>
            <div className="edit-preview" aria-live="off">
              {form.body ? <Markdown wikiScope={scope} missing={previewMissing}>{form.body}</Markdown> : <p className="hint">본문을 입력하면 여기에 표시됩니다.</p>}
            </div>
          </div>
        </div>
        <p className="hint">위키는 메모리와 별개입니다. 에이전트가 매번 알아야 할 규칙·사실이면 메모리에도 따로 추가하세요.</p>
      </div>
      <div className="edit-footer">
        <button className="btn primary" disabled={saving || !form.title.trim()} aria-busy={saving || undefined} onClick={save} title={`저장 (${MOD_LABEL}+S)`}>
          {saving ? "저장 중…" : "저장"} <kbd>{MOD_LABEL === "⌘" ? "⌘S" : "Ctrl+S"}</kbd>
        </button>
        <button className="btn ghost" onClick={cancel}>
          취소
        </button>
        <span className="spacer" />
        {dirty && <span className="dirty-note">저장 안 된 변경</span>}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- jobs

const JOB_KIND: Record<string, string> = { compose: "턴 기록 정리", write: "위키 작성 (v0.2)", sync: "메모리 반영 (v0.2)" };

export function WikiJobsPage({ scope }: { scope?: number }) {
  const { data, error, loading, reload } = useData(() => api.wikiJobs(scope === undefined ? undefined : scope || null), [scope]);
  const composeOn = useComposeOn();
  const waiting = Boolean(data?.some((j) => j.status === "pending"));
  const live = Boolean(data?.some((j) => j.status === "processing")) || (composeOn && waiting);
  usePoll(reload, 3000, live);
  return (
    <article className="page">
      <PageHeader
        title="위키 작업"
        lead="고른 턴 기록(대화와 작업 내용)을 LLM이 읽고 위키 페이지로 정리한 작업입니다. 요청할 때만 실행되며, 많으면 여러 묶음으로 나눠 차례로 처리합니다."
        busy={loading && Boolean(data) && !live}
        tabs={scope !== undefined && <ScopeTabs scope={scope} active="jobs" />}
      />
      <ErrorBox error={error} />
      {!composeOn && <ComposeOffNote>{waiting ? " 대기 중인 작업은 다시 켜면 이어서 실행됩니다." : ""}</ComposeOffNote>}
      {loading && !data && <SkeletonList />}
      {data?.length === 0 && (
        <Empty
          icon="file-cog"
          title="작업 기록이 없습니다"
          action={
            scope !== undefined && composeOn && (
              <a className="btn" href={`#/w/${scope}/~compose`}>
                턴 기록으로 정리
              </a>
            )
          }
        />
      )}
      {data && data.length > 0 && (
        <div className="list">
          {data.map((j) => {
            const notes = j.result?.notes ?? (j.result?.note ? [j.result.note] : []);
            const running = j.status === "pending" || j.status === "processing";
            const retryable = composeOn && j.kind === "compose" && (j.status === "error" || j.status === "cancelled");
            return (
              <div key={j.id} className="list-row wiki-job">
                <div className="wiki-job-head">
                  <span className={`status st-${j.status}`}>{JOB_STATUS_LABEL[j.status] ?? j.status}</span>
                  <b>{JOB_KIND[j.kind] ?? j.kind}</b>
                  <span className="faint">·</span>
                  <a href={`#/w/${j.project_id ?? 0}`}>{j.project_name ?? "전역"}</a>
                  {j.kind === "compose" && (
                    <span className="muted small">
                      턴 {j.result?.done?.length ?? 0}/{j.payload.turns?.length ?? 0}개{j.result?.chunks ? ` · ${j.result.chunks}묶음` : ""}
                    </span>
                  )}
                  <span className="wiki-job-actions">
                    {running && (
                      <button className="btn small ghost" onClick={() => act(() => api.cancelWikiJob(j.id), { success: "작업을 취소했습니다" })}>
                        <Icon name="x" size={14} />
                        취소
                      </button>
                    )}
                    {retryable && (
                      <button className="btn small" onClick={() => act(() => api.retryWikiJob(j.id), { success: "다시 실행을 요청했습니다" })}>
                        <Icon name="rotate-ccw" size={14} />
                        이어서 다시 실행
                      </button>
                    )}
                  </span>
                </div>
                <div className="wiki-meta">
                  <span className="mono">#{j.id}</span> ·{" "}
                  {j.status === "pending" ? (
                    <>
                      예정 <Time iso={j.run_after} />
                    </>
                  ) : j.processed_at ? (
                    <Time iso={j.processed_at} />
                  ) : (
                    <Time iso={j.created_at} />
                  )}
                  {j.result?.ms ? <> · {(j.result.ms / 1000).toFixed(1)}초</> : null}
                </div>
                {j.payload.instruction && <div className="small">요청: {j.payload.instruction}</div>}
                {notes.map((n, i) => (
                  <div key={i} className="small muted">
                    {n}
                  </div>
                ))}
                {j.result?.applied && j.result.applied.length > 0 && (
                  <div className="applied">
                    {j.result.applied.map((a, i) => {
                      const op = a.action ?? a.op ?? "";
                      const sign = op === "create" || op === "add" ? "+" : op === "delete" ? "−" : "~";
                      const href = a.pageId ? pageHref(j.project_id ?? 0, a.slug ?? "") : `#/e/${a.entryId}`;
                      return (
                        <a key={i} href={href} className={`op op-${op === "create" ? "add" : op}`}>
                          {sign} {a.title}
                        </a>
                      );
                    })}
                  </div>
                )}
                {j.error && <div className="error-text small">{j.error}</div>}
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

export function CitedBy({ pages }: { pages: { id: number; slug: string; title: string; project_id?: number | null }[] }) {
  if (!pages.length) return null;
  return (
    <>
      <h2>이 메모리를 참조한 위키 페이지</h2>
      <div className="list">
        {pages.map((p) => (
          <a key={p.id} className="list-row wiki-row" href={pageHref(p.project_id ?? 0, p.slug)}>
            <div className="wiki-row-head">
              <span className="wiki-row-title">{p.title}</span>
              <span className="wiki-row-slug mono">{p.slug}</span>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------- compose (turns → wiki)

/** Pick turn records and have the LLM organize them into this wiki's pages. */
export function WikiCompose({ scope }: { scope: number }) {
  const settings = useData(() => api.settings(), []);
  if (settings.data && !settings.data.wikiCompose.enabled)
    return (
      <article className="page">
        <PageHeader crumbs={<a href={`#/w/${scope}`}>위키</a>} title="턴 기록으로 위키 정리" />
        <ComposeOffNote> 켜면 고른 턴 기록을 LLM이 이 위키의 페이지로 정리합니다.</ComposeOffNote>
      </article>
    );
  return <WikiComposeForm scope={scope} />;
}

function WikiComposeForm({ scope }: { scope: number }) {
  const { name } = useScopeName(scope);
  const turns = useData(() => api.composeTurns(scope || null), [scope]);
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Default selection: everything not yet composed into this wiki.
  const sel = useMemo(() => selected ?? new Set((turns.data ?? []).filter((t) => !t.composed_at).map((t) => t.id)), [selected, turns.data]);
  const sessions = useMemo(() => {
    const m = new Map<string, ComposeTurn[]>();
    for (const t of turns.data ?? []) m.set(t.session_id, [...(m.get(t.session_id) ?? []), t]);
    return [...m.entries()];
  }, [turns.data]);
  // Default: sessions already fully composed start collapsed.
  const closed = useMemo(
    () => collapsed ?? new Set(sessions.filter(([, list]) => list.every((t) => t.composed_at)).map(([sid]) => sid)),
    [collapsed, sessions],
  );
  const chars = (turns.data ?? []).filter((t) => sel.has(t.id)).reduce((n, t) => n + t.chars, 0);
  const allIds = (turns.data ?? []).map((t) => t.id);

  const toggle = (ids: number[], on: boolean) => {
    const next = new Set(sel);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    setSelected(next);
  };
  const toggleOpen = (sid: string) => {
    const next = new Set(closed);
    next.has(sid) ? next.delete(sid) : next.add(sid);
    setCollapsed(next);
  };

  const submit = async () => {
    if (saving || !sel.size) return;
    setSaving(true);
    setError(null);
    try {
      await api.compose(scope || null, [...sel], instruction);
      go(`/wiki-jobs?project=${scope}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="page compose-page">
      <PageHeader
        crumbs={<a href={`#/w/${scope}`}>{name} 위키</a>}
        title="턴 기록으로 위키 정리"
        lead="고른 턴 기록(사용자 요청, 답변, 도구 실행 결과)을 LLM이 읽고 남길 만한 내용(구조, 결정과 이유, 절차, 문제 해결)을 이 위키의 페이지로 정리합니다. 기존 페이지는 필요한 부분만 고치고, 잠긴 페이지는 건드리지 않습니다."
      />
      <ErrorBox error={error ?? turns.error} />
      <div className="form">
        <label>
          정리 방향 (선택)
          <input
            value={instruction}
            placeholder="예: 배포 절차와 장애 대응 위주로"
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()}
          />
        </label>
      </div>
      {turns.loading && !turns.data && <SkeletonList />}
      {turns.data?.length === 0 && <Empty icon="messages-square" title="아직 기록된 턴이 없습니다" />}
      {sessions.length > 0 && (
        <div className="section-head">
          <h2>세션</h2>
          <span className="count">{sessions.length}</span>
          <span className="compose-bulk">
            <button className="btn small ghost" onClick={() => toggle(allIds, true)}>
              전체 선택
            </button>
            <button className="btn small ghost" onClick={() => setSelected(new Set())}>
              선택 해제
            </button>
          </span>
        </div>
      )}
      {sessions.map(([sid, list]) => {
        const ids = list.map((t) => t.id);
        const n = ids.filter((id) => sel.has(id)).length;
        const open = !closed.has(sid);
        const bodyId = `compose-s-${sid}`;
        return (
          <section key={sid} className="list compose-list">
            <div className="list-row compose-head">
              <input
                type="checkbox"
                aria-label={`세션 ${sid.slice(0, 8)} 전체 선택`}
                checked={n === ids.length}
                ref={(el) => {
                  if (el) el.indeterminate = n > 0 && n < ids.length;
                }}
                onChange={(e) => toggle(ids, e.target.checked)}
              />
              <button className="compose-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => toggleOpen(sid)}>
                <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
                <b className="mono">{sid.slice(0, 8)}</b>
                <span className="muted small">
                  턴 {list.length}개 · <Time iso={list[list.length - 1].created_at} />
                  {scope === 0 && list[0].project_name ? ` · ${list[0].project_name}` : ""}
                </span>
                <span className="compose-picked small">{n > 0 ? `${n}개 선택` : ""}</span>
              </button>
            </div>
            {open && (
              <div id={bodyId}>
                {list.map((t) => (
                  <label key={t.id} className={`list-row compose-row${t.composed_at ? " is-composed" : ""}`}>
                    <input type="checkbox" checked={sel.has(t.id)} onChange={(e) => toggle([t.id], e.target.checked)} />
                    <span className="compose-prompt">{t.prompt || <span className="faint">(내용 없음)</span>}</span>
                    <span className="wiki-meta nowrap">
                      <span className="mono">#{t.id}</span> · <Time iso={t.created_at} /> · 약 {t.chars.toLocaleString()}자
                      {t.composed_at && <span className="badge state-badge">정리됨</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>
        );
      })}
      {turns.data && turns.data.length > 0 && (
        <div className="compose-bar" role="region" aria-label="선택한 턴">
          <span className="compose-bar-count">
            <b>{sel.size}개</b> 선택 · 약 {chars.toLocaleString()}자
          </span>
          <span className="faint small compose-bar-hint">많으면 여러 묶음으로 나눠 처리합니다</span>
          <button className="btn primary" disabled={saving || !sel.size} aria-busy={saving || undefined} onClick={submit}>
            {saving ? "요청 중…" : "정리 요청"}
          </button>
        </div>
      )}
    </article>
  );
}
