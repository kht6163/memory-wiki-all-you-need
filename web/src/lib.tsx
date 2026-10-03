import { useCallback, useEffect, useState, type ReactNode } from "react";
import { diffWordsWithSpace } from "diff";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Entry, Scope, Source } from "./api.ts";
import { Icon, type IconName } from "./components/Icon.tsx";
import { toast } from "./components/Toast.tsx";
import { confirmDialog } from "./components/Dialog.tsx";

export { toast, dismissToast } from "./components/Toast.tsx";
export { confirmDialog };

// ------------------------------------------------------------ hash router

export interface Route {
  path: string[];
  query: URLSearchParams;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [p, q] = raw.split("?");
  return { path: p.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q ?? "") };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => {
      setRoute(parseHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (to: string) => {
  window.location.hash = to;
};

// ------------------------------------------------- leave guard (editors)
//
// App's router listens to hashchange from its own mount; a listener added inside an editor
// would run after it, when the next page is already rendering. This one is registered at import
// time (before App mounts) and in the capture phase, so it runs first and can stop the router.

let leaveGuard: { route: string; dirty: boolean } | null = null;
let leaveBypass = false;

if (typeof window !== "undefined") {
  window.addEventListener(
    "hashchange",
    (e) => {
      if (leaveBypass) {
        leaveBypass = false;
        return;
      }
      if (!leaveGuard?.dirty) return;
      const target = window.location.hash;
      if (target === `#${leaveGuard.route}`) return;
      e.stopImmediatePropagation();
      history.replaceState(history.state, "", `#${leaveGuard.route}`);
      confirmDialog({
        title: "저장하지 않은 변경이 있습니다",
        body: <p>이 페이지를 떠나면 편집한 내용이 사라집니다.</p>,
        confirmLabel: "버리고 나가기",
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        leaveGuard = null;
        window.location.hash = target;
      });
    },
    { capture: true },
  );
}

/**
 * Asks before leaving `route` while `dirty`: in-app navigation (hashchange) gets a confirm dialog,
 * tab close / reload gets the browser's beforeunload prompt.
 */
export function useLeaveGuard(route: string, dirty: boolean) {
  useEffect(() => {
    leaveGuard = { route, dirty };
  }, [route, dirty]);
  useEffect(() => () => void (leaveGuard = null), []);
  useEffect(() => {
    if (!dirty) return;
    const on = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [dirty]);
}

/** Navigate without the leave guard (after a save). */
export function leaveTo(to: string, replace = false) {
  leaveGuard = null;
  if (replace) {
    // No hashchange fires when the hash is unchanged; only arm the bypass when one will.
    leaveBypass = window.location.hash !== `#${to}`;
    window.location.replace(`#${to}`);
  } else go(to);
}

// ------------------------------------------------------------- data hook

/** Fetches on mount and whenever deps change; `reload` refetches. Also refetches on the global "memory:changed" event. */
export function useData<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  useEffect(() => {
    window.addEventListener("memory:changed", reload);
    return () => window.removeEventListener("memory:changed", reload);
  }, [reload]);
  return { data, error, loading, reload };
}

export const changed = () => window.dispatchEvent(new Event("memory:changed"));

// ---------------------------------------------------------------- labels

export const CATEGORY_LABEL: Record<string, string> = {
  standing: "고정 지시",
  convention: "관례",
  decision: "결정",
  fact: "사실",
  preference: "선호",
  correction: "교정",
  failure: "실패",
  "tool-quirk": "도구 특이사항",
  insight: "통찰",
};
export const CATEGORY_ORDER = ["standing", "convention", "decision", "fact", "preference", "correction", "failure", "tool-quirk", "insight"];

export const SCOPE_LABEL: Record<Scope, string> = { global: "전역", user: "사용자", project: "프로젝트" };
export const SOURCE_LABEL: Record<Source, string> = { agent: "에이전트", llm: "LLM 정리", human: "사람" };
export const ACTION_LABEL: Record<string, string> = { create: "추가", update: "수정", delete: "삭제", restore: "복원" };

// ------------------------------------------------------------ components

/** Same rules as the server's slugify (server/src/wiki.ts). */
export function slugify(s: string): string {
  const slug = s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "page";
}

/** wiki scope id used in routes: project id, or 0 for the global wiki. */
export const scopeId = (projectId: number | null | undefined) => projectId ?? 0;

/**
 * Markdown with wiki syntax: [[slug]] / [[slug|label]] become links to wiki
 * pages of `wikiScope` ("global:slug" targets the global wiki), [#12] becomes
 * a link to memory #12.
 */
export function Markdown({ children, wikiScope, missing }: { children: string; wikiScope?: number; /** Slugs (in `wikiScope`) with no page yet: shown as "create" links. */ missing?: Set<string> }) {
  let src = children;
  if (wikiScope !== undefined) {
    src = src.replace(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g, (_m, target: string, label?: string) => {
      const global = target.startsWith("global:");
      const slug = slugify(global ? target.slice(7) : target);
      return `[${(label ?? target).replace(/[[\]]/g, "")}](#/w/${global ? 0 : wikiScope}/${encodeURIComponent(slug)})`;
    });
  }
  src = src.replace(/\[#(\d+)\](?!\()/g, (_m, id: string) => `[#${id}](#/e/${id} "memory #${id}")`);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, title }) => {
            const own = wikiScope !== undefined && href?.startsWith(`#/w/${wikiScope}/`) ? decodeURIComponent(href.slice(`#/w/${wikiScope}/`.length)) : null;
            if (own !== null && missing?.has(own)) {
              return (
                <a href={`#/w/${wikiScope}/~new?slug=${encodeURIComponent(own)}`} className="wikilink missing" title="아직 없는 페이지 — 눌러서 만들기">
                  {children}
                </a>
              );
            }
            return (
              <a href={href} title={title} className={href?.startsWith("#/e/") ? "cite" : href?.startsWith("#/w/") ? "wikilink" : undefined}>
                {children}
              </a>
            );
          },
        }}
      >
        {src}
      </ReactMarkdown>
    </div>
  );
}

