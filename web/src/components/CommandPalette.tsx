import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, type Entry, type Project, type SessionHit, type WikiHit } from "../api.ts";
import { CATEGORY_LABEL, MOD_LABEL, SCOPE_LABEL, THEME_ICON, THEME_LABEL, applyTheme, go, readLocal, writeLocal, type Theme } from "../lib.tsx";
import { Icon, type IconName } from "./Icon.tsx";

// Hand-rolled ⌘K palette on the native <dialog> (top layer, inert background, Esc for free).

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  /** Hash path without "#", e.g. "/w/0". Items with href are remembered under 최근. */
  href?: string;
  run?: () => void;
  keywords?: string;
}

/** Every static route of the App router. */
export const ROUTES: PaletteItem[] = [
  { id: "r:home", label: "홈", icon: "home", href: "/", keywords: "home 대시보드" },
  { id: "r:wiki", label: "전역 위키", icon: "book-open", href: "/w/0", keywords: "wiki" },
  { id: "r:standing", label: "고정 지시", icon: "pin", href: "/standing", keywords: "standing" },
  { id: "r:user", label: "사용자 프로필", icon: "user", href: "/user", keywords: "user profile" },
  { id: "r:global", label: "전역 메모리", icon: "globe", href: "/global", keywords: "memory global" },
  { id: "r:graph", label: "그래프", icon: "share-2", href: "/graph", keywords: "graph" },
  { id: "r:entities", label: "엔티티", icon: "tag", href: "/entities", keywords: "entity" },
  { id: "r:projects", label: "프로젝트", icon: "folder", href: "/projects", keywords: "project" },
  { id: "r:review", label: "메모리 점검", icon: "check-check", href: "/review", keywords: "review" },
  { id: "r:activity", label: "활동", icon: "activity", href: "/activity", keywords: "activity" },
  { id: "r:turns", label: "턴 기록", icon: "messages-square", href: "/turns", keywords: "turns" },
  { id: "r:wiki-jobs", label: "위키 작업", icon: "file-cog", href: "/wiki-jobs", keywords: "jobs" },
  { id: "r:preview", label: "주입 미리보기", icon: "eye", href: "/preview", keywords: "preview inject" },
  { id: "r:debug", label: "디버그 모드", icon: "file-text", href: "/debug", keywords: "debug log 로그 기록" },
  { id: "r:trash", label: "휴지통", icon: "trash-2", href: "/trash", keywords: "trash" },
  { id: "r:search", label: "검색", icon: "search", href: "/search", keywords: "search" },
];

// ------------------------------------------------------------ matching

const CHOSUNG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const chosung = (s: string) =>
  [...s].map((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 0xac00 && c <= 0xd7a3 ? CHOSUNG[Math.floor((c - 0xac00) / 588)] : ch;
  }).join("");
const isChosungOnly = (q: string) => [...q].every((ch) => ch === " " || (ch >= "ㄱ" && ch <= "ㅎ"));

