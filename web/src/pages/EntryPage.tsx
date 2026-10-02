import { diffWordsWithSpace } from "diff";
import { useState } from "react";
import { api, type Revision } from "../api.ts";
import {
  ACTION_LABEL,
  CategoryBadge,
  ErrorBox,
  Markdown,
  SCOPE_LABEL,
  SOURCE_LABEL,
  SourceBadge,
  Tags,
  Time,
  act,
  go,
  scopeHref,
  useData,
} from "../lib.tsx";
import { EntryGraph } from "./GraphPages.tsx";
import { CitedBy } from "./WikiPages.tsx";

export function EntryPage({ id }: { id: number }) {
  const { data, error } = useData(() => api.entry(id), [id]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const { entry: e, project, revisions, citedBy, entities, links, usage } = data;
  const scopeName = e.scope === "project" ? project?.name ?? "프로젝트" : SCOPE_LABEL[e.scope];

  return (
    <article className="page narrow">
      <header className="page-head">
        <div className="crumbs">
          <a href={scopeHref(e)}>{scopeName}</a> / <CategoryBadge category={e.category} />
        </div>
        <h1>
          {e.pinned && <span title="고정됨">📌 </span>}
          {e.title}
        </h1>
        {e.deleted_at && (
          <div className="notice">
            이 메모리는 삭제되었습니다 (<Time iso={e.deleted_at} />).{" "}
            <button className="btn small" onClick={() => act(() => api.restoreEntry(e.id))}>
              복원
            </button>
          </div>
        )}
        <div className="toolbar">
          {!e.deleted_at && (
            <>
              <a className="btn primary" href={`#/e/${e.id}/edit`}>
                편집
              </a>
              <button className="btn" onClick={() => act(() => api.updateEntry(e.id, { pinned: !e.pinned }))}>
                {e.pinned ? "고정 해제" : "고정"}
              </button>
              <button
                className="btn danger ghost"
                onClick={() => {
                  if (confirm("삭제할까요? (휴지통에서 복원 가능)")) act(() => api.deleteEntry(e.id)).then(() => go(scopeHref(e).slice(1)));
                }}
              >
                삭제
              </button>
            </>
          )}
        </div>
      </header>

      <div className="entry-body">{e.body ? <Markdown>{e.body}</Markdown> : <p className="muted">본문 없음</p>}</div>

      <table className="meta-table">
        <tbody>
          <tr>
            <th>범위</th>
            <td>
              <a href={scopeHref(e)}>{scopeName}</a>
            </td>
          </tr>
          <tr>
            <th>마지막 작성</th>
            <td>
              <SourceBadge source={e.source} /> <Time iso={e.updated_at} />
            </td>
          </tr>
          <tr>
            <th>사용</th>
            <td>
              {usage.recalled + usage.searched === 0 ? (
                <span className="muted">아직 회상·검색된 적 없음</span>
              ) : (
                <>
                  회상 {usage.recalled}회 · 검색 {usage.searched}회 · 마지막 {usage.last_used_at ? <Time iso={usage.last_used_at} /> : "—"}
                </>
              )}
              {usage.shown_at && (
                <span className="muted">
                  {" "}
                  · 기본 블록 주입 <Time iso={usage.shown_at} />
                </span>
              )}
            </td>
          </tr>
          <tr>
            <th>처음 생성</th>
            <td>
              <Time iso={e.created_at} />
            </td>
          </tr>
          {e.tags.length > 0 && (
            <tr>
              <th>태그</th>
              <td>
                <Tags tags={e.tags} />
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <EntryGraph entryId={e.id} projectId={e.project_id} entities={entities} links={links} editable={!e.deleted_at && e.category !== "standing"} />

      <CitedBy pages={citedBy} />

      <h2>수정 이력</h2>
      <ol className="history">
        {revisions.map((r, i) => (
          <RevisionItem key={r.id} rev={r} prev={revisions[i + 1]} entryId={e.id} isCurrent={i === 0} />
        ))}
      </ol>
    </article>
  );
}

function RevisionItem({ rev, prev, entryId, isCurrent }: { rev: Revision; prev?: Revision; entryId: number; isCurrent: boolean }) {
  const [open, setOpen] = useState(isCurrent && rev.action === "update");
  const changedFields = prev
    ? [prev.title !== rev.title && "제목", prev.body !== rev.body && "본문", prev.category !== rev.category && "분류", prev.pinned !== rev.pinned && "고정", JSON.stringify(prev.tags) !== JSON.stringify(rev.tags) && "태그", prev.entities && rev.entities && JSON.stringify(prev.entities) !== JSON.stringify(rev.entities) && "엔티티"].filter(Boolean)
    : [];
  return (
    <li className={`rev rev-${rev.action}`}>
      <div className="rev-head" onClick={() => setOpen(!open)}>
        <span className={`dot src-${rev.author}`} />
        <strong>{SOURCE_LABEL[rev.author]}</strong> {ACTION_LABEL[rev.action]}
        {changedFields.length > 0 && <span className="muted"> · {changedFields.join(", ")}</span>}
        <span className="muted">
          {" "}
          · <Time iso={rev.created_at} />
        </span>
        {rev.turn_id && (
          <a className="muted" href={`#/turns/${rev.turn_id}`} onClick={(ev) => ev.stopPropagation()}>
            {" "}
            · 턴 #{rev.turn_id}
          </a>
        )}
        {!isCurrent && rev.action !== "delete" && (
          <button
            className="btn small right"
            onClick={(ev) => {
              ev.stopPropagation();
              if (confirm("이 버전으로 되돌릴까요?")) act(() => api.revertEntry(entryId, rev.id));
            }}
          >
            이 버전으로 되돌리기
          </button>
        )}
      </div>
      {rev.reason && <div className="rev-reason">{rev.reason}</div>}
      {open && (
        <div className="rev-body">
          {prev && prev.title !== rev.title && <Diff a={prev.title} b={rev.title} />}
          {prev ? prev.body !== rev.body ? <Diff a={prev.body} b={rev.body} /> : null : <Markdown>{rev.body || "_본문 없음_"}</Markdown>}
          {prev?.entities && rev.entities && JSON.stringify(prev.entities) !== JSON.stringify(rev.entities) && (
            <Diff a={`엔티티: ${prev.entities.join(", ")}`} b={`엔티티: ${rev.entities.join(", ")}`} />
          )}
        </div>
      )}
    </li>
  );
}

function Diff({ a, b }: { a: string; b: string }) {
  const parts = diffWordsWithSpace(a, b);
  return (
    <pre className="diff">
      {parts.map((p, i) => (
        <span key={i} className={p.added ? "ins" : p.removed ? "del" : undefined}>
          {p.value}
        </span>
      ))}
    </pre>
  );
}
