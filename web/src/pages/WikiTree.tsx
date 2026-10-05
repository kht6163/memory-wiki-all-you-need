import { useMemo, useState, type CSSProperties } from "react";
import { api, type TreeSuggestion, type WikiPage } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { SOURCE_LABEL, Time, act, readLocal, useData, writeLocal } from "../lib.tsx";
import { ancestors, buildTree, descendantIds, filterTree, flatten, parentIds } from "../wiki-tree.ts";

// Page tree of a wiki (ADR-0036): the home list, the rail on a page, the
// parent picker, and the one-time "group these pages" suggestions.

const pageHref = (scope: number, slug: string) => `#/w/${scope}/${encodeURIComponent(slug)}`;
/** First prose line of a page (no heading, table or code fence; links shown as their text). */
function firstLine(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("```"));
  return (line ?? "").replace(/\s*\[#\d+\]/g, "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b ?? a).replace(/[*_`>]/g, "").slice(0, 140);
}

/** Collapsed node ids for one wiki, kept per viewer. */
function useClosed(scope: number, initial: () => Set<number>) {
  const key = `wiki-tree-closed:${scope}`;
  const [closed, setClosed] = useState<Set<number>>(() => {
    const raw = readLocal(key);
    if (raw === null) return initial();
    try {
      return new Set((JSON.parse(raw) as unknown[]).map(Number).filter(Number.isFinite));
    } catch {
      return initial();
    }
  });
  const save = (next: Set<number>) => {
    setClosed(next);
    writeLocal(key, JSON.stringify([...next]));
  };
  return [closed, save] as const;
}

function Toggle({ open, count, onClick, title }: { open: boolean; count: number; onClick: () => void; title: string }) {
  if (!count) return <span className="tree-toggle-spacer" aria-hidden />;
  return (
    <button
      type="button"
      className="tree-toggle"
      aria-expanded={open}
      aria-label={`${title} ${open ? "접기" : "펼치기"} (하위 ${count}개)`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
    </button>
  );
}

/** Wiki home: every page except overview as a collapsible tree; a filter shows matches where they live. */
export function WikiTreeList({ scope, pages, filter }: { scope: number; pages: WikiPage[]; filter: string }) {
  const tree = useMemo(() => buildTree(pages), [pages]);
  const [closed, setClosed] = useClosed(scope, () => new Set());
  const q = filter.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? filterTree(tree, (p) => p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q) || p.body.toLowerCase().includes(q)) : tree),
    [tree, q],
  );
  const rows = flatten(shown, closed, Boolean(q));
  const all = parentIds(tree);
  const toggle = (id: number) => {
    const next = new Set(closed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setClosed(next);
  };
  return (
    <>
      {all.size > 0 && !q && (
        <div className="tree-tools">
          <button type="button" className="btn ghost small" onClick={() => setClosed(new Set())}>
            모두 펼치기
          </button>
          <button type="button" className="btn ghost small" onClick={() => setClosed(new Set(all))}>
            모두 접기
          </button>
        </div>
      )}
      <ul className="list wiki-tree" aria-label="위키 페이지">
        {rows.map(({ page: p, depth, childCount, open }) => {
          const line = firstLine(p.body);
          return (
            <li key={p.id} className="wiki-tree-item" style={{ "--depth": depth } as CSSProperties}>
              {/* While filtering every match is shown open: no toggles (they would change nothing visible). */}
              {q ? <span className="tree-toggle-spacer" aria-hidden /> : <Toggle open={open} count={childCount} title={p.title} onClick={() => toggle(p.id)} />}
              <a className="list-row wiki-row" href={pageHref(scope, p.slug)}>
                <div className="wiki-row-head">
                  {p.locked && (
                    <span className="wiki-row-lock" title="잠김 — LLM과 에이전트가 수정하지 않음" role="img" aria-label="잠김">
                      <Icon name="lock" size={13} />
                    </span>
                  )}
                  <span className="wiki-row-title">{p.title}</span>
                  {childCount > 0 && !open && <span className="count">{childCount}</span>}
                  <span className="wiki-row-slug mono">{p.slug}</span>
                </div>
                {line && <div className="wiki-row-line">{line}</div>}
                <div className="wiki-meta">
                  <span className={`dot src-${p.source}`} aria-hidden />
                  {SOURCE_LABEL[p.source]} · <Time iso={p.updated_at} />
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Page view: the wiki's tree with the way to this page open, the rest collapsed until opened. */
export function WikiTreeRail({ scope, pages, current, className }: { scope: number; pages: WikiPage[]; current: WikiPage; className?: string }) {
  const tree = useMemo(() => buildTree(pages.filter((p) => p.slug !== "overview" || p.id === current.id)), [pages, current.id]);
  const path = useMemo(() => new Set(ancestors(pages, current.id).map((p) => p.id)), [pages, current.id]);
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const [shut, setShut] = useState<Set<number>>(new Set());
  // Collapsed: every parent except the path to this page and this page, unless opened by hand.
  const closed = useMemo(() => {
    const c = new Set<number>();
    for (const id of parentIds(tree)) if (!(path.has(id) || id === current.id || opened.has(id)) || shut.has(id)) c.add(id);
    return c;
  }, [tree, path, current.id, opened, shut]);
  const rows = flatten(tree, closed);
  // Always render the wrapper: on wide screens it is a grid column, and a missing one would shift the article into it.
  if (pages.length < 2) return <nav className={`wiki-tree-rail${className ? ` ${className}` : ""}`} aria-hidden />;
  return (
    <nav className={`wiki-tree-rail${className ? ` ${className}` : ""}`} aria-label="페이지 트리">
      <div className="toc-title">
        페이지 <span className="count">{pages.length}</span>
      </div>
      <ul>
        {rows.map(({ page: p, depth, childCount, open }) => (
          <li key={p.id} style={{ "--depth": depth } as CSSProperties}>
            <Toggle
              open={open}
              count={childCount}
              title={p.title}
              onClick={() => {
                const o = new Set(opened);
                const s = new Set(shut);
                if (open) {
                  o.delete(p.id);
                  s.add(p.id);
                } else {
                  o.add(p.id);
                  s.delete(p.id);
                }
                setOpened(o);
                setShut(s);
              }}
            />
            <a href={pageHref(scope, p.slug)} aria-current={p.id === current.id ? "page" : undefined} className={p.id === current.id ? "active" : undefined}>
              {p.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Pages directly under this one, shown at the end of the page. */
export function ChildPages({ scope, pages, current }: { scope: number; pages: WikiPage[]; current: WikiPage }) {
  const kids = pages.filter((p) => p.parent_id === current.id);
  return (
    <section className="wiki-children" aria-label="하위 페이지">
      <div className="section-head">
        <h2>하위 페이지</h2>
        <span className="count">{kids.length}</span>
        {!current.deleted_at && (
          <a className="btn small" href={`#/w/${scope}/~new?parent=${current.id}`}>
            <Icon name="plus" size={14} />
            하위 페이지 만들기
          </a>
        )}
      </div>
      {kids.length > 0 && (
        <ul className="wiki-children-list">
          {kids.map((k) => (
            <li key={k.id}>
              <a href={pageHref(scope, k.slug)}>{k.title}</a>
              {firstLine(k.body) && <span className="faint small"> — {firstLine(k.body).slice(0, 120)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Breadcrumb trail: wiki › ancestors › (current, as plain text). */
export function TreeCrumbs({ scope, name, pages, current }: { scope: number; name: string; pages: WikiPage[]; current?: WikiPage }) {
  const up = current ? ancestors(pages, current.id) : [];
  return (
    <>
      <a href={`#/w/${scope}`}>{name} 위키</a>
      {up.map((p) => (
        <span key={p.id}>
          {" "}
          › <a href={pageHref(scope, p.slug)}>{p.title}</a>
        </span>
      ))}
    </>
  );
}

/** Parent picker for the edit form: every live page of the wiki except this one and its descendants. */
export function ParentSelect({ pages, self, value, onChange }: { pages: WikiPage[]; self?: WikiPage | null; value: number | null; onChange: (v: number | null) => void }) {
  const banned = useMemo(() => (self ? new Set([self.id, ...descendantIds(pages, self.id)]) : new Set<number>()), [pages, self]);
  const rows = useMemo(() => flatten(buildTree(pages.filter((p) => !banned.has(p.id))), new Set(), true), [pages, banned]);
  return (
    <label>
      상위 페이지
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">(최상위)</option>
        {/* A parent in the trash (or gone) is not an option: show it so "(최상위)" stays a real change. */}
        {value != null && !rows.some((r) => r.page.id === value) && (
          <option value={value} disabled>
            (휴지통에 있거나 없는 페이지)
          </option>
        )}
        {rows.map(({ page: p, depth }) => (
          <option key={p.id} value={p.id}>
            {`${"  ".repeat(depth)}${depth ? "└ " : ""}${p.title}`}
          </option>
        ))}
      </select>
    </label>
  );
}

const REASON: Record<TreeSuggestion["reason"], string> = { index: "목록 페이지가 링크함", continuation: "이어지는 페이지" };

/**
 * One-time help for a flat wiki: suggested groupings, applied only when the
 * person says so (G-066). "숨기기" hides this exact set for this viewer; a new
 * suggestion brings the card back.
 */
export function TreeSuggestCard({ scope, version, onApplied }: { scope: number; version: string; onApplied: () => void }) {
  const { data } = useData(() => api.wikiTreeSuggest(scope || null), [scope, version]);
  const key = `wiki-tree-suggest-hidden:${scope}`;
  const sig = (data ?? []).map((s) => `${s.page.id}>${s.parent.id}`).join(",");
  const [hidden, setHidden] = useState(() => readLocal(key));
  const [off, setOff] = useState<Set<number>>(new Set());
  const groups = useMemo(() => {
    const m = new Map<number, { parent: TreeSuggestion["parent"]; items: TreeSuggestion[] }>();
    for (const s of data ?? []) {
      if (!m.has(s.parent.id)) m.set(s.parent.id, { parent: s.parent, items: [] });
      m.get(s.parent.id)!.items.push(s);
    }
    return [...m.values()];
  }, [data]);
  if (!data?.length || hidden === sig) return null;
  const chosen = data.filter((s) => !off.has(s.page.id));
  const apply = () =>
    act(() => api.applyWikiTree(chosen.map((s) => ({ id: s.page.id, parent_id: s.parent.id }))), { success: `${chosen.length}개 페이지를 묶었습니다` }).then((r) => {
      if (r !== undefined) onApplied();
    });
  return (
    <section className="card tree-suggest" aria-label="페이지 묶음 제안">
      <div className="tree-suggest-head">
        <Icon name="folder" size={16} />
        <b>페이지를 트리로 묶을까요?</b>
        <span className="faint small">링크와 이름으로 찾은 제안입니다. 적용하기 전에는 아무것도 바뀌지 않습니다.</span>
      </div>
      {groups.map((g) => (
        <div key={g.parent.id} className="tree-suggest-group">
          <div className="small">
            <b>{g.parent.title}</b> 아래로
          </div>
          {g.items.map((s) => (
            <label key={s.page.id} className="check">
              <input
                type="checkbox"
                checked={!off.has(s.page.id)}
                onChange={(e) => {
                  const next = new Set(off);
                  if (e.target.checked) next.delete(s.page.id);
                  else next.add(s.page.id);
                  setOff(next);
                }}
              />
              {s.page.title} <span className="faint small">· {REASON[s.reason]}</span>
            </label>
          ))}
        </div>
      ))}
      <div className="tree-suggest-actions">
        <button className="btn primary small" disabled={!chosen.length} onClick={apply}>
          {chosen.length}개 적용
        </button>
        <button
          className="btn ghost small"
          onClick={() => {
            writeLocal(key, sig);
            setHidden(sig);
          }}
        >
          숨기기
        </button>
      </div>
    </section>
  );
}

