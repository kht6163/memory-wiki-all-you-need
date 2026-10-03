import "./entry.css";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, type Entry, type Provenance, type Revision } from "../api.ts";
import {
  Diff,
  ACTION_LABEL,
  CATEGORY_LABEL,
  CategoryBadge,
  ErrorBox,
  Markdown,
  SCOPE_LABEL,
  SOURCE_LABEL,
  StateBadge,
  Tags,
  Time,
  act,
  confirmDialog,
  go,
  scopeHref,
  softDelete,
  toast,
  useData,
} from "../lib.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SkeletonPage } from "../components/Skeleton.tsx";
import { EntryGraph, GraphHistory } from "./GraphPages.tsx";
import { CitedBy } from "./WikiPages.tsx";

const togglePin = (e: Entry) => act(() => api.updateEntry(e.id, { pinned: !e.pinned }), { success: e.pinned ? "고정을 해제했습니다" : "고정했습니다" });

export function EntryPage({ id }: { id: number }) {
  const { data, error, loading } = useData(() => api.entry(id), [id]);
  const graphRef = useRef<HTMLDivElement>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <SkeletonPage />;
  const { entry: e, project, revisions, citedBy, entities, links, usage, provenance } = data;
  const scopeName = e.scope === "project" ? project?.name ?? "프로젝트" : SCOPE_LABEL[e.scope];
  const live = !e.deleted_at;

  const remove = async () => {
    const back = scopeHref(e).slice(1);
    const ok = await softDelete({ title: e.title, remove: () => api.deleteEntry(e.id), restore: () => api.restoreEntry(e.id), onUndo: () => go(`/e/${e.id}`) });
    if (ok) go(back);
  };
  const copyId = () => {
    navigator.clipboard
      .writeText(`#${e.id}`)
      .then(() => toast({ kind: "ok", title: "복사됨", description: `#${e.id}` }))
      .catch(() => toast({ kind: "error", title: "복사하지 못했습니다" }));
  };

  return (
    <article className="page wide entry-page">
      <PageHeader
        busy={loading}
        crumbs={
          <>
            <a href={scopeHref(e)}>{scopeName}</a> / <CategoryBadge category={e.category} /> /{" "}
            <button type="button" className="ep-id" onClick={copyId} title="ID 복사" aria-label={`메모리 ID #${e.id} 복사`}>
              #{e.id}
            </button>
          </>
        }
        title={
          <>
            {e.pinned && (
              <span className="pin-icon" title="고정됨" role="img" aria-label="고정됨">
                <Icon name="pin" size={22} />
              </span>
            )}
            <span className="ep-title-text">{e.title}</span>
            <StateBadge e={e} />
          </>
        }
        actions={
          live && (
            <>
              <a className="btn primary" href={`#/e/${e.id}/edit`} title="편집 (e)" aria-keyshortcuts="e">
                <Icon name="pencil" />
                편집
                <kbd className="ep-kbd">e</kbd>
              </a>
              <MoreMenu
                label="메모리 작업 더 보기"
                items={[
                  { label: e.pinned ? "고정 해제" : "고정", icon: "pin", run: () => togglePin(e) },
                  { label: "ID 복사", icon: "copy", run: copyId },
                  { label: "삭제", icon: "trash-2", danger: true, run: remove },
                ]}
              />
            </>
          )
        }
      >
        {e.deleted_at && (
          <Callout kind="danger" icon="trash-2">
            <span>
              이 메모리는 삭제되었습니다 (<Time iso={e.deleted_at} />
              ).
            </span>
            <button className="btn small" onClick={() => act(() => api.restoreEntry(e.id), { success: "복원했습니다" })}>
              <Icon name="rotate-ccw" size={14} />
              복원
            </button>
          </Callout>
        )}
        {e.superseded_by ? (
          <Callout kind="warn" icon="info">
            <span>
              이 메모리는 <a href={`#/e/${e.superseded_by}`}>#{e.superseded_by}</a>으로 대체되어 더 이상 주입되지 않습니다.
              <span className="ep-callout-hint"> 연결 섹션에서 대체 관계를 지우면 다시 주입됩니다.</span>
            </span>
            <button className="btn small ghost" onClick={() => graphRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              연결로 이동
            </button>
          </Callout>
        ) : e.expired ? (
          <Callout kind="warn" icon="info">
            <span>유효 기한({e.valid_until})이 지나 더 이상 주입되지 않습니다.</span>
            {live && (
              <button className="btn small" onClick={() => act(() => api.updateEntry(e.id, { valid_until: null }), { success: "유효 기한을 없앴습니다" })}>
                기한 없애기
              </button>
            )}
          </Callout>
        ) : null}
      </PageHeader>

      <div className="ep-layout">
        <div className="ep-body entry-body">{e.body ? <Markdown>{e.body}</Markdown> : <p className="muted">본문 없음</p>}</div>

        <aside className="ep-aside" aria-label="메모리 정보">
          <dl className="meta-grid ep-meta">
            <dt>범위</dt>
            <dd>
              <a href={scopeHref(e)}>{scopeName}</a>
            </dd>

            <dt>분류</dt>
            <dd>
              <CategoryBadge category={e.category} />
            </dd>

            <dt id="ep-pin-label">고정</dt>
            <dd>
              <button
                type="button"
                role="switch"
                className="ep-switch"
                aria-checked={e.pinned}
                aria-labelledby="ep-pin-label"
                disabled={!live}
                title={e.pinned ? "고정 해제" : "고정"}
                onClick={() => togglePin(e)}
              />
            </dd>

            <dt>작성자</dt>
            <dd className="ep-inline">
              <span className={`dot src-${e.source}`} aria-hidden />
              {SOURCE_LABEL[e.source]}
            </dd>

            <dt>사용</dt>
            <dd>
              {usage.recalled + usage.searched === 0 ? (
                <span className="muted">아직 없음</span>
              ) : (
                <>
                  <span className="tabular">
                    회상 {usage.recalled} · 검색 {usage.searched}
                  </span>
                  {usage.last_used_at && (
                    <div className="ep-sub">
                      마지막 <Time iso={usage.last_used_at} />
                    </div>
                  )}
                </>
              )}
              {usage.shown_at && (
                <div className="ep-sub">
                  기본 블록 주입 <Time iso={usage.shown_at} />
                </div>
              )}
            </dd>

            <dt title="이 메모리를 추가·수정·확인한 턴">출처 턴</dt>
            <dd>
              <ProvenanceInfo p={provenance} />
            </dd>

            <dt>생성</dt>
            <dd>
              <Time iso={e.created_at} />
            </dd>

            <dt>수정</dt>
            <dd>
              <Time iso={e.updated_at} />
            </dd>

            <dt>유효 기한</dt>
            <dd>
              {e.valid_until ? (
                <span className="tabular">
                  {e.valid_until}
                  {e.expired && <span className="muted"> (지남)</span>}
                </span>
              ) : (
                <span className="muted">없음</span>
              )}
            </dd>

            <dt>태그</dt>
            <dd>{e.tags.length ? <Tags tags={e.tags} /> : <span className="muted">없음</span>}</dd>

            <dt>엔티티</dt>
            <dd>
              {entities.length ? (
                <span className="ep-chips">
                  {entities.map((n) => (
                    <a key={n.id} className="entity-chip ep-chip" href={`#/entity/${n.id}`}>
                      {n.name}
                    </a>
                  ))}
                </span>
              ) : (
                <span className="muted">없음</span>
              )}
            </dd>

            <dt title="검색에만 쓰이고 주입되지 않는 단어">검색 키워드</dt>
            <dd>
              {e.keywords?.length ? (
                <span className="ep-chips">
                  {e.keywords.map((k) => (
                    <a key={k} className="ep-kw" href={`#/search?q=${encodeURIComponent(k)}`}>
                      {k}
                    </a>
                  ))}
                </span>
              ) : (
                <span className="muted">없음</span>
              )}
            </dd>
          </dl>
        </aside>

        <div className="ep-rest">
          <div ref={graphRef} className="ep-anchor">
            <EntryGraph entryId={e.id} projectId={e.project_id} entities={entities} links={links} editable={live && e.category !== "standing"} />
          </div>

          <GraphHistory entryId={e.id} title="연결 변경 이력" hideEmpty pageSize={10} />

          <CitedBy pages={citedBy} />

          <h2>
            수정 이력 <span className="count muted tabular">{revisions.length}</span>
          </h2>
          <ol className="history ep-history">
            {revisions.map((r, i) => (
              <RevisionItem key={r.id} rev={r} prev={revisions[i + 1]} entryId={e.id} isCurrent={i === 0} canRevert={live} />
            ))}
          </ol>
        </div>
      </div>
    </article>
  );
}

const PROV_KIND: Record<Provenance["recent"][number]["kind"], string> = { add: "추가", update: "수정", confirm: "확인", duplicate: "중복" };
const PROV_HINT: Record<Provenance["recent"][number]["kind"], string> = {
  add: "이 턴에서 추가됨",
  update: "이 턴에서 수정됨",
  confirm: "이 턴에서 여전히 맞다고 확인됨",
  duplicate: "이 턴에서 같은 내용을 다시 말함",
};
const PROV_SHOWN = 5;

/** "출처 턴": how many curated turns touched this memory, and the latest few. */
function ProvenanceInfo({ p }: { p: Provenance | undefined }) {
  const [all, setAll] = useState(false);
  if (!p || p.count === 0) return <span className="muted">기록 없음</span>;
  const shown = all ? p.recent : p.recent.slice(0, PROV_SHOWN);
  return (
    <>
      <span className="tabular">{p.count}개 턴</span>
      {p.last_at && (
        <div className="ep-sub">
          마지막 <Time iso={p.last_at} />
        </div>
      )}
      <ul className="ep-prov">
        {shown.map((t) => (
          <li key={`${t.turn_id}-${t.kind}`}>
            <a className="mono-num" href={`#/turns/${t.turn_id}`} title={t.session_id ? `세션 ${t.session_id}` : undefined}>
              턴 #{t.turn_id}
            </a>
            <span className={`ep-prov-kind prov-${t.kind}`} title={PROV_HINT[t.kind]}>
              {PROV_KIND[t.kind] ?? t.kind}
            </span>
            <span className="faint">
              <Time iso={t.created_at} />
            </span>
          </li>
        ))}
      </ul>
      {p.recent.length > PROV_SHOWN && (
        <button type="button" className="btn small ghost ep-prov-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "접기" : `${p.recent.length - PROV_SHOWN}개 더 보기`}
        </button>
      )}
    </>
  );
}

function Callout({ kind, icon, children }: { kind: "warn" | "danger" | "info"; icon: IconName; children: ReactNode }) {
  return (
    <div className={`callout ${kind} ep-callout`} role="status">
      <Icon name={icon} size={16} />
      <div className="callout-text ep-callout-text">{children}</div>
    </div>
  );
}

interface MenuItem {
  label: string;
  icon: IconName;
  danger?: boolean;
  run: () => void;
}

/** Small dropdown: Esc / outside click closes, ↑↓ moves between items, focus returns to the trigger. */
function MoreMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onDown = (ev: MouseEvent) => {
      if (!wrap.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const onKey = (ev: KeyboardEvent) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const n = els.length;
      els[(i + (ev.key === "ArrowDown" ? 1 : n - 1)) % n]?.focus();
    } else if (ev.key === "Home" || ev.key === "End") {
      ev.preventDefault();
      els[ev.key === "Home" ? 0 : els.length - 1]?.focus();
    } else if (ev.key === "Tab") {
      close(false);
    }
  };

  return (
    <div className="ep-menu" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="btn ep-menu-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(ev) => {
          if (ev.key === "ArrowDown" && !open) {
            ev.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="more-horizontal" />
      </button>
      {open && (
        <div className="menu-list" role="menu" aria-label={label} ref={list} onKeyDown={onKey}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`menu-item${it.danger ? " danger" : ""}`}
              onClick={() => {
                close();
                it.run();
              }}
            >
              <Icon name={it.icon} size={14} />
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const sameList = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
const listText = (xs: string[]) => (xs.length ? xs.join(", ") : "없음");

function RevisionItem({ rev, prev, entryId, isCurrent, canRevert }: { rev: Revision; prev?: Revision; entryId: number; isCurrent: boolean; canRevert: boolean }) {
  const [open, setOpen] = useState(isCurrent);
  // keywords / valid_until are recorded from v0.6.0 on; older revisions carry null for both.
  const tracked = prev && prev.keywords != null && rev.keywords != null;
  const entitiesChanged = prev?.entities && rev.entities && !sameList(prev.entities, rev.entities);
  const keywordsChanged = tracked && !sameList(prev.keywords!, rev.keywords!);
  const validChanged = tracked && (prev.valid_until ?? null) !== (rev.valid_until ?? null);
  const changedFields = prev
    ? [
        prev.title !== rev.title && "제목",
        prev.body !== rev.body && "본문",
        prev.category !== rev.category && "분류",
        prev.pinned !== rev.pinned && "고정",
        !sameList(prev.tags, rev.tags) && "태그",
        entitiesChanged && "엔티티",
        keywordsChanged && "검색 키워드",
        validChanged && "유효 기한",
      ].filter(Boolean)
    : [];
  const bodyId = `rev-body-${rev.id}`;

  return (
    <li className={`rev rev-${rev.action}${isCurrent ? " is-current" : ""}`}>
      <span className={`dot src-${rev.author}`} aria-hidden />
      <div className="rev-head ep-rev-head">
        <button type="button" className="ep-rev-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
          <strong>{SOURCE_LABEL[rev.author]}</strong> {ACTION_LABEL[rev.action]}
          {changedFields.length > 0 && <span className="muted"> · {changedFields.join(", ")}</span>}
          <span className="muted">
            {" "}
            · <Time iso={rev.created_at} />
          </span>
          {isCurrent && <span className="badge faint">현재</span>}
        </button>
        {rev.turn_id && (
          <a className="muted ep-rev-turn" href={`#/turns/${rev.turn_id}`}>
            턴 #{rev.turn_id}
          </a>
        )}
        {!isCurrent && canRevert && rev.action !== "delete" && (
          <button
            type="button"
            className="btn small ghost right ep-revert"
            aria-label="이 버전으로 되돌리기"
            title="이 버전으로 되돌리기"
            onClick={async () => {
              const ok = await confirmDialog({ title: "이 버전으로 되돌릴까요?", body: <p>현재 내용은 수정 이력에 남습니다.</p>, confirmLabel: "되돌리기" });
              if (ok) act(() => api.revertEntry(entryId, rev.id), { success: "되돌렸습니다" });
            }}
          >
            <Icon name="rotate-ccw" size={14} />
            되돌리기
          </button>
        )}
      </div>
      {rev.reason && <div className="rev-reason">{rev.reason}</div>}
      {open && (
        <div className="rev-body" id={bodyId}>
          {prev && prev.title !== rev.title && <Diff a={prev.title} b={rev.title} />}
          {prev ? prev.body !== rev.body ? <Diff a={prev.body} b={rev.body} /> : null : <Markdown>{rev.body || "_본문 없음_"}</Markdown>}
          {prev && prev.category !== rev.category && <Diff a={`분류: ${CATEGORY_LABEL[prev.category] ?? prev.category}`} b={`분류: ${CATEGORY_LABEL[rev.category] ?? rev.category}`} />}
          {prev && prev.pinned !== rev.pinned && <Diff a={`고정: ${prev.pinned ? "예" : "아니오"}`} b={`고정: ${rev.pinned ? "예" : "아니오"}`} />}
          {prev && !sameList(prev.tags, rev.tags) && <Diff a={`태그: ${listText(prev.tags)}`} b={`태그: ${listText(rev.tags)}`} />}
          {entitiesChanged && <Diff a={`엔티티: ${listText(prev!.entities!)}`} b={`엔티티: ${listText(rev.entities!)}`} />}
          {keywordsChanged && <Diff a={`검색 키워드: ${listText(prev!.keywords!)}`} b={`검색 키워드: ${listText(rev.keywords!)}`} />}
          {validChanged && <Diff a={`유효 기한: ${prev!.valid_until ?? "없음"}`} b={`유효 기한: ${rev.valid_until ?? "없음"}`} />}
          {prev && changedFields.length === 0 && <p className="muted small">내용 변경 없음</p>}
        </div>
      )}
    </li>
  );
}
