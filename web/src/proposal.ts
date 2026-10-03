// Review "update" proposal helpers: body edits (new `edits` list or legacy single `edit`) and the
// entity list change. Pure module (no DOM, no React) so server/test can import it.

export interface BodyEdit {
  old: string;
  new: string;
}

/** The body edits of a proposal: `data.edits`, or the legacy single `data.edit` (proposals written before v0.6.1). */
export function proposalEdits(data: { edits?: BodyEdit[] | null; edit?: BodyEdit | null }): BodyEdit[] {
  if (Array.isArray(data.edits) && data.edits.length) return data.edits;
  return data.edit ? [data.edit] : [];
}

export type EditProblem = "missing" | "repeated" | "overlap";

/**
 * What would make each edit fail against the current body (advisory: the server re-checks on apply).
 * "overlap": its passage overlaps another edit's (the contract says edits never overlap).
 */
export function editProblems(body: string, edits: BodyEdit[]): (EditProblem | null)[] {
  const spans = edits.map((e) => {
    const at = e.old ? body.indexOf(e.old) : -1;
    return at < 0 ? null : { at, end: at + e.old.length, repeated: body.indexOf(e.old, at + 1) >= 0 };
  });
  return spans.map((s, i) => {
    if (!s) return "missing";
    if (s.repeated) return "repeated";
    const clash = spans.some((o, j) => j !== i && o && o.at < s.end && s.at < o.end);
    return clash ? "overlap" : null;
  });
}

const VERSION_SUFFIX = /\s+v?\d+(?:\.\d+)*[a-z]?$/i;

/**
 * Matching key of an entity name: a copy of server/src/entities.ts entityNorm (with entityDisplayName),
 * so names the server treats as one entity ("Node.js" / "nodejs") are not shown as added or removed.
 */
export function entityKey(name: string): string {
  const s = name.normalize("NFKC").replace(/\s+/g, " ").trim();
  const display = (s.replace(VERSION_SUFFIX, "") || s).slice(0, 60);
  const norm = display
    .toLowerCase()
    .replace(/^\.\//, "")
    .replace(/[\s._\-]+/g, "")
    .replace(/\/+/g, "/");
  return /.\/.+\/$/.test(norm) ? norm.slice(0, -1) : norm;
}

/** Entity change of an update proposal; null when it keeps the current list. `added` breaks the subset rule. */
export function entityChange(current: string[], proposed: string[] | null | undefined): { kept: string[]; removed: string[]; added: string[] } | null {
  if (!Array.isArray(proposed)) return null;
  const key = entityKey;
  const next = new Set(proposed.map(key));
  const cur = new Set(current.map(key));
  const kept = current.filter((n) => next.has(key(n)));
  const removed = current.filter((n) => !next.has(key(n)));
  const added = proposed.filter((n) => !cur.has(key(n)));
  return removed.length || added.length ? { kept, removed, added } : null;
}