const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
export function relTime(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "방금";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(iso).toLocaleDateString("ko-KR");
}

export function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString("ko-KR")}>
      {relTime(iso)}
    </time>
  );
}

export function CategoryBadge({ category }: { category: string }) {
  return <span className={`badge cat-${category}`}>{CATEGORY_LABEL[category] ?? category}</span>;
}

export function SourceBadge({ source }: { source: Source }) {
  return <span className={`badge src-${source}`}>{SOURCE_LABEL[source]}</span>;
}

export function Tags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <span className="tags">
      {tags.map((t) => (
        <a key={t} className="tag" href={`#/search?q=${encodeURIComponent(t)}`}>
          #{t}
        </a>
      ))}
    </span>
  );
}

/**
 * Empty state. `title` + optional description (children) + optional action; plain `children` alone
 * still works for older callers.
 */
export function Empty({ icon, title, children, action }: { icon?: IconName; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && (
        <span className="empty-icon">
          <Icon name={icon} size={24} />
        </span>
      )}
      {title && <div className="empty-title">{title}</div>}
      {children && <div className="empty-desc">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error-box">{error}</div> : null;
}

export function scopeHref(e: Pick<Entry, "scope" | "project_id">): string {
  return e.scope === "project" ? `#/p/${e.project_id}` : e.scope === "user" ? "#/user" : "#/global";
}

/**
 * Runs a mutation: on success fires "memory:changed" (and an optional success toast), on failure shows
 * an error toast. Never throws — returns undefined on failure, so callers can chain `.then(r => r !== undefined && …)`.
 */
export async function act<T>(fn: () => Promise<T>, opts?: { success?: string }): Promise<T | undefined> {
  try {
    const r = await fn();
    changed();
    if (opts?.success) toast({ kind: "ok", title: opts.success });
    return r;
  } catch (e) {
    toast({ kind: "error", title: "요청 실패", description: (e as Error).message });
    return undefined;
  }
}

/**
 * Soft delete with undo: deletes right away, then offers "실행 취소" for 8 s.
 * Returns true when the delete succeeded.
 */
export async function softDelete(opts: { title: string; remove: () => Promise<unknown>; restore: () => Promise<unknown>; onUndo?: () => void }): Promise<boolean> {
  const r = await act(async () => {
    await opts.remove();
    return true;
  });
  if (!r) return false;
  toast({
    kind: "info",
    title: `'${opts.title}' 휴지통으로 이동`,
    duration: 8000,
    action: {
      label: "실행 취소",
      run: () => {
        act(opts.restore, { success: "복원했습니다" }).then((x) => x !== undefined && opts.onUndo?.());
      },
    },
  });
  return true;
}

// ------------------------------------------------------------- loading

/** True once `on` has stayed true for `ms` — so fast loads never flash a placeholder. */
export function useDelayed(on: boolean, ms = 150): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) return setLate(false);
    if (ms <= 0) return setLate(true);
    const t = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on && (late || ms <= 0);
}

