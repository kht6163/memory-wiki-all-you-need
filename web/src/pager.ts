// Page numbers of a list pager. Pure (no React / DOM): the server tests import it.

/** Page numbers to show: the first, the last and two around the current one; null = a gap (…). A gap of one page shows that page. */
export function pagerItems(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= pages));
  const out: (number | null)[] = [];
  let prev = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - prev > 1) out.push(n - prev === 2 ? n - 1 : null);
    out.push(n);
    prev = n;
  }
  return out;
}
