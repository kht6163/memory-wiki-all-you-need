import "./review.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Proposal, type ReviewJob } from "../api.ts";
import { editProblems, entityChange, proposalEdits, type EditProblem } from "../proposal.ts";
import {
  CATEGORY_LABEL,
  CategoryBadge,
  Diff,
  Empty,
  ErrorBox,
  JOB_STATUS_LABEL,
  SCOPE_LABEL,
  StateBadge,
  Time,
  act,
  go,
  isHistory,
  isTypingTarget,
  softDelete,
  useData,
  usePoll,
} from "../lib.tsx";
import { Icon } from "../components/Icon.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SkeletonList } from "../components/Skeleton.tsx";

const KIND: Record<Proposal["kind"], { label: string; action: string }> = {
  merge: { label: "합치기", action: "합치기 적용" },
  update: { label: "고치기", action: "고치기 적용" },
  delete: { label: "삭제", action: "삭제 적용" },
  conflict: { label: "모순", action: "해결함으로 표시" },
};

type PEntry = NonNullable<Proposal["entries"][number]>;

const isActive = (j: ReviewJob) => j.status === "pending" || j.status === "processing";

/** Why a proposal can't be applied (shown inline next to the disabled button), or null when it can. */
function blockedReason(p: Proposal): string | null {
  const missing = p.entries.findIndex((e) => !e || e.deleted_at);
  if (missing >= 0) return `메모리 #${p.entry_ids[missing]}이(가) 삭제되어 적용할 수 없습니다`;
  const changed = p.entries.find((e) => e?.changed);
  if (changed) return `제안 뒤 #${changed.id}이(가) 바뀌어 적용할 수 없습니다. 무시하고 다시 점검하세요`;
  return null;
}

