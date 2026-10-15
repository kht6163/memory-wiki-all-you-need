import { Icon } from "./Icon.tsx";
import { pagerItems } from "../pager.ts";

/** Rows per page of a paged list (G-089). */
export const PAGE_SIZE = 50;

/** Prev/next, page numbers (first, last, two around the current) and "N개 중 a–b". */
export function Pager({ page, pages, total, onGo }: { page: number; pages: number; total: number; onGo: (n: number) => void }) {
  const from = (page - 1) * PAGE_SIZE + 1;
  return (
    <nav className="pager" aria-label="페이지">
      <button type="button" className="btn ghost small" disabled={page <= 1} onClick={() => onGo(page - 1)} aria-label="이전 페이지">
        <Icon name="chevron-left" size={14} />
      </button>
      {pagerItems(page, pages).map((n, i) =>
        n === null ? (
          <span key={`gap-${i}`} className="pager-gap" aria-hidden>
            …
          </span>
        ) : (
          <button key={n} type="button" className="btn ghost small tabular" aria-current={n === page ? "page" : undefined} onClick={() => onGo(n)}>
            {n}
          </button>
        ),
      )}
      <button type="button" className="btn ghost small" disabled={page >= pages} onClick={() => onGo(page + 1)} aria-label="다음 페이지">
        <Icon name="chevron-right" size={14} />
      </button>
      <span className="muted small tabular">
        {total}개 중 {from}–{Math.min(page * PAGE_SIZE, total)}
      </span>
    </nav>
  );
}

/** The 1-based `page` of the current hash query. */
export function readPage(): number {
  const raw = window.location.hash.replace(/^#/, "");
  const i = raw.indexOf("?");
  const p = new URLSearchParams(i < 0 ? "" : raw.slice(i + 1));
  return Math.max(Number.parseInt(p.get("page") ?? "1", 10) || 1, 1);
}

/** Writes `page` into the hash query without a hashchange (other params kept). */
export function writePage(page: number) {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const i = raw.indexOf("?");
  const path = i < 0 ? raw : raw.slice(0, i);
  const p = new URLSearchParams(i < 0 ? "" : raw.slice(i + 1));
  if (page > 1) p.set("page", String(page));
  else p.delete("page");
  const qs = p.toString();
  history.replaceState(history.state, "", `#${path}${qs ? `?${qs}` : ""}`);
}
