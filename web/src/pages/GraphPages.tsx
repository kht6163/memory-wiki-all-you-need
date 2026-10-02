import { useEffect, useMemo, useState } from "react";
import { api, type Entity, type EntryLink, type LinkType } from "../api.ts";
import { CategoryBadge, Empty, ErrorBox, SCOPE_LABEL, Time, act, go, useData } from "../lib.tsx";

export const LINK_LABEL: Record<LinkType, { out: string; in: string; name: string }> = {
  because: { out: "이유", in: "이것 때문에 생긴 것", name: "이유 (because)" },
  depends_on: { out: "전제", in: "이것을 전제로 하는 것", name: "전제 (depends_on)" },
  supersedes: { out: "대체함", in: "대체됨 (더 새 메모리)", name: "대체 (supersedes)" },
  related: { out: "관련", in: "관련", name: "관련 (related)" },
};
export const LINK_TYPES = Object.keys(LINK_LABEL) as LinkType[];
export const KIND_LABEL: Record<string, string> = { tech: "기술", service: "서비스", tool: "도구", file: "파일", concept: "개념", person: "사람" };
const KINDS = Object.keys(KIND_LABEL);

// -------------------------------------------------------------- pieces

export function EntityChips({ entities }: { entities: Entity[] }) {
  if (!entities.length) return null;
  return (
    <div className="entity-chips">
      {entities.map((n) => (
        <a key={n.id} className="entity-chip" href={`#/entity/${n.id}`} title={KIND_LABEL[n.kind] ?? n.kind}>
          {n.name}
        </a>
      ))}
    </div>
  );
}

