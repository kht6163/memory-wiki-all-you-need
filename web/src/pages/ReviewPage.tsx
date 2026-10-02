import { useEffect, useRef, useState } from "react";
import { api, type Proposal } from "../api.ts";
import { CATEGORY_LABEL, CategoryBadge, Empty, ErrorBox, Markdown, SCOPE_LABEL, Time, act, go, useData } from "../lib.tsx";

const KIND: Record<Proposal["kind"], { label: string; action: string; cls: string }> = {
  merge: { label: "합치기", action: "합치기 적용", cls: "op-update" },
  update: { label: "고치기", action: "고치기 적용", cls: "op-update" },
  delete: { label: "삭제", action: "삭제 적용", cls: "op-delete" },
  conflict: { label: "모순", action: "해결함으로 표시", cls: "op-delete" },
};

/** Memory review: start an LLM review of a scope, then apply or dismiss its proposals one by one. */
export function ReviewPage({ projectId }: { projectId?: number }) {
  const projects = useData(() => api.projects(), []);
  const jobs = useData(() => api.reviewJobs(projectId), [projectId]);
  const proposals = useData(() => api.proposals(projectId), [projectId]);
  const stale = useData(() => api.staleEntries(projectId), [projectId]);
  const summary = useData(() => api.reviewScope(projectId), [projectId]);
  const [error, setError] = useState<string | null>(null);

  const scopeJobs = jobs.data ?? [];
  const running = scopeJobs.find((j) => j.status === "pending" || j.status === "processing");
  const failed = scopeJobs.find((j) => j.status === "error");
  const last = scopeJobs.find((j) => j.status === "done");

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      jobs.reload();
      proposals.reload();
    }, 4000);
    return () => clearInterval(t);
  }, [running?.id, jobs.reload, proposals.reload]);
  // One last reload once a run ends, so the final batch's proposals are not missed.
  const wasRunning = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (wasRunning.current && !running) {
      proposals.reload();
      stale.reload();
      summary.reload();
    }
    wasRunning.current = running?.id;
  }, [running?.id, proposals.reload, stale.reload, summary.reload]);

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    return act(fn).catch((e: Error) => setError(e.message)).finally(() => {
      proposals.reload();
      stale.reload();
    });
  };

  const scopeName = projectId ? projects.data?.find((p) => p.id === projectId)?.name ?? "프로젝트" : "전역·사용자";

  return (
    <article className="page">
      <header className="page-head">
        <h1>메모리 점검</h1>
        <p className="lead">
          LLM이 메모리를 엔티티별로 묶어 읽고 중복 합치기, 고치기, 삭제, 모순을 <b>제안</b>합니다. 적용하기 전에는 아무것도 바뀌지 않습니다. 제안 뒤 메모리가 바뀌었으면 적용하지 않고 "오래됨"으로 표시합니다.
        </p>
        <div className="toolbar">
          <select value={projectId ?? ""} onChange={(e) => go(e.target.value ? `/review?project=${e.target.value}` : "/review")}>
            <option value="">전역·사용자 메모리</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={Boolean(running)} onClick={() => run(() => api.startReview(projectId)).then(() => jobs.reload())}>
            {running ? `점검 중… ${running.result?.done?.length ?? 0}/${running.payload.entries.length}` : `${scopeName} 점검 시작`}
          </button>
          {last && (
            <span className="muted small">
              마지막 점검 <Time iso={last.processed_at ?? last.created_at} /> · 메모리 {last.payload.entries.length}개 · 제안 {last.result?.proposals ?? 0}개
            </span>
          )}
        </div>
        {failed && !running && (
          <div className="notice small">
            점검이 실패했습니다: {failed.error}{" "}
            <button className="btn small" onClick={() => run(() => api.retryReviewJob(failed.id)).then(() => jobs.reload())}>
              이어서 다시 실행
            </button>
          </div>
        )}
        {summary.data && summary.data.entries > summary.data.maxEntries && (
          <div className="notice small">
            메모리가 {summary.data.entries}개라 한 번에 최근 수정된 {summary.data.maxEntries}개만 점검합니다(REVIEW_MAX_ENTRIES).
          </div>
        )}
        {(summary.data?.unlinked ?? 0) > 0 && (
          <div className="notice small">
            이 범위에 엔티티가 없는 메모리가 {summary.data!.unlinked}개 있습니다. 점검은 같은 엔티티를 가진 메모리끼리 비교하므로, 먼저{" "}
            <a href={`#/graph${projectId ? `?project=${projectId}` : ""}`}>그래프 붙이기</a>를 하면 중복을 더 잘 찾습니다.
          </div>
        )}
      </header>
      <ErrorBox error={error ?? proposals.error} />

      <h2>제안 {proposals.data?.length ? `(${proposals.data.length})` : ""}</h2>
      {proposals.data?.length === 0 && <Empty>대기 중인 제안이 없습니다.</Empty>}
      {proposals.data?.map((p) => (
        <ProposalCard key={p.id} p={p} onApply={() => run(() => api.applyProposal(p.id))} onDismiss={() => run(() => api.dismissProposal(p.id))} />
      ))}

      <h2>오래 안 쓰인 메모리</h2>
      <p className="muted small">{summary.data?.staleDays ?? 60}일 넘게 회상·검색되지 않았고, 기본 주입 블록에도 들지 않았고, 고쳐지지도 않은 메모리입니다(고정 제외). 꼭 지울 대상은 아닙니다. 관례나 선호는 자주 안 쓰여도 유효할 수 있습니다.</p>
      {stale.data?.length === 0 && <Empty>없습니다.</Empty>}
      <ul className="plain-list">
        {stale.data?.map((e) => (
          <li key={e.id}>
            <CategoryBadge category={e.category} /> <a href={`#/e/${e.id}`}>{e.title}</a>{" "}
            <span className="muted small">
              마지막 사용 {e.last_used_at ? <Time iso={e.last_used_at} /> : "없음"} · 수정 <Time iso={e.updated_at} />
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function ProposalCard({ p, onApply, onDismiss }: { p: Proposal; onApply: () => void; onDismiss: () => void }) {
  const k = KIND[p.kind];
  const changed = p.entries.some((e) => !e || e.deleted_at || e.changed);
  return (
    <section className="proposal">
      <div className="row">
        <span className={`op ${k.cls}`}>{k.label}</span>
        <span className="small">{p.reason}</span>
        <span className="muted small right">#{p.id}</span>
      </div>
      <div className="proposal-cols">
        <div>
          <div className="preview-label">{p.kind === "merge" ? "합칠 메모리 (첫 번째를 남김)" : "대상 메모리"}</div>
          {p.entries.map((e, i) =>
            e ? (
              <div key={e.id} className={`proposal-entry${p.kind === "delete" || (p.kind === "merge" && i > 0) ? " gone" : ""}`}>
                <div className="small">
                  <CategoryBadge category={e.category} /> {e.scope === "project" ? "" : SCOPE_LABEL[e.scope]} <a href={`#/e/${e.id}`}>#{e.id}</a>
                  {e.pinned && " 📌"}
                  {e.changed && <span className="error-text"> · 제안 뒤 바뀜</span>}
                </div>
                <b>{e.title}</b>
                {e.body && <div className="small">{e.body}</div>}
              </div>
            ) : (
              <div key={i} className="proposal-entry gone muted small">
                #{p.entry_ids[i]} (삭제됨)
              </div>
            ),
          )}
        </div>
        {(p.kind === "merge" || p.kind === "update") && (
          <div>
            <div className="preview-label">제안</div>
            <div className="proposal-entry new">
              {p.data.category && <div className="small">{CATEGORY_LABEL[p.data.category] ?? p.data.category}</div>}
              <b>{p.data.title ?? p.entries[0]?.title}</b>
              {(p.data.body ?? p.entries[0]?.body) && (
                <div className="small">
                  <Markdown>{p.data.body ?? p.entries[0]?.body ?? ""}</Markdown>
                </div>
              )}
            </div>
          </div>
        )}
        {p.kind === "conflict" && p.data.note && (
          <div>
            <div className="preview-label">무엇이 모순인가</div>
            <p className="small">{p.data.note}</p>
          </div>
        )}
      </div>
      <div className="row">
        <button className="btn small primary" disabled={changed} title={changed ? "메모리가 바뀌어 적용할 수 없습니다" : undefined} onClick={onApply}>
          {k.action}
        </button>
        <button className="btn small" onClick={onDismiss}>
          무시
        </button>
      </div>
    </section>
  );
}
