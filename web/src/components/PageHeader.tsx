import type { ReactNode } from "react";

/**
 * Shared page header: crumbs, title row (actions on the right, wrapping below on mobile), lead,
 * free-form `children` (meta lines, notices), tabs, then toolbar. `busy` shows a 2 px progress bar
 * while a reload runs with the old data still on screen.
 */
export function PageHeader({
  crumbs,
  title,
  lead,
  actions,
  tabs,
  toolbar,
  busy,
  children,
}: {
  crumbs?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  toolbar?: ReactNode;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      {busy && <div className="progress-bar" role="progressbar" aria-label="불러오는 중" />}
      {crumbs && <div className="crumbs">{crumbs}</div>}
      <div className="page-title-row">
        <h1>{title}</h1>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {lead && <p className="lead">{lead}</p>}
      {children}
      {tabs}
      {toolbar && <div className="toolbar">{toolbar}</div>}
    </header>
  );
}
