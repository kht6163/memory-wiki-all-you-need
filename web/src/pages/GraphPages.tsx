import "./graph.css";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, type Entity, type EntryLink, type GraphRevision, type LinkType, type SimilarPair } from "../api.ts";
import { CategoryBadge, Empty, ErrorBox, SCOPE_LABEL, SourceBadge, StateBadge, Time, act, confirmDialog, go, isHistory, toast, useData } from "../lib.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SkeletonList, SkeletonPage } from "../components/Skeleton.tsx";

export const LINK_LABEL: Record<LinkType, { out: string; in: string; name: string }> = {
  because: { out: "이유", in: "이것 때문에 생긴 것", name: "이유 (because)" },
  depends_on: { out: "전제", in: "이것을 전제로 하는 것", name: "전제 (depends_on)" },
  supersedes: { out: "대체함", in: "대체됨", name: "대체 (supersedes)" },
  related: { out: "관련", in: "관련", name: "관련 (related)" },
};
export const LINK_TYPES = Object.keys(LINK_LABEL) as LinkType[];
export const KIND_LABEL: Record<string, string> = { tech: "기술", service: "서비스", tool: "도구", file: "파일", concept: "개념", person: "사람" };
const KINDS = Object.keys(KIND_LABEL);

const KIND_GLYPH: Record<string, IconName> = { tech: "cpu", service: "server", tool: "wrench", file: "file", concept: "lightbulb", person: "user" };

export function KindIcon({ kind, size = 14 }: { kind: string; size?: number }) {
  return <Icon name={KIND_GLYPH[kind] ?? "lightbulb"} size={size} className={`kind-icon kind-${kind}`} />;
}

// -------------------------------------------------------------- pieces

export function EntityChips({ entities }: { entities: Entity[] }) {
  if (!entities.length) return null;
  return (
    <div className="entity-chips">
      {entities.map((n) => (
        <a key={n.id} className="entity-chip" href={`#/entity/${n.id}`} title={KIND_LABEL[n.kind] ?? n.kind}>
          <KindIcon kind={n.kind} size={13} />
          {n.name}
        </a>
      ))}
    </div>
  );
}

/** Plain-Korean reading of a link, so "supersedes" never leaves the direction to guesswork. */
function linkExplain(l: EntryLink): string | null {
  const n = `#${l.other.id}`;
  if (l.type === "supersedes") return l.dir === "out" ? `이 메모리가 ${n}을(를) 대체` : `${n}이(가) 이 메모리를 대체`;
  if (l.type === "because") return l.dir === "out" ? `${n} 때문에 생긴 메모리` : `${n}이(가) 이 메모리 때문에 생김`;
  if (l.type === "depends_on") return l.dir === "out" ? `${n}을(를) 전제로 함` : `${n}이(가) 이 메모리를 전제로 함`;
  return null;
}

