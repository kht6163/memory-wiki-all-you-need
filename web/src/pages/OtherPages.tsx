import { useState } from "react";
import { api, type ActivityItem, type TurnSummary } from "../api.ts";
import {
  ACTION_LABEL,
  CategoryBadge,
  Empty,
  ErrorBox,
  Markdown,
  SCOPE_LABEL,
  SOURCE_LABEL,
  Time,
  act,
  go,
  useData,
} from "../lib.tsx";
import { EntryCard } from "./ScopePage.tsx";

// ------------------------------------------------------------------ home

export function HomePage() {
  const stats = useData(() => api.stats(), []);
  const projects = useData(() => api.projects(), []);
  const activity = useData(() => api.activity(), []);
  const s = stats.data;
  return (
    <article className="page">
      <header className="page-head">
        <h1>Memory Wiki</h1>
        <p className="lead">pi가 일하면서 쌓은 기억(메모리)과 프로젝트 위키입니다. 메모리는 턴이 끝날 때마다 LLM이 정리해 매 요청에 주입하고, 위키는 사람과 에이전트가 쓰는 문서입니다. 턴 기록을 골라 LLM에게 위키로 정리하게 할 수도 있습니다.</p>
      </header>
      {s && (
        <div className="stat-grid">
          <a className="stat" href="#/w/0">
            <b>{s.pages}</b>위키 페이지
          </a>
          <a className="stat" href="#/projects">
            <b>{s.entries}</b>메모리
          </a>
          <a className="stat" href="#/projects">
            <b>{s.projects}</b>프로젝트
          </a>
          <a className="stat" href="#/turns">
            <b>{s.turns}</b>턴
          </a>
          <a className={`stat${s.pending ? " warn" : ""}`} href="#/turns?status=pending">
            <b>{s.pending}</b>정리 대기
          </a>
          {s.wikiPending > 0 && (
            <a className="stat warn" href="#/wiki-jobs">
              <b>{s.wikiPending}</b>위키 정리 대기
            </a>
          )}
          {s.errors > 0 && (
            <a className="stat bad" href="#/turns?status=error">
              <b>{s.errors}</b>정리 실패
            </a>
          )}
        </div>
      )}
      <div className="two-col">
        <section>
          <h2>최근 프로젝트</h2>
          {projects.data?.length === 0 && <Empty>pi에서 확장을 켜고 작업하면 프로젝트가 자동으로 생깁니다.</Empty>}
          <ul className="plain-list">
            {projects.data?.slice(0, 8).map((p) => (
              <li key={p.id}>
                <a href={`#/w/${p.id}`}>{p.name}</a> <span className="muted">· 메모리 {p.entry_count}개</span>
                <div className="muted small">{p.key}</div>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2>최근 변경</h2>
          <ActivityList items={activity.data?.slice(0, 12) ?? []} />
          <a href="#/activity">전체 보기 →</a>
        </section>
      </div>
    </article>
  );
}

// -------------------------------------------------------------- projects

export function ProjectsPage() {
  const { data, error } = useData(() => api.projects(), []);
  return (
    <article className="page">
      <header className="page-head">
        <h1>프로젝트</h1>
        <p className="lead">pi 확장이 git 저장소(원격 주소 기준)로 자동 구분합니다.</p>
      </header>
      <ErrorBox error={error} />
      {data?.length === 0 && <Empty>아직 프로젝트가 없습니다.</Empty>}
      <div className="card-grid">
        {data?.map((p) => (
          <a key={p.id} className="project-card" href={`#/w/${p.id}`}>
            <div className="project-name">{p.name}</div>
            <div className="muted small">{p.key}</div>
            {p.description && <div className="project-desc">{p.description.slice(0, 140)}</div>}
            <div className="muted small">
              메모리 {p.entry_count} · 턴 {p.turn_count}
              {p.last_seen_at && (
                <>
                  {" "}
                  · <Time iso={p.last_seen_at} />
                </>
              )}
            </div>
          </a>
        ))}
      </div>
    </article>
  );
}

// -------------------------------------------------------------- activity

export function ActivityList({ items }: { items: ActivityItem[] }) {
  if (!items.length) return <Empty>변경 기록이 없습니다.</Empty>;
  return (
    <ul className="activity">
      {items.map((a) => (
        <li key={a.id}>
          <span className={`dot src-${a.author}`} />
          <div>
            <div>
              <strong>{SOURCE_LABEL[a.author]}</strong> {ACTION_LABEL[a.action]}{" "}
              <a href={`#/e/${a.entry_id}`} className={a.action === "delete" ? "strike" : undefined}>
                {a.title}
              </a>
            </div>
            <div className="muted small">
              {a.entry_scope === "project" ? <a href={`#/p/${a.entry_project_id}`}>{a.project_name}</a> : SCOPE_LABEL[a.entry_scope]} ·{" "}
              <Time iso={a.created_at} />
              {a.turn_id && (
                <>
                  {" "}
                  · <a href={`#/turns/${a.turn_id}`}>턴 #{a.turn_id}</a>
                </>
              )}
              {a.reason && <> · {a.reason}</>}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ActivityPage() {
  const [before, setBefore] = useState<number | undefined>();
  const { data, error } = useData(() => api.activity(before), [before]);
  return (
    <article className="page narrow">
      <header className="page-head">
        <h1>활동</h1>
        <p className="lead">누가 어떤 메모리를 바꿨는지 — LLM 정리, 에이전트 도구, 사람의 편집 모두.</p>
      </header>
      <ErrorBox error={error} />
      <ActivityList items={data ?? []} />
      <div className="row">
        {before && (
          <button className="btn" onClick={() => setBefore(undefined)}>
            처음으로
          </button>
        )}
        {data && data.length >= 60 && (
          <button className="btn" onClick={() => setBefore(data[data.length - 1].id)}>
            더 보기
          </button>
        )}
      </div>
    </article>
  );
}

// ----------------------------------------------------------------- turns

const STATUS_LABEL: Record<TurnSummary["status"], string> = { pending: "대기", processing: "정리 중", done: "완료", skipped: "건너뜀", error: "실패" };

export function TurnsPage({ projectId, status }: { projectId?: number; status?: string }) {
  const [before, setBefore] = useState<number | undefined>();
  const { data, error } = useData(() => api.turns({ project_id: projectId, status, before }), [projectId, status, before]);
  const project = useData(() => (projectId ? api.project(projectId) : Promise.resolve(null)), [projectId]);
  return (
    <article className="page">
      <header className="page-head">
        {project.data && (
          <div className="crumbs">
            <a href={`#/p/${projectId}`}>{project.data.name}</a>
          </div>
        )}
        <h1>턴 기록</h1>
        <p className="lead">pi가 턴을 마칠 때마다 보낸 기록과, LLM이 그걸 보고 바꾼 메모리입니다.</p>
        <div className="toolbar">
          {(["", "pending", "done", "skipped", "error"] as const).map((s) => (
            <a key={s} className={`btn small${(status ?? "") === s ? " active" : ""}`} href={`#/turns?${projectId ? `project=${projectId}&` : ""}${s ? `status=${s}` : ""}`}>
              {s ? STATUS_LABEL[s] : "전체"}
            </a>
          ))}
        </div>
      </header>
      <ErrorBox error={error} />
      {data?.length === 0 && <Empty>기록이 없습니다.</Empty>}
      <table className="turn-table">
        <tbody>
          {data?.map((t) => (
            <tr key={t.id} onClick={() => go(`/turns/${t.id}`)}>
              <td className="nowrap">
                <span className={`status st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
              </td>
              <td>
                <div className="turn-prompt">{t.prompt || <span className="muted">(프롬프트 없음)</span>}</div>
                <div className="muted small">
                  #{t.id} · {t.project_name ?? "프로젝트 없음"} · <Time iso={t.created_at} />
                  {t.client && <> · {t.client}</>}
                </div>
                {t.applied.length > 0 && (
                  <div className="applied">
                    {t.applied.map((a, i) => (
                      <span key={i} className={`op op-${a.op}`}>
                        {a.op === "add" ? "+" : a.op === "update" ? "~" : "−"} {a.title}
                      </span>
                    ))}
                  </div>
                )}
                {t.error && <div className="error-text small">{t.error}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && data.length >= 50 && (
        <button className="btn" onClick={() => setBefore(data[data.length - 1].id)}>
          더 보기
        </button>
      )}
    </article>
  );
}

export function TurnPage({ id }: { id: number }) {
  const { data: t, error } = useData(() => api.turn(id), [id]);
  if (error) return <ErrorBox error={error} />;
  if (!t) return null;
  return (
    <article className="page narrow">
      <header className="page-head">
        <div className="crumbs">
          <a href="#/turns">턴 기록</a>
          {t.project && (
            <>
              {" "}
              / <a href={`#/p/${t.project.id}`}>{t.project.name}</a>
            </>
          )}
        </div>
        <h1>턴 #{t.id}</h1>
        <div className="muted">
          <span className={`status st-${t.status}`}>{STATUS_LABEL[t.status]}</span> · <Time iso={t.created_at} />
          {t.client && <> · {t.client}</>}
          {t.cwd && (
            <>
              {" "}
              · <code>{t.cwd}</code>
            </>
          )}
          {t.result?.ms && <> · 정리 {(t.result.ms / 1000).toFixed(1)}초</>}
        </div>
        <div className="toolbar">
          <button className="btn" disabled={t.status === "processing"} onClick={() => act(() => api.retryTurn(t.id))}>
            다시 정리
          </button>
          <button
            className="btn danger ghost"
            onClick={() => {
              if (confirm("이 턴 기록을 삭제할까요? (이미 반영된 메모리는 유지됩니다)")) act(() => api.deleteTurn(t.id)).then(() => go("/turns"));
            }}
          >
            기록 삭제
          </button>
        </div>
      </header>
      {t.error && <div className="error-box">{t.error}</div>}
      {t.result && (
        <section className="result-box">
          <h2>LLM 정리 결과</h2>
          {t.result.note && <p>{t.result.note}</p>}
          {t.result.applied.length === 0 ? (
            <p className="muted">바뀐 메모리 없음</p>
          ) : (
            <ul className="plain-list">
              {t.result.applied.map((a, i) => (
                <li key={i}>
                  <span className={`op op-${a.op}`}>{a.op === "add" ? "추가" : a.op === "update" ? "수정" : "삭제"}</span> <a href={`#/e/${a.entryId}`}>{a.title}</a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <h2>대화</h2>
      <div className="transcript">
        {t.payload.messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}${m.isError ? " msg-error" : ""}`}>
            <div className="msg-role">{m.role === "user" ? "사용자" : m.role === "assistant" ? "pi" : `도구 결과 · ${m.name}`}</div>
            {m.role === "tool" ? <pre>{m.text}</pre> : m.text && <Markdown>{m.text}</Markdown>}
            {m.toolCalls?.map((c, j) => (
              <div key={j} className="tool-call">
                <code>{c.name}</code> <span className="muted small">{c.args}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- search

export function SearchPage({ q }: { q: string }) {
  const entries = useData(() => (q ? api.search(q) : Promise.resolve([])), [q]);
  const sessions = useData(() => (q ? api.sessionSearch(q) : Promise.resolve([])), [q]);
  const wiki = useData(() => (q ? api.wikiSearch(q) : Promise.resolve([])), [q]);
  return (
    <article className="page">
      <header className="page-head">
        <h1>“{q}” 검색</h1>
      </header>
      <ErrorBox error={entries.error ?? sessions.error ?? wiki.error} />
      <section>
        <h2>
          위키 <span className="count">{wiki.data?.length ?? 0}</span>
        </h2>
        {wiki.data?.length === 0 && <Empty>일치하는 위키 페이지가 없습니다.</Empty>}
        <ul className="plain-list">
          {wiki.data?.map((h) => (
            <li key={h.id}>
              <a href={`#/w/${h.project_id ?? 0}/${encodeURIComponent(h.slug)}`}>{h.title}</a> <span className="muted small">{h.slug}</span>
              <div className="snippet">{h.snippet}</div>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>
          메모리 <span className="count">{entries.data?.length ?? 0}</span>
        </h2>
        {entries.data?.length === 0 && <Empty>일치하는 메모리가 없습니다.</Empty>}
        {entries.data?.map((e) => (
          <EntryCard key={e.id} entry={e} showScope />
        ))}
      </section>
      <section>
        <h2>
          지난 대화 <span className="count">{sessions.data?.length ?? 0}</span>
        </h2>
        {sessions.data?.length === 0 && <Empty>일치하는 대화가 없습니다.</Empty>}
        <ul className="plain-list">
          {sessions.data?.map((h) => (
            <li key={h.id}>
              <a href={`#/turns/${h.id}`}>턴 #{h.id}</a>{" "}
              <span className="muted small">
                {h.project_name ?? "프로젝트 없음"} · <Time iso={h.created_at} />
              </span>
              <div className="snippet">{h.snippet}</div>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}

// ----------------------------------------------------------------- trash

export function TrashPage() {
  const { data, error } = useData(() => api.entries({ deleted: true }), []);
  return (
    <article className="page narrow">
      <header className="page-head">
        <h1>휴지통</h1>
        <p className="lead">삭제된 메모리입니다. 복원하거나 영구 삭제할 수 있습니다.</p>
      </header>
      <ErrorBox error={error} />
      {data?.length === 0 && <Empty>휴지통이 비어 있습니다.</Empty>}
      <ul className="plain-list">
        {data?.map((e) => (
          <li key={e.id} className="trash-item">
            <div>
              <a href={`#/e/${e.id}`}>{e.title}</a> <CategoryBadge category={e.category} />
              <div className="muted small">
                {SCOPE_LABEL[e.scope]} · 삭제 <Time iso={e.deleted_at!} />
              </div>
            </div>
            <div className="row">
              <button className="btn small" onClick={() => act(() => api.restoreEntry(e.id))}>
                복원
              </button>
              <button className="btn small danger ghost" onClick={() => confirm("영구 삭제할까요? 되돌릴 수 없습니다.") && act(() => api.purgeEntry(e.id))}>
                영구 삭제
              </button>
            </div>
          </li>
        ))}
      </ul>
    </article>
  );
}

// --------------------------------------------------------------- preview

export function PreviewPage({ projectId }: { projectId?: number }) {
  const [prompt, setPrompt] = useState("");
  const [q, setQ] = useState("");
  const projects = useData(() => api.projects(), []);
  const { data, error } = useData(() => api.preview(projectId, q), [projectId, q]);
  return (
    <article className="page">
      <header className="page-head">
        <h1>주입 미리보기</h1>
        <p className="lead">pi가 매 요청마다 시스템 프롬프트와 숨은 메시지로 받는 내용입니다.</p>
        <div className="toolbar">
          <select value={projectId ?? ""} onChange={(e) => go(`/preview${e.target.value ? `?project=${e.target.value}` : ""}`)}>
            <option value="">프로젝트 없음</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input className="filter wide" placeholder="예시 프롬프트 (관련 기억 회상 확인)" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && setQ(prompt)} />
          <button className="btn" onClick={() => setQ(prompt)}>
            확인
          </button>
        </div>
      </header>
      <ErrorBox error={error} />
      {data && (
        <>
          <h2>
            시스템 프롬프트 블록 <span className="count">{data.system.length.toLocaleString()}자</span>
          </h2>
          <pre className="inject">{data.system}</pre>
          <h2>
            이번 요청 회상 <span className="count">{data.recall.length.toLocaleString()}자</span>
          </h2>
          {data.recall ? <pre className="inject">{data.recall}</pre> : <Empty>{q ? "추가로 회상된 기억이 없습니다." : "예시 프롬프트를 입력하면 회상 결과가 표시됩니다."}</Empty>}
        </>
      )}
    </article>
  );
}
