import { useDelayed } from "../lib.tsx";

// Loading placeholders. Each one waits 150 ms before showing, so fast loads never flash.

function Bar({ width, height = 12 }: { width: string; height?: number }) {
  return <span className="skeleton" style={{ width, height }} />;
}

const WIDTHS = ["92%", "86%", "74%", "95%", "60%"];

export function SkeletonText({ lines = 3, delay = 150 }: { lines?: number; delay?: number }) {
  const show = useDelayed(true, delay);
  return (
    <div className="skeleton-text" aria-busy="true" aria-label="불러오는 중">
      {show && Array.from({ length: lines }, (_, i) => <Bar key={i} width={i === lines - 1 ? "55%" : WIDTHS[i % WIDTHS.length]} />)}
    </div>
  );
}

export function SkeletonList({ rows = 5, delay = 150 }: { rows?: number; delay?: number }) {
  const show = useDelayed(true, delay);
  if (!show) return <div className="skeleton-wait" aria-busy="true" aria-label="불러오는 중" />;
  return (
    <div className="list skeleton-list" aria-busy="true" aria-label="불러오는 중">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="list-row">
          <Bar width="40%" height={14} />
          <Bar width={WIDTHS[i % WIDTHS.length]} />
          <Bar width="70%" />
        </div>
      ))}
    </div>
  );
}

/** Whole-page placeholder for detail pages: crumbs, title, meta line, body. */
export function SkeletonPage({ delay = 150 }: { delay?: number }) {
  const show = useDelayed(true, delay);
  if (!show) return <div className="page skeleton-wait" aria-busy="true" aria-label="불러오는 중" />;
  return (
    <div className="page narrow skeleton-page" aria-busy="true" aria-label="불러오는 중">
      <Bar width="22%" height={12} />
      <Bar width="58%" height={28} />
      <Bar width="34%" height={12} />
      <div className="skeleton-gap" />
      <SkeletonText lines={5} delay={0} />
      <div className="skeleton-gap" />
      <SkeletonText lines={3} delay={0} />
    </div>
  );
}