export function LinkList({ links, onRemove }: { links: EntryLink[]; onRemove?: (l: EntryLink) => void }) {
  if (!links.length) return null;
  return (
    <ul className="link-list">
      {links.map((l) => {
        const explain = linkExplain(l);
        return (
          <li key={`${l.from_id}-${l.to_id}-${l.type}`}>
            <span className={`link-type lt-${l.type}`} title={LINK_LABEL[l.type].name}>
              {LINK_LABEL[l.type][l.dir]}
            </span>
            <a className="link-title" href={`#/e/${l.other.id}`}>
              {l.other.title}
            </a>
            <span className="faint small mono-num">#{l.other.id}</span>
            {explain && <span className="link-explain">{explain}</span>}
            {onRemove && (
              <button className="icon-btn danger link-remove" title="관계 삭제" aria-label={`#${l.other.id}와의 관계 삭제`} onClick={() => onRemove(l)}>
                <Icon name="x" size={14} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** "연결" section of a memory: entities and typed links, editable. */
export function EntryGraph({
  entryId,
  projectId,
  entities,
  links,
  editable,
}: {
  entryId: number;
  projectId: number | null;
  entities: Entity[];
  links: EntryLink[];
  editable: boolean;
}) {
  const [entityText, setEntityText] = useState("");
  const [to, setTo] = useState("");
  const [type, setType] = useState<LinkType>("related");
  const [pick, setPick] = useState<{ id: number; title: string }[]>([]);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const term = to.trim();
    setActive(-1);
    if (!term || /^#?\d+$/.test(term)) return setPick([]);
    let alive = true;
    const t = setTimeout(
      () =>
        api
          .search(term)
          .then((r) => alive && setPick(r.filter((e) => e.id !== entryId).slice(0, 6)))
          .catch(() => alive && setPick([])),
      250,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [to, entryId]);

  const addEntity = () => {
    const name = entityText.trim();
    if (!name) return;
    act(() => api.updateEntry(entryId, { entities: [...entities.map((n) => n.name), name] })).then((r) => r !== undefined && setEntityText(""));
  };
  const removeEntity = (n: Entity) => act(() => api.updateEntry(entryId, { entities: entities.filter((x) => x.id !== n.id).map((x) => x.name) }));
  const addLink = (target: number) =>
    act(() => api.addLink(entryId, target, type), { success: "관계를 추가했습니다" }).then((r) => {
      if (r === undefined) return;
      setTo("");
      setPick([]);
    });
  // An incoming link is stored on the other memory, so remove it there.
  const removeLink = (l: EntryLink) => act(() => api.removeLink(l.from_id, l.to_id, l.type), { success: "관계를 지웠습니다" });

  const onPickKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!pick.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % pick.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? pick.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      addLink(pick[active].id);
    } else if (e.key === "Escape") {
      setPick([]);
    }
  };

  return (
    <section className="entry-graph">
      <div className="section-head">
        <h2>연결</h2>
        <span className="count">
          엔티티 {entities.length} · 관계 {links.length}
        </span>
        <a className="btn small ghost" href={`#/graph?${projectId ? `project=${projectId}&` : ""}focus=m${entryId}`}>
          <Icon name="share-2" size={14} />
          그래프에서 보기
        </a>
      </div>
      <div className="entity-chips">
        {entities.map((n) => (
          <span key={n.id} className="entity-chip" title={KIND_LABEL[n.kind] ?? n.kind}>
            <KindIcon kind={n.kind} size={13} />
            <a href={`#/entity/${n.id}`}>{n.name}</a>
            {editable && (
              <button className="chip-x" title="엔티티 빼기" aria-label={`엔티티 ${n.name} 빼기`} onClick={() => removeEntity(n)}>
                <Icon name="x" size={12} />
              </button>
            )}
          </span>
        ))}
        {!entities.length && <span className="faint small">엔티티 없음</span>}
        {editable && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              addEntity();
            }}
          >
            <input value={entityText} onChange={(e) => setEntityText(e.target.value)} placeholder="+ 엔티티 (예: PostgreSQL)" aria-label="엔티티 추가" />
          </form>
        )}
      </div>
      <LinkList links={links} onRemove={editable ? removeLink : undefined} />
      {!links.length && <p className="faint small">다른 메모리와 맺은 관계가 없습니다.</p>}
      {editable && (
        <form
          className="inline-form link-form"
          onSubmit={(e) => {
            e.preventDefault();
            const m = to.trim().match(/^#?(\d+)$/);
            if (m) addLink(Number(m[1]));
            else if (active >= 0 && pick[active]) addLink(pick[active].id);
          }}
        >
          <select value={type} onChange={(e) => setType(e.target.value as LinkType)} aria-label="관계 종류">
            {LINK_TYPES.map((t) => (
              <option key={t} value={t}>
                {LINK_LABEL[t].name}
              </option>
            ))}
          </select>
          <div className="link-pick">
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              onKeyDown={onPickKey}
              placeholder="관계 맺을 메모리: #id 또는 검색어"
              aria-label="관계 맺을 메모리"
              role="combobox"
              aria-expanded={pick.length > 0}
              aria-controls={`link-pick-${entryId}`}
              aria-activedescendant={active >= 0 ? `link-pick-${entryId}-${active}` : undefined}
              autoComplete="off"
            />
            {pick.length > 0 && (
              <div className="pick-list" id={`link-pick-${entryId}`} role="listbox">
                {pick.map((p, i) => (
                  <button
                    type="button"
                    key={p.id}
                    id={`link-pick-${entryId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={i === active ? "is-active" : undefined}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => addLink(p.id)}
                  >
                    <span className="faint mono-num">#{p.id}</span> {p.title}
                  </button>
                ))}
              </div>
            )}
          </div>
          {type === "supersedes" && <span className="faint small">이 메모리가 고른 메모리를 대체합니다(고른 쪽은 이력이 됩니다).</span>}
        </form>
      )}
    </section>
  );
}

// -------------------------------------------------------- graph history

const LINK_SHORT: Record<string, string> = { supersedes: "대체", because: "이유", depends_on: "전제", related: "관련" };

const memRef = (id: unknown) => (
  <a className="mono-num" href={`#/e/${Number(id)}`}>
    #{Number(id)}
  </a>
);

/** Plain-Korean one-liner for a graph revision; `name` resolves entity ids the snapshot does not name. */
function revisionSummary(r: GraphRevision, name: (id: number) => ReactNode): ReactNode {
  const s = r.snapshot;
  const type = LINK_SHORT[String(s.type)] ?? String(s.type);
  if (r.target === "link") {
    const pair = (
      <>
        {memRef(s.from_id)} → {memRef(s.to_id)} <span className="faint">({type})</span>
      </>
    );
    if (r.action === "add") return <>{s.prior ? "대체 관계 켜기" : "관계 추가"}: {pair}</>;
    if (r.action === "remove") return <>{s.downgrade ? "대체 관계 끄기" : "관계 삭제"}: {pair}</>;
    return <>관계 {r.action}: {pair}</>;
  }
  const entityName = (row: unknown, id: unknown) => (row && typeof row === "object" && "name" in row ? <b>{String((row as { name: unknown }).name)}</b> : name(Number(id)));
  if (r.action === "update") {
    const b = (s.before ?? {}) as { name?: string; kind?: string; description?: string };
    const a = (s.after ?? {}) as { name?: string; kind?: string; description?: string };
    const parts: ReactNode[] = [];
    if (b.name !== a.name)
      parts.push(
        <span key="n">
          엔티티 이름 변경: <b>{b.name}</b> → <b>{a.name}</b>
        </span>,
      );
    if (b.kind !== a.kind)
      parts.push(
        <span key="k">
          {parts.length ? "종류" : <>엔티티 {name(Number(s.entity_id))} 종류 변경:</>} {KIND_LABEL[b.kind ?? ""] ?? b.kind} → {KIND_LABEL[a.kind ?? ""] ?? a.kind}
        </span>,
      );
    if ((b.description ?? "") !== (a.description ?? ""))
      parts.push(<span key="d">{parts.length ? "설명 변경" : <>엔티티 {name(Number(s.entity_id))} 설명 변경</>}</span>);
    if (!parts.length) return <>엔티티 수정: {name(Number(s.entity_id))}</>;
    return parts.map((p, i) => (
      <span key={i}>
        {i > 0 && " · "}
        {p}
      </span>
    ));
  }
  if (r.action === "merge")
    return (
      <>
        엔티티 합치기: {entityName(s.entity, s.entity_id)} → {name(Number(s.into_id))}
      </>
    );
  if (r.action === "delete") return <>엔티티 삭제: {entityName(s.entity, s.entity_id)}</>;
  if (r.action === "unmerge")
    return (
      <>
        합치기 되돌림: {name(Number(s.entity_id))} <span className="faint">({name(Number(s.into_id))}에서 다시 분리)</span>
      </>
    );
  if (r.action === "restore") return <>삭제 되돌림: {name(Number(s.entity_id))} 복원</>;
  return (
    <>
      엔티티 {r.action}: {name(Number(s.entity_id))}
    </>
  );
}

/**
 * Memory-graph edit history (links and entities) with per-row undo. `entityId` / `entryId` narrow it;
 * neither = everything. `hideEmpty` renders nothing when there is no history.
 */
export function GraphHistory({
  entityId,
  entryId,
  title,
  hideEmpty = false,
  pageSize = 20,
  bare = false,
}: {
  entityId?: number;
  entryId?: number;
  title?: string;
  hideEmpty?: boolean;
  pageSize?: number;
  /** No heading (the caller provides one, e.g. a <summary>). */
  bare?: boolean;
}) {
  const [limit, setLimit] = useState(pageSize);
  const revs = useData(() => api.graphRevisions({ entity_id: entityId, entry_id: entryId, limit: limit + 1 }), [entityId, entryId, limit]);
  const needNames = Boolean(revs.data?.some((r) => r.target === "entity"));
  const ents = useData(() => (needNames ? api.entities() : Promise.resolve([] as Entity[])), [needNames]);
  const names = useMemo(() => new Map((ents.data ?? []).map((n) => [n.id, n.name])), [ents.data]);
  const [busy, setBusy] = useState<number | null>(null);

  if (revs.error) return <ErrorBox error={revs.error} />;
  if (!revs.data) return bare ? <SkeletonList rows={2} /> : null;
  const list = revs.data.slice(0, limit);
  const more = revs.data.length > limit;
  if (!list.length && hideEmpty) return null;

  const name = (id: number): ReactNode => {
    const n = names.get(id);
    if (n !== undefined)
      return (
        <a href={`#/entity/${id}`}>
          <b>{n}</b>
        </a>
      );
    return id === entityId ? <b>이 엔티티</b> : <span className="faint">엔티티 #{id}</span>;
  };

  const revert = async (r: GraphRevision) => {
    const ok = await confirmDialog({
      title: "이 변경을 되돌릴까요?",
      body: (
        <>
          <p>{revisionSummary(r, name)}</p>
          <p>되돌린 기록도 변경 이력에 남습니다.</p>
        </>
      ),
      confirmLabel: "되돌리기",
    });
    if (!ok) return;
    setBusy(r.id);
    const res = await act(() => api.revertGraphRevision(r.id), { success: "되돌렸습니다" });
    setBusy(null);
    if (res !== undefined) revs.reload();
  };

  return (
    <section className="graph-history">
      {!bare && (
        <div className="section-head">
          <h2>{title ?? "변경 이력"}</h2>
          <span className="count">{more ? `${list.length}+` : list.length}</span>
        </div>
      )}
      {!list.length ? (
        <p className="faint small">변경 이력이 없습니다.</p>
      ) : (
        <ol className="history gh-list">
          {list.map((r) => (
            <li key={r.id} className={`rev gh-row${r.reverted_at ? " is-reverted" : ""}`} aria-busy={busy === r.id || undefined}>
              <span className={`dot src-${r.author}`} aria-hidden />
              <div className="gh-line">
                <span className="gh-summary">
                  {revisionSummary(r, name)}
                  {r.snapshot.revert_of && <span className="faint"> · 되돌리기로 생김</span>}
                </span>
                <span className="gh-meta">
                  <SourceBadge source={r.author} />
                  <span className="faint small">
                    <Time iso={r.created_at} />
                  </span>
                  {r.reverted_at ? (
                    <span className="badge faint gh-reverted">
                      되돌림 <Time iso={r.reverted_at} />
                    </span>
                  ) : (
                    r.revertible && (
                      <button type="button" className="btn small ghost gh-revert" disabled={busy !== null} onClick={() => revert(r)} title="이 변경 되돌리기">
                        <Icon name="rotate-ccw" size={14} />
                        되돌리기
                      </button>
                    )
                  )}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {more && (
        <button className="btn small ghost gh-more" onClick={() => setLimit(limit + pageSize * 2)}>
          <Icon name="chevron-down" size={14} />더 보기
        </button>
      )}
    </section>
  );
}

/** Collapsible global graph history (entities page); loads only once opened. */
function GraphHistoryCard() {
  const [open, setOpen] = useState(false);
  return (
    <details className="card gh-card" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <Icon name="chevron-right" size={14} className="chev" />
        <Icon name="rotate-ccw" size={15} />
        <strong>그래프 변경 이력</strong>
        <span className="faint">관계·엔티티의 추가·삭제·이름 변경·합치기를 되돌릴 수 있습니다</span>
      </summary>
      {open && (
        <div className="gh-card-body">
          <GraphHistory bare pageSize={30} />
        </div>
      )}
    </details>
  );
}

// ------------------------------------------------------------- entities

function readEntityQuery(): { q: string; kind: string } {
  const raw = window.location.hash.split("?")[1] ?? "";
  const p = new URLSearchParams(raw);
  return { q: p.get("q") ?? "", kind: p.get("kind") ?? "" };
}

/** Keeps the filter in the hash without firing hashchange (which would scroll and re-route on every key). */
function writeEntityQuery(q: string, kind: string) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (kind) p.set("kind", kind);
  const s = p.toString();
  const next = `#/entities${s ? `?${s}` : ""}`;
  if (window.location.hash !== next) history.replaceState(history.state, "", next);
}

export function EntitiesPage() {
  const init = useMemo(readEntityQuery, []);
  const [q, setQ] = useState(init.q);
  const [term, setTerm] = useState(init.q.trim());
  const [kind, setKind] = useState(init.kind);
  const list = useData(() => api.entities(term || undefined), [term]);

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => writeEntityQuery(q.trim(), kind), [q, kind]);
  // A real navigation (e.g. the sidebar link) changes the hash: follow it.
  useEffect(() => {
    const on = () => {
      if (!window.location.hash.startsWith("#/entities")) return;
      const next = readEntityQuery();
      setQ(next.q);
      setKind(next.kind);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of list.data ?? []) m.set(n.kind, (m.get(n.kind) ?? 0) + 1);
    return m;
  }, [list.data]);
  const shown = (list.data ?? []).filter((n) => !kind || n.kind === kind);
  const kinds = [...KINDS.filter((k) => counts.has(k)), ...[...counts.keys()].filter((k) => !KINDS.includes(k))];
  const filtered = Boolean(term || kind);

  return (
    <article className="page entities-page">
      <PageHeader
        title="엔티티"
        lead="메모리가 다루는 기술·서비스·도구·파일·개념입니다. 같은 것을 가리키는 엔티티는 합칠 수 있습니다(예전 이름은 별칭으로 남아 다음 정리에서도 같은 엔티티로 묶입니다)."
        busy={list.loading && Boolean(list.data)}
        actions={
          <a className="btn" href="#/graph">
            <Icon name="share-2" />
            그래프
          </a>
        }
        toolbar={
          <>
            <div className="search-field">
              <Icon name="search" size={14} />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQ("")}
                placeholder="엔티티 검색"
                aria-label="엔티티 검색"
              />
            </div>
            <div className="chip-row" role="group" aria-label="종류 필터">
              <button className="chip" aria-pressed={!kind} onClick={() => setKind("")}>
                전체 <span className="count">{list.data?.length ?? ""}</span>
              </button>
              {kinds.map((k) => (
                <button key={k} className="chip" aria-pressed={kind === k} onClick={() => setKind(kind === k ? "" : k)}>
                  <KindIcon kind={k} size={13} />
                  {KIND_LABEL[k] ?? k} <span className="count">{counts.get(k)}</span>
                </button>
              ))}
              {kind && !counts.has(kind) && (
                <button className="chip" aria-pressed onClick={() => setKind("")}>
                  {KIND_LABEL[kind] ?? kind} <span className="count">0</span>
                </button>
              )}
            </div>
          </>
        }
      />
      <ErrorBox error={list.error} />
      {!filtered && <SimilarSection />}
      {!filtered && <GraphHistoryCard />}
      {!filtered && list.data && list.data.length > 0 && (
        <div className="section-head">
          <h2>모든 엔티티</h2>
          <span className="count">{list.data.length}</span>
        </div>
      )}
      {list.loading && !list.data && <SkeletonList rows={3} />}
      {list.data && shown.length === 0 &&
        (filtered ? (
          <Empty
            icon="search"
            title="일치하는 엔티티가 없습니다"
            action={
              <button
                className="btn ghost"
                onClick={() => {
                  setQ("");
                  setKind("");
                }}
              >
                필터 지우기
              </button>
            }
          />
        ) : (
          <Empty icon="tag" title="엔티티가 없습니다">
            턴이 정리되거나 그래프를 붙이면 생깁니다.
          </Empty>
        ))}
      {shown.length > 0 && (
        <div className="entity-grid">
          {shown.map((n) => (
            <a key={n.id} className="entity-card" href={`#/entity/${n.id}`}>
              <span className="entity-card-icon" title={KIND_LABEL[n.kind] ?? n.kind}>
                <KindIcon kind={n.kind} size={16} />
              </span>
              <span className="entity-card-text">
                <b className="entity-card-name">{n.name}</b>
                <span className="faint small">{KIND_LABEL[n.kind] ?? n.kind}</span>
              </span>
              <span className="entity-card-count" title={`메모리 ${n.count ?? 0}개`} aria-label={`메모리 ${n.count ?? 0}개`}>
                {n.count ?? 0}
              </span>
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

const REASON_LABEL: Record<SimilarPair["reasons"][number], string> = { name: "이름 비슷", contains: "포함", cooccur: "함께 언급" };
const REASON_HINT: Record<SimilarPair["reasons"][number], string> = {
  name: "이름의 철자가 거의 같습니다",
  contains: "한쪽 이름이 다른 쪽 이름에 들어 있습니다",
  cooccur: "같은 메모리에 자주 함께 나옵니다",
};
const pairKey = (p: SimilarPair) => `${Math.min(p.a.id, p.b.id)}-${Math.max(p.a.id, p.b.id)}`;
const SIMILAR_TOP = 5;

/** Candidate duplicates (api.similarEntities) with merge / swap / dismiss. */
function SimilarSection() {
  const similar = useData(() => api.similarEntities(), []);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const pairs = (similar.data ?? []).filter((p) => !gone.has(pairKey(p)));
  if (similar.error) return <ErrorBox error={similar.error} />;
  if (!similar.data || !pairs.length) return null;
  const visible = all ? pairs : pairs.slice(0, SIMILAR_TOP);

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  };

  return (
    <section className="similar">
      <div className="section-head">
        <h2>비슷한 엔티티</h2>
        <span className="count">{pairs.length}</span>
        <span className="faint small">같은 것을 가리킬 수 있는 쌍입니다. 합치거나 다른 것으로 표시하세요.</span>
      </div>
      <div className="list">
        {visible.map((p) => {
          const key = pairKey(p);
          const byId = { [p.a.id]: p.a, [p.b.id]: p.b };
          const dir = flipped.has(key) ? { from: p.merge.into, into: p.merge.from } : p.merge;
          const from = byId[dir.from];
          const into = byId[dir.into];
          const pct = Math.round(p.score * 100);
          const merge = async () => {
            const ok = await confirmDialog({
              title: "엔티티 합치기",
              body: (
                <>
                  <p>
                    <b>{from.name}</b>을(를) <b>{into.name}</b>로 합칩니다. 옛 이름은 별칭으로 남아 같은 엔티티로 찾아집니다.
                  </p>
                  <p>
                    "{from.name}"에 연결된 메모리 {from.count}개가 "{into.name}"로 옮겨지고, "{from.name}" 엔티티는 사라집니다. 변경 이력에서 되돌릴 수 있습니다.
                  </p>
                </>
              ),
              confirmLabel: "합치기",
            });
            if (!ok) return;
            setBusy(key);
            const r = await act(() => api.mergeEntity(from.id, into.id), { success: `"${from.name}"을(를) "${into.name}"로 합쳤습니다` });
            setBusy(null);
            if (r !== undefined) {
              setGone((g) => new Set(g).add(key));
              similar.reload();
            }
          };
          const dismiss = async () => {
            setBusy(key);
            try {
              await api.dismissSimilar(p.a.id, p.b.id);
              setGone((g) => new Set(g).add(key));
              toast({ kind: "ok", title: "다른 것으로 표시했습니다", description: `${p.a.name} · ${p.b.name}은(는) 다시 제안되지 않습니다.` });
            } catch (e) {
              toast({ kind: "error", title: "요청 실패", description: (e as Error).message });
            } finally {
              setBusy(null);
            }
          };
          return (
            <div key={key} className="list-row similar-row" aria-busy={busy === key}>
              <div className="similar-pair">
                <SimilarSide e={p.a} />
                <span className="similar-sep" aria-label="와(과)">
                  ↔
                </span>
                <SimilarSide e={p.b} />
              </div>
              <div className="similar-meta">
                <span className="score" title={`유사도 ${pct}%`}>
                  <span className="score-meter" role="meter" aria-label="유사도" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                    <span style={{ width: `${pct}%` }} />
                  </span>
                  <span className="score-num">{pct}%</span>
                </span>
                {p.reasons.map((r) => (
                  <span key={r} className={`reason-chip reason-${r}`} title={REASON_HINT[r]}>
                    {REASON_LABEL[r]}
                  </span>
                ))}
                <span className="similar-dir">
                  <span className="faint">합치면</span> <b>{from.name}</b> <Icon name="arrow-right" size={12} /> <b>{into.name}</b>
                </span>
                <span className="similar-actions">
                  <button
                    className="icon-btn"
                    aria-label={`방향 바꾸기: ${into.name}을(를) ${from.name}로 합치기`}
                    title="합치는 방향 바꾸기"
                    disabled={busy === key}
                    onClick={() => setFlipped((f) => toggle(f, key))}
                  >
                    <Icon name="arrow-left-right" size={15} />
                  </button>
                  <button className="btn small ghost" disabled={busy === key} onClick={dismiss}>
                    다른 것
                  </button>
                  <button className="btn small" disabled={busy === key} onClick={merge}>
                    <Icon name="git-merge" size={14} />
                    합치기
                  </button>
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {pairs.length > SIMILAR_TOP && (
        <button className="btn small ghost similar-more" aria-expanded={all} onClick={() => setAll(!all)}>
          <Icon name={all ? "chevron-down" : "chevron-right"} size={14} />
          {all ? "접기" : `더 보기 (${pairs.length - SIMILAR_TOP})`}
        </button>
      )}
    </section>
  );
}

function SimilarSide({ e }: { e: SimilarPair["a"] }) {
  return (
    <a className="similar-side" href={`#/entity/${e.id}`} title={`${KIND_LABEL[e.kind] ?? e.kind} · 메모리 ${e.count}개`}>
      <KindIcon kind={e.kind} size={14} />
      <b>{e.name}</b>
      <span className="faint small">
        {KIND_LABEL[e.kind] ?? e.kind} · {e.count}
      </span>
    </a>
  );
}

// --------------------------------------------------------------- entity

export function EntityPage({ id }: { id: number }) {
  const { data, error, loading } = useData(() => api.entity(id), [id]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", kind: "concept", description: "" });
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (data) setForm({ name: data.entity.name, kind: data.entity.kind, description: data.entity.description });
  }, [data]);

  const groups = useMemo(() => {
    const m = new Map<string, NonNullable<typeof data>["memories"]>();
    for (const e of data?.memories ?? []) {
      const key = e.scope === "project" ? e.project_name ?? "프로젝트" : SCOPE_LABEL[e.scope];
      m.set(key, [...(m.get(key) ?? []), e]);
    }
    // Current memories first, history (superseded / expired) at the bottom of each group.
    return [...m.entries()].map(([k, list]) => [k, [...list].sort((a, b) => Number(isHistory(a)) - Number(isHistory(b)))] as const);
  }, [data]);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <SkeletonPage />;
  const n = data.entity;
  const historyCount = data.memories.filter(isHistory).length;

  const save = () =>
    act(() => api.updateEntity(n.id, form), { success: "저장했습니다" }).then((r) => {
      if (r !== undefined) setEditing(false);
    });

  return (
    <article className="page narrow entity-page">
      <PageHeader
        busy={loading}
        crumbs={
          <>
            <a href="#/entities">엔티티</a>
            <span className="faint">/</span>
            <a href={`#/entities?kind=${encodeURIComponent(n.kind)}`}>{KIND_LABEL[n.kind] ?? n.kind}</a>
          </>
        }
        title={
          <>
            <span className="entity-title-icon" title={KIND_LABEL[n.kind] ?? n.kind}>
              <KindIcon kind={n.kind} size={20} />
            </span>
            {n.name}
          </>
        }
        lead={n.description || undefined}
        actions={
          <>
            <button className={`btn${editing ? " active" : ""}`} aria-pressed={editing} onClick={() => setEditing(!editing)}>
              <Icon name="pencil" />
              편집
            </button>
            <button className="btn" onClick={() => setMerging(true)}>
              <Icon name="git-merge" />
              합치기
            </button>
            <button
              className="btn danger ghost"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: `"${n.name}" 엔티티를 지울까요?`,
                  body: <p>메모리는 그대로 두고 이 엔티티와의 연결만 빠집니다. 변경 이력에서 되돌릴 수 있습니다.</p>,
                  confirmLabel: "삭제",
                  danger: true,
                });
                if (ok && (await act(() => api.deleteEntity(n.id), { success: `"${n.name}" 엔티티를 지웠습니다` })) !== undefined) go("/entities");
              }}
            >
              <Icon name="trash-2" />
              삭제
            </button>
          </>
        }
      >
        {n.aliases && n.aliases.length > 0 && (
          <div className="entity-aliases">
            <span className="faint small">별칭</span>
            {n.aliases.map((a) => (
              <span key={a} className="alias-chip">
                {a}
              </span>
            ))}
          </div>
        )}
      </PageHeader>

      {editing && (
        <form
          className="form card entity-edit"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
        >
          <div className="form-row">
            <label className="grow">
              이름
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
            </label>
            <label>
              종류
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            설명
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <div className="row">
            <button type="submit" className="btn primary">
              저장
            </button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              취소
            </button>
          </div>
        </form>
      )}

      <div className="section-head">
        <h2>메모리</h2>
        <span className="count">
          {data.memories.length}
          {historyCount > 0 ? ` · 이력 ${historyCount}` : ""}
        </span>
        <a className="btn small ghost" href={`#/graph?focus=n${n.id}`}>
          <Icon name="share-2" size={14} />
          그래프에서 보기
        </a>
      </div>
      {data.memories.length === 0 && (
        <Empty icon="sticky-note" title="이 엔티티를 다루는 메모리가 없습니다">
          메모리 화면의 "연결"에서 엔티티를 붙일 수 있습니다.
        </Empty>
      )}
      {groups.map(([name, list]) => (
        <section key={name} className="entity-group">
          <h3 className="entity-group-title">
            {name} <span className="count">{list.length}</span>
          </h3>
          <div className="list">
            {list.map((e) => (
              <a key={e.id} className={`list-row entity-mem${isHistory(e) ? " is-history" : ""}`} href={`#/e/${e.id}`}>
                <div className="entity-mem-line">
                  <CategoryBadge category={e.category} />
                  {e.pinned && (
                    <span className="entity-mem-pin" title="고정됨" aria-label="고정됨">
                      <Icon name="pin" size={13} />
                    </span>
                  )}
                  <span className="entity-mem-title">{e.title}</span>
                  <StateBadge e={e} linked={false} />
                  <span className="faint small entity-mem-time">
                    <Time iso={e.updated_at} />
                  </span>
                </div>
              </a>
            ))}
          </div>
        </section>
      ))}

      <GraphHistory entityId={n.id} title="변경 이력" />

      <MergePicker entity={n} memoryCount={data.memories.length} open={merging} onClose={() => setMerging(false)} />
    </article>
  );
}

/** Dialog that picks the entity to merge into; palette-style list with ↑↓ / Enter. */
function MergePicker({ entity, memoryCount, open, onClose }: { entity: Entity; memoryCount: number; open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const candidates = useData(() => (open ? api.entities(term || undefined) : Promise.resolve([] as Entity[])), [term, open]);
  const items = (candidates.data ?? []).filter((c) => c.id !== entity.id).slice(0, 30);

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 150);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setSel(0), [term]);
  useEffect(() => {
    if (!open) {
      setQ("");
      setTerm("");
    }
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = async (c: Entity) => {
    const ok = await confirmDialog({
      title: "엔티티 합치기",
      body: (
        <>
          <p>
            <b>{entity.name}</b>을(를) <b>{c.name}</b>로 합칩니다. 옛 이름은 별칭으로 남아 같은 엔티티로 찾아집니다.
          </p>
          <p>
            "{entity.name}"에 연결된 메모리 {memoryCount}개가 "{c.name}"로 옮겨지고, "{entity.name}" 엔티티는 사라집니다. 변경 이력에서 되돌릴 수 있습니다.
          </p>
        </>
      ),
      confirmLabel: "합치기",
    });
    if (!ok) return;
    const r = await act(() => api.mergeEntity(entity.id, c.id), { success: `"${entity.name}"을(를) "${c.name}"로 합쳤습니다` });
    if (r !== undefined) {
      onClose();
      go(`/entity/${c.id}`);
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
      const c = items[Math.min(sel, items.length - 1)];
      if (c) choose(c);
    }
  };

  const listId = `merge-pick-${entity.id}`;
  return (
    <Dialog open={open} onClose={onClose} title={`"${entity.name}"을(를) 어디로 합칠까요?`} className="merge-dialog">
      <p className="merge-hint">고른 엔티티로 메모리 연결을 옮기고, "{entity.name}"은(는) 그 엔티티의 별칭이 됩니다.</p>
      <div className="merge-box">
        <div className="palette-input">
          <Icon name="search" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="합칠 대상 검색"
            aria-label="합칠 대상 검색"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={items.length ? `${listId}-${sel}` : undefined}
            autoComplete="off"
            spellCheck={false}
            data-autofocus=""
          />
          {candidates.loading && <div className="palette-loading" />}
        </div>
        <div className="palette-list" id={listId} role="listbox" ref={listRef} aria-label="합칠 대상">
          {!term && items.length > 0 && <div className="palette-group">메모리가 많은 엔티티</div>}
          {items.map((c, i) => (
            <div
              key={c.id}
              id={`${listId}-${i}`}
              data-i={i}
              role="option"
              aria-selected={i === sel}
              className="palette-item"
              onMouseMove={() => setSel(i)}
              onClick={() => choose(c)}
            >
              <KindIcon kind={c.kind} />
              <span className="palette-label">{c.name}</span>
              <span className="hint">
                {KIND_LABEL[c.kind] ?? c.kind} · 메모리 {c.count ?? 0}
              </span>
            </div>
          ))}
          {!candidates.loading && candidates.data && items.length === 0 && <div className="palette-empty">일치하는 엔티티가 없습니다</div>}
        </div>
        <div className="palette-foot">↑↓ 이동 · ↵ 합치기 · esc 닫기</div>
      </div>
    </Dialog>
  );
}