// --------------------------------------------------------------- theme

export type Theme = "system" | "light" | "dark";

function readTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}

/** Sets the theme everywhere: localStorage, <html data-theme>, and a "theme:changed" event. */
export function applyTheme(t: Theme) {
  try {
    if (t === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", t);
  } catch {
    // storage blocked: the choice still applies for this page view
  }
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  window.dispatchEvent(new Event("theme:changed"));
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const on = () => setTheme(readTheme());
    window.addEventListener("theme:changed", on);
    return () => window.removeEventListener("theme:changed", on);
  }, []);
  return [theme, applyTheme];
}

export const THEME_LABEL: Record<Theme, string> = { system: "시스템", light: "라이트", dark: "다크" };
export const THEME_ICON: Record<Theme, IconName> = { system: "monitor", light: "sun", dark: "moon" };

// ------------------------------------------------------------ keyboard

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD_LABEL = isMac ? "⌘" : "Ctrl";

/** True when a key event comes from a text field, so single-key shortcuts must not fire. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

// ------------------------------------------------------------- storage

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore: storage is a convenience only
  }
}

/** Word-level diff of two texts (revisions, review proposals). */
export function Diff({ a, b }: { a: string; b: string }) {
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

/** Call fn every `ms` while `enabled` (e.g. while a job is pending); stops when disabled or unmounted. */
export function usePoll(fn: () => void, ms: number, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(fn, ms);
    return () => window.clearInterval(t);
    // fn is usually an inline reload callback; re-arming on every render is not wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, enabled]);
}

/** Korean label for a job status (wiki compose, graph backfill, review). */
export const JOB_STATUS_LABEL: Record<string, string> = {
  pending: "대기",
  processing: "진행 중",
  done: "완료",
  skipped: "건너뜀",
  error: "실패",
  cancelled: "취소됨",
};

/** "대체됨 → #id" / "만료" badge for history memories; nothing for current ones. */
/** `linked={false}` renders the superseded badge as text, for use inside a row that is itself a link. */
export function StateBadge({ e, linked = true }: { e: Pick<Entry, "superseded_by" | "expired" | "valid_until">; linked?: boolean }) {
  if (e.superseded_by) {
    const title = "새 메모리로 대체되어 주입되지 않습니다(이력)";
    if (!linked) {
      return (
        <span className="badge state-badge" title={title}>
          대체됨 → #{e.superseded_by}
        </span>
      );
    }
    return (
      <a className="badge state-badge" href={`#/e/${e.superseded_by}`} title={title}>
        대체됨 → #{e.superseded_by}
      </a>
    );
  }
  if (e.expired) return <span className="badge state-badge" title={`${e.valid_until}까지 유효했습니다(이력)`}>만료 {e.valid_until}</span>;
  if (e.valid_until) return <span className="badge faint" title="이 날짜까지만 주입됩니다">~{e.valid_until}</span>;
  return null;
}
export const isHistory = (e: Pick<Entry, "superseded_by" | "expired">) => Boolean(e.superseded_by || e.expired);
