// Wiki link syntax shared by the Markdown renderer and the editor preview.
// Pure module (no DOM, no React) so server/test can import it.

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

/** [[target]], [[target#section]], [[target|label]]: group 1 = target, group 2 = label. Global flag: use with replace/matchAll. */
export const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;

/**
 * Slugs that `body` links to inside its own wiki and that are not in `existing` — the links the
 * page view draws dotted ("create" links). "global:" targets point at the global wiki, so they
 * count as the own wiki only when `scope` is 0. `self` (the slug being written) never counts.
 */
export function missingLinks(body: string, scope: number, existing: Iterable<string>, self?: string): Set<string> {
  const have = new Set(existing);
  const out = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = m[1];
    const global = target.startsWith("global:");
    if (global && scope !== 0) continue;
    const slug = slugify(global ? target.slice(7) : target);
    if (slug !== self && !have.has(slug)) out.add(slug);
  }
  return out;
}