export function LinkList({ links, onRemove }: { links: EntryLink[]; onRemove?: (l: EntryLink) => void }) {
  if (!links.length) return null;
  return (
    <ul className="link-list">
      {links.map((l) => (
        <li key={`${l.from_id}-${l.to_id}-${l.type}`}>
          <span className={`link-type lt-${l.type}`}>{LINK_LABEL[l.type][l.dir]}</span> <a href={`#/e/${l.other.id}`}>{l.other.title}</a>{" "}
          <span className="muted small">#{l.other.id}</span>
          {onRemove && (
            <button className="btn small ghost" title="관계 삭제" onClick={() => onRemove(l)}>
              ✕
            </button>
          )}
        </li>
      ))}
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

  useEffect(() => {
    const term = to.trim();
    if (!term || /^#?\d+$/.test(term)) return setPick([]);
    const t = setTimeout(() => api.search(term).then((r) => setPick(r.filter((e) => e.id !== entryId).slice(0, 6))), 250);
    return () => clearTimeout(t);
  }, [to, entryId]);

  const addEntity = () => {
    const name = entityText.trim();
    if (!name) return;
    act(() => api.updateEntry(entryId, { entities: [...entities.map((n) => n.name), name] })).then(() => setEntityText(""));
  };
  const removeEntity = (n: Entity) => act(() => api.updateEntry(entryId, { entities: entities.filter((x) => x.id !== n.id).map((x) => x.name) }));
  const addLink = (target: number) => act(() => api.addLink(entryId, target, type)).then(() => setTo(""));
  // An incoming link is stored on the other memory, so remove it there.
  const removeLink = (l: EntryLink) => act(() => api.removeLink(l.from_id, l.to_id, l.type));

  return (
    <section className="entry-graph">
      <h2>
        연결{" "}
        <a className="small muted" href={`#/graph?${projectId ? `project=${projectId}&` : ""}focus=m${entryId}`}>
          그래프에서 보기
        </a>
      </h2>
      <div className="entity-chips">
        {entities.map((n) => (
          <span key={n.id} className="entity-chip">
            <a href={`#/entity/${n.id}`}>{n.name}</a>
            {editable && (
              <button className="chip-x" title="엔티티 빼기" onClick={() => removeEntity(n)}>
                ×
              </button>
            )}
          </span>
        ))}
        {!entities.length && <span className="muted small">엔티티 없음</span>}
        {editable && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              addEntity();
            }}
          >
            <input value={entityText} onChange={(e) => setEntityText(e.target.value)} placeholder="+ 엔티티 (예: PostgreSQL)" />
          </form>
        )}
      </div>
      <LinkList links={links} onRemove={editable ? removeLink : undefined} />
      {editable && (
        <form
          className="inline-form link-form"
          onSubmit={(e) => {
            e.preventDefault();
            const m = to.trim().match(/^#?(\d+)$/);
            if (m) addLink(Number(m[1]));
          }}
        >
          <select value={type} onChange={(e) => setType(e.target.value as LinkType)}>
            {LINK_TYPES.map((t) => (
              <option key={t} value={t}>
                {LINK_LABEL[t].name}
              </option>
            ))}
          </select>
          <div className="link-pick">
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="관계 맺을 메모리: #id 또는 검색어" />
            {pick.length > 0 && (
              <div className="pick-list">
                {pick.map((p) => (
                  <button type="button" key={p.id} onClick={() => addLink(p.id)}>
                    #{p.id} {p.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

// ------------------------------------------------------------- entities

export function EntitiesPage() {
  const [q, setQ] = useState("");
  const list = useData(() => api.entities(q || undefined), [q]);
  return (
    <article className="page">
      <header className="page-head">
        <h1>엔티티</h1>
        <p className="lead">메모리가 다루는 기술·서비스·도구·파일·개념입니다. 같은 것을 가리키는 엔티티는 합칠 수 있습니다(예전 이름은 별칭으로 남아 다음 정리에서도 같은 엔티티로 묶입니다).</p>
        <div className="toolbar">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="엔티티 검색" />
          <a className="btn" href="#/graph">
            그래프
          </a>
        </div>
      </header>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 && <Empty>엔티티가 없습니다. 턴이 정리되거나 그래프를 붙이면 생깁니다.</Empty>}
      <div className="entity-grid">
        {list.data?.map((n) => (
          <a key={n.id} className="entity-card" href={`#/entity/${n.id}`}>
            <b>{n.name}</b>
            <span className="muted small">
              {KIND_LABEL[n.kind] ?? n.kind} · {n.count}
            </span>
          </a>
        ))}
      </div>
    </article>
  );
}

export function EntityPage({ id }: { id: number }) {
  const { data, error } = useData(() => api.entity(id), [id]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", kind: "concept", description: "" });
  const [mergeQ, setMergeQ] = useState("");
  const candidates = useData(() => (mergeQ.trim() ? api.entities(mergeQ.trim()) : Promise.resolve([])), [mergeQ]);

  useEffect(() => {
    if (data) setForm({ name: data.entity.name, kind: data.entity.kind, description: data.entity.description });
  }, [data]);

  const groups = useMemo(() => {
    const m = new Map<string, NonNullable<typeof data>["memories"]>();
    for (const e of data?.memories ?? []) {
      const key = e.scope === "project" ? e.project_name ?? "프로젝트" : SCOPE_LABEL[e.scope];
      m.set(key, [...(m.get(key) ?? []), e]);
    }
    return [...m.entries()];
  }, [data]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const n = data.entity;

  return (
    <article className="page narrow">
      <header className="page-head">
        <div className="crumbs">
          <a href="#/entities">엔티티</a> / {KIND_LABEL[n.kind] ?? n.kind}
        </div>
        <h1>{n.name}</h1>
        {n.description && <p className="lead">{n.description}</p>}
        {n.aliases && n.aliases.length > 0 && <div className="muted small">별칭: {n.aliases.join(", ")}</div>}
        <div className="toolbar">
          <button className="btn" onClick={() => setEditing(!editing)}>
            편집
          </button>
          <button
            className="btn danger ghost"
            onClick={() => confirm(`"${n.name}" 엔티티를 지울까요? (메모리는 그대로, 연결만 빠집니다)`) && act(() => api.deleteEntity(n.id)).then(() => go("/entities"))}
          >
            삭제
          </button>
        </div>
      </header>
      {editing && (
        <div className="form">
          <div className="form-row">
            <label className="grow">
              이름
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
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
            <button className="btn primary" onClick={() => act(() => api.updateEntity(n.id, form)).then(() => setEditing(false))}>
              저장
            </button>
          </div>
          <label>
            다른 엔티티로 합치기
            <input value={mergeQ} onChange={(e) => setMergeQ(e.target.value)} placeholder="합칠 대상 검색" />
          </label>
          <div className="row">
            {candidates.data
              ?.filter((c) => c.id !== n.id)
              .slice(0, 8)
              .map((c) => (
                <button
                  key={c.id}
                  className="btn small"
                  onClick={() => confirm(`"${n.name}"을(를) "${c.name}"(으)로 합칠까요?`) && act(() => api.mergeEntity(n.id, c.id)).then(() => go(`/entity/${c.id}`))}
                >
                  → {c.name} ({c.count})
                </button>
              ))}
          </div>
        </div>
      )}
      <h2>
        메모리 {data.memories.length}개{" "}
        <a className="small muted" href="#/graph">
          그래프
        </a>
      </h2>
      {groups.map(([name, list]) => (
        <section key={name}>
          <h3>{name}</h3>
          <ul className="plain-list">
            {list.map((e) => (
              <li key={e.id}>
                <CategoryBadge category={e.category} /> <a href={`#/e/${e.id}`}>{e.title}</a>{" "}
                <span className="muted small">
                  <Time iso={e.updated_at} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}
