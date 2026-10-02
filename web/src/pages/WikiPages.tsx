import { diffWordsWithSpace } from "diff";
import { useEffect, useMemo, useState } from "react";
import { api, type ComposeTurn, type WikiJob, type WikiRevision } from "../api.ts";
import {
  ACTION_LABEL,
  Empty,
  ErrorBox,
  Markdown,
  SOURCE_LABEL,
  SourceBadge,
  Time,
  act,
  go,
  slugify,
  useData,
} from "../lib.tsx";

/** Tabs shared by a project's (or the global) wiki, memory and turn views. */
export function ScopeTabs({ scope, active }: { scope: number; active: "wiki" | "memory" | "user" | "turns" | "jobs" | "graph" }) {
  const tabs =
    scope === 0
      ? [
          ["wiki", "위키", "#/w/0"],
          ["memory", "전역 메모리", "#/global"],
          ["user", "사용자 프로필", "#/user"],
          ["jobs", "위키 작업", "#/wiki-jobs?project=0"],
        ]
      : [
          ["wiki", "위키", `#/w/${scope}`],
          ["memory", "메모리", `#/p/${scope}`],
          ["graph", "그래프", `#/graph?project=${scope}`],
          ["turns", "턴 기록", `#/turns?project=${scope}`],
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

// ------------------------------------------------------------- wiki home

export function WikiHome({ scope }: { scope: number }) {
  const { project, name } = useScopeName(scope);
  const pages = useData(() => api.wikiPages(scope || null), [scope]);
  const missing = useData(() => api.wikiMissing(scope || null), [scope]);
  const jobs = useData(() => api.wikiJobs(scope || null), [scope]);
  const pending = jobs.data?.find((j) => j.kind === "compose" && (j.status === "pending" || j.status === "processing"));
  const overview = pages.data?.find((p) => p.slug === "overview");
  const others = pages.data?.filter((p) => p.slug !== "overview") ?? [];

  return (
    <article className="page">
      <header className="page-head">
        <div className="crumbs">{scope ? <a href="#/projects">프로젝트</a> : <a href="#/">홈</a>}</div>
        <h1>{name} 위키</h1>
        {project && <code className="key">{project.key}</code>}
        <ScopeTabs scope={scope} active="wiki" />
        <div className="toolbar">
          <a className="btn primary" href={`#/w/${scope}/~new`}>
            + 새 페이지
          </a>
          <a className="btn" href={`#/w/${scope}/~compose`}>
            턴 기록으로 정리
          </a>
          {pending && (
            <a className="muted small" href={`#/wiki-jobs?project=${scope}`}>
              {pending.status === "processing" ? "LLM이 턴 기록을 정리하는 중…" : "정리 작업 대기 중"} · 턴 {pending.payload.turns?.length ?? 0}개
            </a>
          )}
        </div>
      </header>
      <ErrorBox error={pages.error} />
      {pages.data?.length === 0 && (
        <Empty>
          아직 위키 페이지가 없습니다. 직접 <b>새 페이지</b>를 쓰거나, <b>턴 기록으로 정리</b>로 지난 작업 대화를 LLM이 문서로 옮기게 할 수 있습니다.
          <br />
          pi에서는 <code>/wiki-compose</code>로 현재 세션을 정리하거나, 에이전트에게 "위키에 정리해줘"라고 하면 됩니다.
        </Empty>
      )}
      {overview && (
        <section className="wiki-overview">
          <div className="row">
            <h2 className="flush">
              <a href={`#/w/${scope}/${encodeURIComponent(overview.slug)}`}>{overview.title}</a>
            </h2>
            <span className="muted small right">
              <SourceBadge source={overview.source} /> <Time iso={overview.updated_at} />
            </span>
          </div>
          <Markdown wikiScope={scope}>{stripTitle(overview.body, overview.title)}</Markdown>
        </section>
      )}
      {others.length > 0 && (
        <>
          <h2>모든 페이지</h2>
          <div className="card-grid">
            {others.map((p) => (
              <a key={p.id} className="project-card" href={`#/w/${scope}/${encodeURIComponent(p.slug)}`}>
                <div className="project-name">
                  {p.locked && "🔒 "}
                  {p.title}
                </div>
                <div className="project-desc muted">{firstLine(p.body)}</div>
                <div className="muted small">
                  {p.slug} · {SOURCE_LABEL[p.source]} · <Time iso={p.updated_at} />
                </div>
              </a>
            ))}
          </div>
        </>
      )}
      {missing.data && missing.data.length > 0 && (
        <>
          <h2>아직 없는 페이지</h2>
          <p className="muted small">다른 페이지에서 링크했지만 아직 만들어지지 않은 페이지입니다.</p>
          <div className="row">
            {[...new Set(missing.data.map((m) => m.to))].map((slug) => (
              <a key={slug} className="btn small" href={`#/w/${scope}/~new?slug=${encodeURIComponent(slug)}`}>
                + {slug}
              </a>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

/** Pages written before the "no title heading" rule may repeat the title as "# Title"; hide it. */
function stripTitle(body: string, title: string): string {
  const m = body.match(/^#\s+(.+)\n+/);
  return m && m[1].trim() === title.trim() ? body.slice(m[0].length) : body;
}

function firstLine(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("```"));
  return (line ?? "").replace(/\s*\[#\d+\]/g, "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b ?? a).replace(/[*_`>]/g, "").slice(0, 140);
}

// ------------------------------------------------------------- page view

export function WikiPageView({ scope, slug }: { scope: number; slug: string }) {
  const { name } = useScopeName(scope);
  const bySlug = useData(() => api.wikiBySlug(scope || null, slug), [scope, slug]);
  const detail = useData(() => (bySlug.data ? api.wikiPage(bySlug.data.id) : Promise.resolve(null)), [bySlug.data?.id, bySlug.data?.updated_at]);

  if (bySlug.error) {
    return (
      <article className="page narrow">
        <div className="crumbs">
          <a href={`#/w/${scope}`}>{name} 위키</a>
        </div>
        <h1>{slug}</h1>
        <Empty>
          이 페이지는 아직 없습니다.{" "}
          <a className="btn small primary" href={`#/w/${scope}/~new?slug=${encodeURIComponent(slug)}`}>
            만들기
          </a>
        </Empty>
      </article>
    );
  }
  const d = detail.data;
  if (!d) return null;
  const p = d.page;

  return (
    <div className="with-toc">
      <article className="page">
        <header className="page-head">
          <div className="crumbs">
            <a href={`#/w/${scope}`}>{name} 위키</a> / <span>{p.slug}</span>
          </div>
          <h1>
            {p.locked && <span title="잠김 — LLM과 에이전트가 수정하지 않음">🔒 </span>}
            {p.title}
          </h1>
          <div className="muted small">
            마지막 작성 <SourceBadge source={p.source} /> <Time iso={p.updated_at} />
          </div>
          {p.deleted_at && (
            <div className="notice">
              삭제된 페이지입니다.{" "}
              <button className="btn small" onClick={() => act(() => api.restoreWikiPage(p.id))}>
                복원
              </button>
            </div>
          )}
          {!p.deleted_at && (
            <div className="toolbar">
              <a className="btn primary" href={`#/w/${scope}/${encodeURIComponent(p.slug)}/edit`}>
                편집
              </a>
              <button className="btn" onClick={() => act(() => api.updateWikiPage(p.id, { locked: !p.locked }))}>
                {p.locked ? "잠금 해제" : "잠금 (LLM·에이전트 수정 금지)"}
              </button>
              <button
                className="btn danger ghost"
                onClick={() => confirm(`"${p.title}" 페이지를 삭제할까요?`) && act(() => api.deleteWikiPage(p.id)).then(() => go(`/w/${scope}`))}
              >
                삭제
              </button>
            </div>
          )}
        </header>
        <div className="wiki-body">
          <Markdown wikiScope={scope}>{stripTitle(p.body, p.title) || "_빈 페이지_"}</Markdown>
        </div>
        <h2>수정 이력</h2>
        <ol className="history">
          {d.revisions.map((r, i) => (
            <WikiRevisionItem key={r.id} rev={r} prev={d.revisions[i + 1]} pageId={p.id} isCurrent={i === 0} />
          ))}
        </ol>
      </article>
      <aside className="toc wiki-side">
        <div className="toc-title">이 페이지를 링크한 곳</div>
        {d.backlinks.length ? (
          d.backlinks.map((b) => (
            <a key={b.id} href={`#/w/${scope}/${encodeURIComponent(b.slug)}`}>
              {b.title}
            </a>
          ))
        ) : (
          <span className="muted small">없음</span>
        )}
        <div className="toc-title spaced">참조한 메모리</div>
        {d.cites.length ? (
          d.cites.map((e) => (
            <a key={e.id} href={`#/e/${e.id}`} className={e.deleted_at ? "strike" : undefined} title={e.body}>
              <span className="cite-id">#{e.id}</span> {e.title}
            </a>
          ))
        ) : (
          <span className="muted small">없음</span>
        )}
      </aside>
    </div>
  );
}

function WikiRevisionItem({ rev, prev, pageId, isCurrent }: { rev: WikiRevision; prev?: WikiRevision; pageId: number; isCurrent: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rev">
      <div className="rev-head" onClick={() => setOpen(!open)}>
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
            onClick={(e) => {
              e.stopPropagation();
              if (confirm("이 버전으로 되돌릴까요?")) act(() => api.revertWikiPage(pageId, rev.id));
            }}
          >
            이 버전으로 되돌리기
          </button>
        )}
      </div>
      {rev.reason && <div className="rev-reason">{rev.reason}</div>}
      {open && (
        <div className="rev-body">
          {prev ? (
            <pre className="diff">
              {diffWordsWithSpace(`${prev.title}\n\n${prev.body}`, `${rev.title}\n\n${rev.body}`).map((part, i) => (
                <span key={i} className={part.added ? "ins" : part.removed ? "del" : undefined}>
                  {part.value}
                </span>
              ))}
            </pre>
          ) : (
            <pre className="diff">{rev.body}</pre>
          )}
        </div>
      )}
    </li>
  );
}

// -------------------------------------------------------------- editor

export function WikiEdit({ scope, slug, initialSlug }: { scope: number; slug?: string; initialSlug?: string }) {
  const { name } = useScopeName(scope);
  const existing = useData(() => (slug ? api.wikiBySlug(scope || null, slug) : Promise.resolve(null)), [scope, slug]);
  const [title, setTitle] = useState(initialSlug ?? "");
  const [pageSlug, setPageSlug] = useState(initialSlug ?? "");
  const [body, setBody] = useState("");
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const p = existing.data;
    if (p) {
      setTitle(p.title);
      setBody(p.body);
      setLocked(p.locked);
    }
  }, [existing.data]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const p = existing.data
        ? await api.updateWikiPage(existing.data.id, { title, body, locked })
        : await api.createWikiPage({ project_id: scope || null, slug: pageSlug || title, title, body, locked });
      await act(async () => p);
      go(`/w/${scope}/${encodeURIComponent(p.slug)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="page wide">
      <header className="page-head">
        <div className="crumbs">
          <a href={`#/w/${scope}`}>{name} 위키</a>
        </div>
        <h1>{existing.data ? "페이지 편집" : "새 페이지"}</h1>
      </header>
      <ErrorBox error={error} />
      <div className="form">
        <div className="form-row">
          <label className="grow">
            제목
            <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>
          {!existing.data && (
            <label>
              slug (주소)
              <input value={pageSlug} placeholder={slugify(title || "page")} onChange={(e) => setPageSlug(e.target.value)} />
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
            잠금 (LLM·에이전트 수정 금지)
          </label>
        </div>
        <div className="editor">
          <label>
            본문 (Markdown · <code>[[slug]]</code> 페이지 링크 · <code>[#id]</code> 메모리 참조)
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={26} />
          </label>
          <div className="preview">
            <div className="preview-label">미리보기</div>
            {body ? <Markdown wikiScope={scope}>{body}</Markdown> : <p className="muted">본문을 입력하면 여기에 표시됩니다.</p>}
          </div>
        </div>
        <p className="hint">위키는 메모리와 별개입니다. 에이전트가 매번 알아야 할 규칙·사실이면 메모리에도 따로 추가하세요.</p>
        <div className="row">
          <button className="btn primary" disabled={saving || !title.trim()} onClick={save}>
            {saving ? "저장 중…" : "저장"}
          </button>
          <button className="btn" onClick={() => history.back()}>
            취소
          </button>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- jobs

const JOB_STATUS: Record<WikiJob["status"], string> = { pending: "대기", processing: "진행 중", done: "완료", skipped: "건너뜀", error: "실패" };
const JOB_KIND: Record<WikiJob["kind"], string> = { compose: "턴 기록 정리", write: "위키 작성 (v0.2)", sync: "메모리 반영 (v0.2)" };

export function WikiJobsPage({ scope }: { scope?: number }) {
  const { data, error } = useData(() => api.wikiJobs(scope === undefined ? undefined : scope || null), [scope]);
  return (
    <article className="page">
      <header className="page-head">
        <h1>위키 작업</h1>
        <p className="lead">
          고른 턴 기록(대화와 작업 내용)을 LLM이 읽고 위키 페이지로 정리한 작업입니다. 요청할 때만 실행되며, 많으면 여러 묶음으로 나눠 차례로 처리합니다.
        </p>
        {scope !== undefined && <ScopeTabs scope={scope} active="jobs" />}
      </header>
      <ErrorBox error={error} />
      {data?.length === 0 && <Empty>작업 기록이 없습니다.</Empty>}
      <table className="turn-table">
        <tbody>
          {data?.map((j) => (
            <tr key={j.id} className="no-click">
              <td className="nowrap">
                <span className={`status st-${j.status}`}>{JOB_STATUS[j.status]}</span>
              </td>
              <td>
                <div>
                  <b>{JOB_KIND[j.kind]}</b> · <a href={`#/w/${j.project_id ?? 0}`}>{j.project_name ?? "전역"}</a>
                  {j.kind === "compose" && (
                    <span className="muted">
                      {" "}
                      · 턴 {j.result?.done?.length ?? 0}/{j.payload.turns?.length ?? 0}개{j.result?.chunks ? ` · ${j.result.chunks}묶음` : ""}
                    </span>
                  )}
                </div>
                <div className="muted small">
                  #{j.id} · {j.status === "pending" ? <>예정 <Time iso={j.run_after} /></> : j.processed_at ? <Time iso={j.processed_at} /> : <Time iso={j.created_at} />}
                  {j.result?.ms ? <> · {(j.result.ms / 1000).toFixed(1)}초</> : null}
                </div>
                {j.payload.instruction && <div className="small">요청: {j.payload.instruction}</div>}
                {(j.result?.notes ?? (j.result?.note ? [j.result.note] : [])).map((n, i) => (
                  <div key={i} className="small muted">
                    {n}
                  </div>
                ))}
                {j.result?.applied && j.result.applied.length > 0 && (
                  <div className="applied">
                    {j.result.applied.map((a, i) => {
                      const op = a.action ?? a.op ?? "";
                      const sign = op === "create" || op === "add" ? "+" : op === "delete" ? "−" : "~";
                      const href = a.pageId ? `#/w/${j.project_id ?? 0}/${encodeURIComponent(a.slug ?? "")}` : `#/e/${a.entryId}`;
                      return (
                        <a key={i} href={href} className={`op op-${op === "create" ? "add" : op}`}>
                          {sign} {a.title}
                        </a>
                      );
                    })}
                  </div>
                )}
                {j.error && <div className="error-text small">{j.error}</div>}
              </td>
              <td className="nowrap">
                {j.kind === "compose" && j.status === "error" && (
                  <button className="btn small" onClick={() => act(() => api.retryWikiJob(j.id))}>
                    다시 실행
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

export function CitedBy({ pages }: { pages: { id: number; slug: string; title: string; project_id?: number | null }[] }) {
  if (!pages.length) return null;
  return (
    <>
      <h2>이 메모리를 참조한 위키 페이지</h2>
      <ul className="plain-list">
        {pages.map((p) => (
          <li key={p.id}>
            <a href={`#/w/${p.project_id ?? 0}/${encodeURIComponent(p.slug)}`}>{p.title}</a> <span className="muted small">{p.slug}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

// ------------------------------------------------------- compose (turns → wiki)

/** Pick turn records and have the LLM organize them into this wiki's pages. */
export function WikiCompose({ scope }: { scope: number }) {
  const { name } = useScopeName(scope);
  const turns = useData(() => api.composeTurns(scope || null), [scope]);
  const [selected, setSelected] = useState<Set<number> | null>(null);
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
  const chars = (turns.data ?? []).filter((t) => sel.has(t.id)).reduce((n, t) => n + t.chars, 0);

  const toggle = (ids: number[], on: boolean) => {
    const next = new Set(sel);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    setSelected(next);
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.compose(scope || null, [...sel], instruction);
      go(`/wiki-jobs?project=${scope}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="page">
      <header className="page-head">
        <div className="crumbs">
          <a href={`#/w/${scope}`}>{name} 위키</a>
        </div>
        <h1>턴 기록으로 위키 정리</h1>
        <p className="lead">
          고른 턴 기록(사용자 요청, 답변, 도구 실행 결과)을 LLM이 읽고 남길 만한 내용(구조, 결정과 이유, 절차, 문제 해결)을 이 위키의 페이지로 정리합니다. 기존 페이지는 필요한 부분만 고치고, 잠긴 페이지는 건드리지 않습니다.
        </p>
      </header>
      <ErrorBox error={error ?? turns.error} />
      <div className="form">
        <label>
          정리 방향 (선택)
          <input value={instruction} placeholder="예: 배포 절차와 장애 대응 위주로" onChange={(e) => setInstruction(e.target.value)} />
        </label>
        <div className="row">
          <button className="btn primary" disabled={saving || !sel.size} onClick={submit}>
            {saving ? "요청 중…" : `턴 ${sel.size}개 정리하기`}
          </button>
          <span className="muted small">약 {chars.toLocaleString()}자 · 많으면 여러 묶음으로 나눠 처리합니다</span>
          <span className="right">
            <button className="btn small" onClick={() => toggle((turns.data ?? []).map((t) => t.id), true)}>
              전체 선택
            </button>{" "}
            <button className="btn small" onClick={() => setSelected(new Set())}>
              선택 해제
            </button>
          </span>
        </div>
      </div>
      {turns.data?.length === 0 && <Empty>아직 기록된 턴이 없습니다.</Empty>}
      {sessions.map(([sid, list]) => {
        const ids = list.map((t) => t.id);
        const all = ids.every((id) => sel.has(id));
        return (
          <section key={sid} className="compose-session">
            <label className="check compose-session-head">
              <input type="checkbox" checked={all} onChange={(e) => toggle(ids, e.target.checked)} />
              <b>세션 {sid.slice(0, 8)}</b>
              <span className="muted small">
                {" "}
                · 턴 {list.length}개 · <Time iso={list[list.length - 1].created_at} />
                {scope === 0 && list[0].project_name ? ` · ${list[0].project_name}` : ""}
              </span>
            </label>
            {list.map((t) => (
              <label key={t.id} className="check compose-turn">
                <input type="checkbox" checked={sel.has(t.id)} onChange={(e) => toggle([t.id], e.target.checked)} />
                <span className="grow">{t.prompt || <span className="muted">(내용 없음)</span>}</span>
                <span className="muted small nowrap">
                  #{t.id} · <Time iso={t.created_at} />
                  {t.composed_at && <> · 정리됨</>}
                </span>
              </label>
            ))}
          </section>
        );
      })}
    </article>
  );
}