/** Memory review: start an LLM review of a scope, then apply or dismiss its proposals one by one. */
export function ReviewPage({ projectId }: { projectId?: number }) {
  const projects = useData(() => api.projects(), []);
  const jobs = useData(() => api.reviewJobs(projectId), [projectId]);
  const proposals = useData(() => api.proposals(projectId), [projectId]);
  const stale = useData(() => api.staleEntries(projectId), [projectId]);
  const summary = useData(() => api.reviewScope(projectId), [projectId]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState<number | null>(null);

  const scopeJobs = jobs.data ?? [];
  const running = scopeJobs.find(isActive);
  const last = scopeJobs.find((j) => j.status === "done");
  const list = proposals.data ?? [];

  usePoll(
    () => {
      jobs.reload();
      proposals.reload();
    },
    4000,
    Boolean(running),
  );
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

  // Keep the keyboard selection inside the list as proposals are applied or dismissed.
  useEffect(() => {
    setSelected((s) => Math.max(0, Math.min(s, list.length - 1)));
  }, [list.length]);

  const startReview = () => act(() => api.startReview(projectId), { success: "점검을 시작했습니다" }).then(() => jobs.reload());

  const decide = async (p: Proposal, how: "apply" | "dismiss") => {
    if (busy !== null) return;
    if (how === "apply" && blockedReason(p)) return;
    setBusy(p.id);
    await act(() => (how === "apply" ? api.applyProposal(p.id) : api.dismissProposal(p.id)), {
      success: how === "apply" ? `제안 #${p.id}을(를) 적용했습니다` : `제안 #${p.id}을(를) 무시했습니다`,
    });
    setBusy(null);
  };

  // j / k move, a apply, d dismiss — read the latest state through a ref so the listener stays put.
  const keyState = useRef({ list, selected, decide });
  keyState.current = { list, selected, decide };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector("dialog[open]")) return;
      const { list, selected, decide } = keyState.current;
      if (!list.length) return;
      const move = (i: number) => {
        const next = Math.max(0, Math.min(list.length - 1, i));
        setSelected(next);
        const el = document.querySelector<HTMLElement>(`[data-proposal="${list[next].id}"]`);
        el?.scrollIntoView({ block: "nearest" });
        el?.focus({ preventScroll: true });
      };
      const p = list[selected];
      if (e.key === "j") move(selected + 1);
      else if (e.key === "k") move(selected - 1);
      else if (e.key === "a" && p) void decide(p, "apply");
      else if (e.key === "d" && p) void decide(p, "dismiss");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const scopeName = projectId ? projects.data?.find((p) => p.id === projectId)?.name ?? "프로젝트" : "전역·사용자";
  const total = running?.payload.entries.length ?? 0;
  const done = Math.min(running?.result?.done?.length ?? 0, total);

  return (
    <article className="page">
      <PageHeader
        title="메모리 점검"
        busy={proposals.loading && Boolean(proposals.data) && !running}
        lead={
          <>
            LLM이 메모리를 엔티티별로 묶어 읽고 중복 합치기, 고치기, 삭제, 모순을 <b>제안</b>합니다. 적용하기 전에는 아무것도 바뀌지 않습니다. 제안 뒤 메모리가 바뀌었으면 적용하지 않고 "오래됨"으로 표시합니다.
          </>
        }
        toolbar={
          <>
            <select
              aria-label="점검 범위"
              value={projectId ?? ""}
              onChange={(e) => go(e.target.value ? `/review?project=${e.target.value}` : "/review")}
            >
              <option value="">전역·사용자 메모리</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button className="btn primary" disabled={Boolean(running)} aria-busy={running ? true : undefined} onClick={startReview}>
              {running ? "점검 중…" : `${scopeName} 점검 시작`}
            </button>
            {last && (
              <span className="muted small">
                마지막 점검 <Time iso={last.processed_at ?? last.created_at} /> · 메모리 {last.payload.entries.length}개 · 제안 {last.result?.proposals ?? 0}개
              </span>
            )}
          </>
        }
      >
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
      </PageHeader>
      {running && (
        <div className="review-progress">
          <span className={`status st-${running.status}`}>{JOB_STATUS_LABEL[running.status]}</span>
          <div
            className="review-progress-track"
            role="progressbar"
            aria-label="점검 진행률"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
          >
            <div className="review-progress-fill" style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
          </div>
          <span>
            {done}/{total}
          </span>
        </div>
      )}
      <ErrorBox error={proposals.error} />

      <div className="section-head">
        <h2>제안</h2>
        {list.length > 0 && <span className="count">{list.length}</span>}
        {list.length > 0 && (
          <span className="key-hint">
            <kbd>j</kbd>
            <kbd>k</kbd> 이동 · <kbd>a</kbd> 적용 · <kbd>d</kbd> 무시
          </span>
        )}
      </div>
      {proposals.loading && !proposals.data && <SkeletonList rows={2} />}
      {proposals.data?.length === 0 && (
        <Empty
          icon="check-check"
          title="대기 중인 제안이 없습니다"
          action={
            !running && (
              <button className="btn" onClick={startReview}>
                점검 시작
              </button>
            )
          }
        />
      )}
      {list.map((p, i) => (
        <ProposalCard
          key={p.id}
          p={p}
          selected={i === selected}
          busy={busy === p.id}
          onSelect={() => setSelected(i)}
          onApply={() => decide(p, "apply")}
          onDismiss={() => decide(p, "dismiss")}
        />
      ))}

      {scopeJobs.length > 0 && (
        <>
          <div className="section-head">
            <h2>점검 기록</h2>
            <span className="count">{scopeJobs.length > 8 ? `최근 8개 / ${scopeJobs.length}` : scopeJobs.length}</span>
          </div>
          <div className="list">
            {scopeJobs.slice(0, 8).map((j) => (
              <JobRow key={j.id} j={j} reload={jobs.reload} />
            ))}
          </div>
        </>
      )}

      <div className="section-head">
        <h2>오래 안 쓰인 메모리</h2>
        {(stale.data?.length ?? 0) > 0 && <span className="count">{stale.data!.length}</span>}
      </div>
      <p className="section-desc">
        {summary.data?.staleDays ?? 60}일 넘게 회상·검색되지 않았고, 기본 주입 블록에도 들지 않았고, 고쳐지지도 않은 메모리입니다(고정 제외). 꼭 지울 대상은 아닙니다. 관례나 선호는 자주 안 쓰여도 유효할 수 있습니다.
      </p>
      {stale.loading && !stale.data && <SkeletonList rows={3} />}
      {stale.data && (
        <div className="list">
          {stale.data.length === 0 && <Empty icon="check-check" title="오래 안 쓰인 메모리가 없습니다" />}
          {stale.data.map((e) => (
            <div key={e.id} className={`list-row hoverable stale-row${isHistory(e) ? " is-history" : ""}`}>
              <div className="stale-main">
                <div className="stale-title">
                  <CategoryBadge category={e.category} />
                  <a href={`#/e/${e.id}`}>{e.title}</a>
                  <StateBadge e={e} />
                </div>
                <span className="job-meta">
                  #{e.id} · 마지막 사용 {e.last_used_at ? <Time iso={e.last_used_at} /> : "없음"} · 수정 <Time iso={e.updated_at} />
                </span>
              </div>
              <button
                className="icon-btn danger"
                aria-label={`'${e.title}' 휴지통으로 이동`}
                title="휴지통으로 이동"
                onClick={() =>
                  softDelete({
                    title: e.title,
                    remove: () => api.deleteEntry(e.id),
                    restore: () => api.restoreEntry(e.id),
                  })
                }
              >
                <Icon name="trash-2" />
              </button>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function JobRow({ j, reload }: { j: ReviewJob; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const total = j.payload.entries.length;
  const done = j.result?.done?.length ?? 0;
  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    await act(fn, { success });
    setBusy(false);
    reload();
  };
  return (
    <div className="list-row job-row">
      <span className={`status st-${j.status}`}>{JOB_STATUS_LABEL[j.status] ?? j.status}</span>
      {j.payload.scheduled && (
        <span className="badge faint" title="정해진 주기에 따라 서버가 자동으로 시작한 점검입니다">
          예약
        </span>
      )}
      <span className="job-meta">
        #{j.id} · <Time iso={j.created_at} /> · 메모리 {isActive(j) || j.status === "cancelled" || j.status === "error" ? `${done}/${total}` : total}개
        {j.result?.proposals !== undefined && ` · 제안 ${j.result.proposals}개`}
        {j.result?.ms !== undefined && j.status === "done" && ` · ${Math.round(j.result.ms / 1000)}초`}
      </span>
      <span className="right row">
        {isActive(j) && (
          <button className="btn small ghost" disabled={busy} onClick={() => run(() => api.cancelReviewJob(j.id), "점검을 취소했습니다")}>
            <Icon name="x" size={14} />
            취소
          </button>
        )}
        {(j.status === "error" || j.status === "cancelled") && (
          <button className="btn small" disabled={busy} onClick={() => run(() => api.retryReviewJob(j.id), "점검을 이어서 다시 실행합니다")}>
            <Icon name="rotate-ccw" size={14} />
            이어서 다시 실행
          </button>
        )}
      </span>
      {j.status === "error" && j.error && <div className="job-error">{j.error}</div>}
    </div>
  );
}

function EntryBox({ e, role, gone }: { e: PEntry; role?: "kept" | "gone"; gone?: boolean }) {
  return (
    <div className={`pentry${gone ? " is-gone" : ""}${isHistory(e) ? " is-history" : ""}`}>
      <div className="pentry-meta">
        {role === "kept" && <span className="badge role-kept">남김</span>}
        {role === "gone" && <span className="badge role-gone">합쳐짐</span>}
        <CategoryBadge category={e.category} />
        {e.scope !== "project" && <span>{SCOPE_LABEL[e.scope]}</span>}
        <a href={`#/e/${e.id}`}>#{e.id}</a>
        {e.pinned && (
          <span className="pentry-pin" title="고정됨" role="img" aria-label="고정됨">
            <Icon name="pin" size={12} />
          </span>
        )}
        <StateBadge e={e} />
        {e.changed && <span className="error-text">제안 뒤 바뀜</span>}
      </div>
      <div className="pentry-title">{e.title}</div>
      {e.body && <div className="pentry-body">{e.body}</div>}
    </div>
  );
}

const EDIT_PROBLEM: Record<EditProblem, string> = {
  missing: "바꿀 구절이 현재 본문에 없습니다. 적용하면 실패할 수 있습니다.",
  repeated: "바꿀 구절이 현재 본문에 여러 번 나옵니다. 적용하면 실패할 수 있습니다.",
  overlap: "다른 수정 구절과 겹칩니다. 적용하면 실패할 수 있습니다.",
};

function MissingBox({ id }: { id: number }) {
  return <div className="pentry is-missing">#{id} (삭제됨)</div>;
}

function Callout({ kind = "warn", children }: { kind?: "warn" | "danger"; children: ReactNode }) {
  return (
    <div className={`callout ${kind}`} role="note">
      <Icon name="alert-triangle" size={14} />
      <div className="callout-text">{children}</div>
    </div>
  );
}

function ProposalCard({
  p,
  selected,
  busy,
  onSelect,
  onApply,
  onDismiss,
}: {
  p: Proposal;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const k = KIND[p.kind];
  const blocked = blockedReason(p);
  const first = p.entries[0] ?? null;
  const catChange = p.data.category && first && p.data.category !== first.category;

  const entries = (role: (i: number) => "kept" | "gone" | undefined, gone: (i: number) => boolean, sideBySide = false) => (
    <div className={`proposal-entries${sideBySide ? " side-by-side" : ""}`}>
      {p.entries.map((e, i) => (e ? <EntryBox key={e.id} e={e} role={role(i)} gone={gone(i)} /> : <MissingBox key={`m${i}`} id={p.entry_ids[i]} />))}
    </div>
  );

  let body: ReactNode;
  if (p.kind === "update") {
    const edits = proposalEdits(p.data);
    const problems = first ? editProblems(first.body, edits) : edits.map(() => null);
    const entChange = first ? entityChange(first.entities ?? [], p.data.entities) : null;
    const newTitle = p.data.title ?? first?.title ?? "";
    body = (
      <>
        {entries(() => undefined, () => false)}
        <div className="proposal-change">
          {first && newTitle !== first.title && (
            <>
              <div className="change-label">제목</div>
              <Diff a={first.title} b={newTitle} />
            </>
          )}
          {catChange && (
            <div className="change-label">
              분류 {CATEGORY_LABEL[first!.category] ?? first!.category} <Icon name="arrow-right" size={12} /> {CATEGORY_LABEL[p.data.category!] ?? p.data.category}
            </div>
          )}
          {edits.length > 0 ? (
            <>
              <div className="change-label">
                부분 수정{edits.length > 1 && ` ${edits.length}곳`}{" "}
                <span className="change-note">
                  {edits.length > 1 ? "본문에서 정확히 일치하는 구절들을 함께 바꿉니다(각각 한 곳)" : "본문에서 정확히 일치하는 이 구절 한 곳만 바꿉니다"}
                </span>
              </div>
              {edits.map((e, i) => (
                <div key={i} className="proposal-edit">
                  {edits.length > 1 && <div className="change-sub">{i + 1}</div>}
                  <Diff a={e.old} b={e.new} />
                  {problems[i] && <Callout kind="danger">{EDIT_PROBLEM[problems[i]!]}</Callout>}
                </div>
              ))}
            </>
          ) : (
            p.data.body !== undefined &&
            first &&
            p.data.body !== first.body && (
              <>
                <div className="change-label">본문</div>
                <Diff a={first.body} b={p.data.body} />
              </>
            )
          )}
          {entChange && (
            <>
              <div className="change-label">
                엔티티 <span className="change-note">빠지는 엔티티와의 연결을 끊습니다</span>
              </div>
              <div className="entity-change">
                {entChange.kept.map((n) => (
                  <span key={`k-${n}`} className="ent-name">
                    {n}
                  </span>
                ))}
                {entChange.removed.map((n) => (
                  <span key={`r-${n}`} className="ent-name ent-removed" title="빠짐">
                    {n}
                  </span>
                ))}
                {entChange.kept.length === 0 && entChange.added.length === 0 && <span className="faint">(엔티티 없음)</span>}
              </div>
              {entChange.added.length > 0 && (
                <Callout kind="danger">현재 메모리에 없는 엔티티가 들어 있습니다({entChange.added.join(", ")}). 적용하면 실패할 수 있습니다.</Callout>
              )}
            </>
          )}
        </div>
      </>
    );
  } else if (p.kind === "merge") {
    body = (
      <>
        {entries((i) => (i === 0 ? "kept" : "gone"), (i) => i > 0)}
        {first && (
          <div className="proposal-change">
            {p.data.title !== undefined && p.data.title !== first.title && (
              <>
                <div className="change-label">합친 제목</div>
                <Diff a={first.title} b={p.data.title} />
              </>
            )}
            {catChange && (
              <div className="change-label">
                분류 {CATEGORY_LABEL[first.category] ?? first.category} <Icon name="arrow-right" size={12} /> {CATEGORY_LABEL[p.data.category!] ?? p.data.category}
              </div>
            )}
            <div className="change-label">
              합친 본문 <span className="change-note">남길 메모리 #{first.id}의 본문 기준</span>
            </div>
            <Diff a={first.body} b={p.data.body ?? first.body} />
          </div>
        )}
      </>
    );
  } else if (p.kind === "conflict") {
    body = (
      <>
        {entries(() => undefined, () => false, true)}
        {p.data.note && (
          <Callout>
            <b>무엇이 모순인가</b> · {p.data.note}
          </Callout>
        )}
      </>
    );
  } else {
    body = entries(() => undefined, () => true);
  }

  return (
    <section
      className={`proposal kind-${p.kind}${selected ? " is-selected" : ""}`}
      data-proposal={p.id}
      tabIndex={-1}
      aria-label={`${k.label} 제안 #${p.id}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <div className="proposal-head">
        <span className={`badge kind-${p.kind}`}>{k.label}</span>
        <span className="proposal-reason">{p.reason}</span>
        <span className="proposal-id">#{p.id}</span>
      </div>
      {body}
      <div className="proposal-actions">
        <button className="btn small primary" disabled={Boolean(blocked) || busy} aria-busy={busy || undefined} onClick={onApply}>
          {k.action}
          {selected && <kbd>a</kbd>}
        </button>
        <button className="btn small" disabled={busy} onClick={onDismiss}>
          무시
          {selected && <kbd>d</kbd>}
        </button>
        {blocked && (
          <span className="proposal-blocked">
            <Icon name="alert-triangle" size={12} />
            {blocked}
          </span>
        )}
      </div>
    </section>
  );
}