/** Lower is better; -1 = no match. prefix 0, word start 1, contains 2, keyword 3. */
function rank(item: PaletteItem, q: string): number {
  const needle = q.toLowerCase();
  const label = item.label.toLowerCase();
  const hay = isChosungOnly(q) ? chosung(label) : label;
  const i = hay.indexOf(needle);
  if (i === 0) return 0;
  if (i > 0) return /[\s·/(\-_]/.test(hay[i - 1]) ? 1 : 2;
  const kw = `${item.keywords ?? ""} ${item.hint ?? ""}`.toLowerCase();
  if ((isChosungOnly(q) ? chosung(kw) : kw).includes(needle)) return 3;
  return -1;
}

function filterRank(items: PaletteItem[], q: string): PaletteItem[] {
  if (!q) return items;
  return items
    .map((it, i) => ({ it, r: rank(it, q), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.it);
}

// ------------------------------------------------------------- recents

const RECENT_KEY = "palette:recent";
function readRecent(): PaletteItem[] {
  try {
    const v = JSON.parse(readLocal(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? (v as PaletteItem[]).filter((x) => x && typeof x.href === "string") : [];
  } catch {
    return [];
  }
}
function pushRecent(it: PaletteItem) {
  if (!it.href) return;
  const keep = { id: it.id, label: it.label, hint: it.hint, icon: it.icon, href: it.href };
  writeLocal(RECENT_KEY, JSON.stringify([keep, ...readRecent().filter((x) => x.id !== it.id)].slice(0, 10)));
}

// ------------------------------------------------------------ component

interface Remote {
  q: string;
  entries: Entry[];
  wiki: WikiHit[];
  sessions: SessionHit[];
}

export function CommandPalette({
  open,
  onClose,
  projects,
  projectId,
  newMemoryHref,
}: {
  open: boolean;
  onClose: () => void;
  projects: Project[] | undefined;
  /** Project of the current route, used by the 작업 commands. */
  projectId?: number;
  newMemoryHref: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [remote, setRemote] = useState<Remote | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<PaletteItem[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQ("");
      setSel(0);
      setRemote(null);
      setRecent(readRecent());
      d.showModal();
      input.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  // Async search: ≥2 chars, 150 ms debounce, only the latest response wins.
  const term = q.trim();
  useEffect(() => {
    if (term.length < 2) {
      seq.current++;
      setRemote(null);
      setLoading(false);
      return;
    }
    const t = setTimeout(() => {
      const n = ++seq.current;
      setLoading(true);
      Promise.all([api.search(term).catch(() => []), api.wikiSearch(term).catch(() => []), api.sessionSearch(term).catch(() => [])])
        .then(([entries, wiki, sessions]) => {
          if (n === seq.current) setRemote({ q: term, entries, wiki, sessions });
        })
        .finally(() => {
          if (n === seq.current) setLoading(false);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [term]);

  const groups = useMemo(() => {
    const pid = projectId;
    const scopeQ = pid ? `?project=${pid}` : "";
    const actions: PaletteItem[] = [
      { id: "a:new-memory", label: "새 메모리", icon: "plus", href: newMemoryHref, keywords: "new memory create c" },
      { id: "a:new-wiki", label: "새 위키 페이지", icon: "file-text", href: `/w/${pid ?? 0}/~new`, keywords: "new wiki page" },
      { id: "a:compose", label: "턴 기록으로 위키 정리", icon: "book-open", href: `/w/${pid ?? 0}/~compose`, keywords: "compose wiki" },
      { id: "a:review", label: "메모리 점검", hint: pid ? "현재 프로젝트" : "전역·사용자", icon: "check-check", href: `/review${scopeQ}`, keywords: "review" },
      { id: "a:preview", label: "주입 미리보기", hint: pid ? "현재 프로젝트" : undefined, icon: "eye", href: `/preview${scopeQ}`, keywords: "preview" },
      ...(["system", "light", "dark"] as Theme[]).map((t) => ({
        id: `a:theme-${t}`,
        label: `테마: ${THEME_LABEL[t]}`,
        icon: THEME_ICON[t],
        run: () => applyTheme(t),
        keywords: `theme ${t} 테마`,
      })),
    ];
    const projectItems: PaletteItem[] = (projects ?? []).flatMap((p) => [
      { id: `p:w${p.id}`, label: `${p.name} 위키`, hint: p.key, icon: "book-open" as IconName, href: `/w/${p.id}`, keywords: p.key },
      { id: `p:m${p.id}`, label: `${p.name} 메모리`, hint: p.key, icon: "sticky-note" as IconName, href: `/p/${p.id}`, keywords: p.key },
    ]);
    const out: { name: string; items: PaletteItem[] }[] = [];
    if (!term) out.push({ name: "최근", items: recent.slice(0, 6) });
    out.push({ name: "이동", items: filterRank(ROUTES, term) });
    out.push({ name: "프로젝트", items: filterRank(projectItems, term).slice(0, term ? 10 : 8) });
    out.push({ name: "작업", items: filterRank(actions, term) });
    if (remote && remote.q === term) {
      out.push({
        name: "메모리",
        items: remote.entries.slice(0, 5).map((e) => ({
          id: `e:${e.id}`,
          label: e.title,
          hint: `${CATEGORY_LABEL[e.category] ?? e.category} · ${e.scope === "project" ? projects?.find((p) => p.id === e.project_id)?.name ?? "프로젝트" : SCOPE_LABEL[e.scope]}`,
          icon: "sticky-note" as IconName,
          href: `/e/${e.id}`,
        })),
      });
      out.push({
        name: "위키",
        items: remote.wiki.slice(0, 5).map((w) => ({
          id: `w:${w.id}`,
          label: w.title,
          hint: w.slug,
          icon: "file-text" as IconName,
          href: `/w/${w.project_id ?? 0}/${encodeURIComponent(w.slug)}`,
        })),
      });
      out.push({
        name: "대화",
        items: remote.sessions.slice(0, 5).map((s) => ({
          id: `t:${s.id}`,
          label: s.snippet.replace(/\s+/g, " ").slice(0, 80) || `턴 #${s.id}`,
          hint: `턴 #${s.id} · ${s.project_name ?? "프로젝트 없음"}`,
          icon: "messages-square" as IconName,
          href: `/turns/${s.id}`,
        })),
      });
    }
    if (term) out.push({ name: "", items: [{ id: "s:all", label: `'${term}' 전체 결과 보기`, icon: "arrow-right", href: `/search?q=${encodeURIComponent(term)}` }] });
    return out.filter((g) => g.items.length);
  }, [term, recent, projects, projectId, newMemoryHref, remote]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const cur = Math.min(sel, Math.max(0, flat.length - 1));

  useEffect(() => setSel(0), [term]);
  useEffect(() => {
    listRef.current?.querySelector(`#pi-${cur}`)?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  const close = () => ref.current?.close();
  const runItem = (it: PaletteItem | undefined) => {
    if (!it) return;
    close();
    if (it.href !== undefined) {
      pushRecent(it);
      go(it.href);
    } else it.run?.();
  };
  const fullSearch = () => {
    if (!term) return;
    close();
    go(`/search?q=${encodeURIComponent(term)}`);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const n = flat.length;
    const move = (to: number) => {
      e.preventDefault();
      if (n) setSel(((to % n) + n) % n);
    };
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) move(cur + 1);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) move(cur - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(n - 1);
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      fullSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runItem(flat[cur]);
    }
  };

  let idx = -1;
  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="명령 팔레트"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div className="palette-input">
        <Icon name="search" size={18} />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={flat.length ? `pi-${cur}` : undefined}
          placeholder="이동하거나 검색…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        <kbd>esc</kbd>
        {loading && <div className="palette-loading" role="progressbar" aria-label="검색 중" />}
      </div>
      <div id="palette-list" role="listbox" className="palette-list" ref={listRef} aria-label="결과">
        {flat.length === 0 && <div className="palette-empty">{loading ? "검색 중…" : "일치하는 항목이 없습니다"}</div>}
        {groups.map((g, gi) => (
          <div key={`${g.name}-${gi}`} role="group" aria-label={g.name || "전체 검색"}>
            {g.name && (
              <div role="presentation" className="palette-group">
                {g.name}
              </div>
            )}
            {g.items.map((it) => {
              idx++;
              const i = idx;
              return (
                <div
                  key={it.id}
                  id={`pi-${i}`}
                  role="option"
                  aria-selected={i === cur}
                  className="palette-item"
                  onMouseMove={() => i !== cur && setSel(i)}
                  onClick={() => runItem(it)}
                >
                  <Icon name={it.icon} />
                  <span className="palette-label">{it.label}</span>
                  {it.hint && <span className="hint">{it.hint}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="palette-foot" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> 이동
        </span>
        <span>
          <kbd>↵</kbd> 열기
        </span>
        <span>
          <kbd>{MOD_LABEL}</kbd>
          <kbd>↵</kbd> 전체 검색
        </span>
        <span>
          <kbd>esc</kbd> 닫기
        </span>
      </div>
    </dialog>
  );
}
