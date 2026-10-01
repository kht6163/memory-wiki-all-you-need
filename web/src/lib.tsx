import { useCallback, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Entry, Scope, Source } from "./api.ts";

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
export function Markdown({ children, wikiScope }: { children: string; wikiScope?: number }) {
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
          a: ({ href, children, title }) => (
            <a href={href} title={title} className={href?.startsWith("#/e/") ? "cite" : href?.startsWith("#/w/") ? "wikilink" : undefined}>
              {children}
            </a>
          ),
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

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error-box">{error}</div> : null;
}

export function scopeHref(e: Pick<Entry, "scope" | "project_id">): string {
  return e.scope === "project" ? `#/p/${e.project_id}` : e.scope === "user" ? "#/user" : "#/global";
}

export async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn();
    changed();
    return r;
  } catch (e) {
    alert((e as Error).message);
    return undefined;
  }
}
