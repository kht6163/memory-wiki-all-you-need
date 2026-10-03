// Wiki lint (GET /wiki/lint): orphan pages, links to missing pages, citations
// of memories that are gone or history, and blank stubs — no LLM. Each wiki
// (project or global) is checked on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, entry, ok, project } from "./helpers.ts";

type Any = any;
let seq = 0;
async function proj() {
  seq++;
  return project(`github.com/test/lint-${seq}`, `lint-${seq}`);
}
const page = (b: { project_id?: number | null; slug?: string; title: string; body?: string }) => ok<Any>("POST", "/wiki/pages", b);
const lint = (projectId: number | null) => ok<Any>("GET", `/wiki/lint${projectId ? `?project_id=${projectId}` : ""}`);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const LONG = "This page has enough text to not be counted as an empty stub at all.";

test("lint: orphans are live pages nobody else links to; overview/index, self-links and deleted linkers are handled", async () => {
  const p = await proj();
  await page({ project_id: p.id, slug: "overview", title: "개요", body: `${LONG} [[a]]` });
  await page({ project_id: p.id, slug: "index", title: "목록", body: LONG });
  const a = await page({ project_id: p.id, slug: "a", title: "A", body: `${LONG} [[b]]` });
  const b = await page({ project_id: p.id, slug: "b", title: "B", body: LONG });
  const self = await page({ project_id: p.id, slug: "self", title: "Self", body: `${LONG} [[self]]` });
  let r = await lint(p.id);
  assert.deepEqual(r.orphans.map((x: Any) => x.slug), ["self"], "self-link does not count; overview/index are exempt");
  assert.deepEqual(r.orphans[0], { id: self.id, slug: "self", title: "Self" });
  assert.equal(r.counts.orphans, 1);

  // The only linker of b is deleted → b becomes an orphan; restoring fixes it.
  await ok("DELETE", `/wiki/pages/${a.id}`);
  r = await lint(p.id);
  assert.ok(r.orphans.some((x: Any) => x.id === b.id));
  assert.ok(!r.orphans.some((x: Any) => x.id === a.id), "deleted pages are not reported");
  await ok("POST", `/wiki/pages/${a.id}/restore`);
  r = await lint(p.id);
  assert.ok(!r.orphans.some((x: Any) => x.id === b.id));

  // A link from another wiki does not count.
  await page({ project_id: null, slug: `g-link-${p.id}`, title: "G", body: `${LONG} [[self]]` });
  assert.ok((await lint(p.id)).orphans.some((x: Any) => x.id === self.id));
});

test("lint: missing groups links to slugs with no live page; creating the page clears it", async () => {
  const p = await proj();
  const x = await page({ project_id: p.id, slug: "x", title: "X", body: `${LONG} [[Deploy Guide]] [[y]]` });
  const y = await page({ project_id: p.id, slug: "y", title: "Y", body: `${LONG} [[deploy-guide|배포]] [[x]]` });
  let r = await lint(p.id);
  assert.deepEqual(r.missing, [
    {
      slug: "deploy-guide",
      from: [
        { id: x.id, slug: "x", title: "X" },
        { id: y.id, slug: "y", title: "Y" },
      ],
    },
  ]);
  assert.equal(r.counts.missing, 1);
  // Same semantics as /wiki/missing.
  const legacy = await ok<Any[]>("GET", `/wiki/missing?project_id=${p.id}`);
  assert.deepEqual(new Set(legacy.map((m) => m.to)), new Set(["deploy-guide"]));

  // A global page with that slug does not resolve a project link.
  await page({ project_id: null, slug: "deploy-guide", title: "전역 배포", body: LONG });
  assert.equal((await lint(p.id)).counts.missing, 1);

  const d = await page({ project_id: p.id, slug: "deploy-guide", title: "배포 가이드", body: LONG });
  r = await lint(p.id);
  assert.equal(r.counts.missing, 0);
  // Deleting the target brings it back.
  await ok("DELETE", `/wiki/pages/${d.id}`);
  assert.equal((await lint(p.id)).missing[0].slug, "deploy-guide");
});

test("lint: citations of deleted, purged, superseded and expired memories; restoring clears the issue", async () => {
  const p = await proj();
  const live = await entry({ project_id: p.id, title: "live memory" });
  const del = await entry({ project_id: p.id, title: "to delete" });
  const purged = await entry({ project_id: p.id, title: "to purge" });
  const oldM = await entry({ project_id: p.id, title: "old way" });
  const newM = await entry({ project_id: p.id, title: "new way" });
  const exp = await entry({ project_id: p.id, title: "expired", valid_until: day(-1) } as Any);
  await ok("DELETE", `/entries/${del.id}`);
  await ok("DELETE", `/entries/${purged.id}`);
  await ok("DELETE", `/entries/${purged.id}/purge`);
  await ok("POST", `/entries/${newM.id}/links`, { to: oldM.id, type: "supersedes" });

  const body = `${LONG} [#${live.id}] [#${del.id}] [#${purged.id}] [#${oldM.id}] [#${newM.id}] [#${exp.id}] [#999999]`;
  const pg = await page({ project_id: p.id, slug: "cites", title: "Cites", body });
  let r = await lint(p.id);
  const ref = { id: pg.id, slug: "cites", title: "Cites" };
  const byId = new Map(r.citations.map((c: Any) => [c.entry_id, c]));
  assert.deepEqual(byId.get(del.id), { page: ref, entry_id: del.id, state: "deleted" });
  assert.deepEqual(byId.get(purged.id), { page: ref, entry_id: purged.id, state: "purged" });
  assert.deepEqual(byId.get(999999), { page: ref, entry_id: 999999, state: "purged" });
  assert.deepEqual(byId.get(oldM.id), { page: ref, entry_id: oldM.id, state: "superseded", superseded_by: newM.id });
  assert.deepEqual(byId.get(exp.id), { page: ref, entry_id: exp.id, state: "expired" });
  assert.ok(!byId.has(live.id) && !byId.has(newM.id), "current memories are fine");
  assert.equal(r.counts.citations, 5);

  // Fixes: restore the deleted memory, drop the supersedes link.
  await ok("POST", `/entries/${del.id}/restore`);
  await ok("DELETE", `/entries/${newM.id}/links?to=${oldM.id}&type=supersedes`);
  r = await lint(p.id);
  const ids = r.citations.map((c: Any) => c.entry_id);
  assert.ok(!ids.includes(del.id) && !ids.includes(oldM.id));
  assert.equal(r.counts.citations, 3);

  // Citations on deleted pages are not reported.
  await ok("DELETE", `/wiki/pages/${pg.id}`);
  assert.equal((await lint(p.id)).counts.citations, 0);
});

test("lint: empty pages have a blank or short body (whitespace ignored)", async () => {
  const p = await proj();
  const blank = await page({ project_id: p.id, slug: "blank", title: "Blank", body: "" });
  const spaces = await page({ project_id: p.id, slug: "spaces", title: "Spaces", body: `   \n\n\t  짧음  \n ` });
  await page({ project_id: p.id, slug: "full", title: "Full", body: LONG });
  let r = await lint(p.id);
  assert.deepEqual(r.empty.map((x: Any) => x.id).sort(), [blank.id, spaces.id].sort());
  assert.equal(r.counts.empty, 2);
  await ok("PATCH", `/wiki/pages/${blank.id}`, { body: LONG });
  r = await lint(p.id);
  assert.deepEqual(r.empty.map((x: Any) => x.id), [spaces.id]);
});

test("lint: project and global wikis are separate; project_id=0 and omitted mean global", async () => {
  const p = await proj();
  const q = await proj();
  const gp = await page({ project_id: null, slug: `global-stub-${p.id}`, title: "Global stub", body: `[[nowhere-${p.id}]]` });
  const pp = await page({ project_id: p.id, slug: "proj-stub", title: "Proj stub", body: "" });

  const g = await lint(null);
  assert.deepEqual(await ok<Any>("GET", "/wiki/lint?project_id=0"), g);
  assert.ok(g.empty.some((x: Any) => x.id === gp.id) && !g.empty.some((x: Any) => x.id === pp.id));
  assert.ok(g.missing.some((m: Any) => m.slug === `nowhere-${p.id}`));

  const r = await lint(p.id);
  assert.ok(r.empty.some((x: Any) => x.id === pp.id) && !r.empty.some((x: Any) => x.id === gp.id));
  assert.ok(!r.missing.some((m: Any) => m.slug === `nowhere-${p.id}`));
  assert.deepEqual(await ok<Any>("GET", `/wiki/lint?project=${encodeURIComponent(p.key)}`), r);

  const other = await lint(q.id);
  assert.deepEqual(other.counts, { orphans: 0, missing: 0, citations: 0, empty: 0 });
});

test("lint: orphan check stays linear on a large wiki (no per-page rescan)", async () => {
  // A correlated NOT EXISTS made this O(pages²): ~10k pages blocked the server
  // for seconds. Pages are inserted directly; a chain links page i → i+1.
  const p = await proj();
  const N = 10_000;
  const insPage = db.prepare(`INSERT INTO wiki_pages (project_id, slug, title, body) VALUES (?, ?, ?, ?)`);
  const insLink = db.prepare(`INSERT INTO wiki_links (page_id, to_slug) VALUES (?, ?)`);
  db.exec("BEGIN");
  try {
    for (let i = 0; i < N; i++) {
      const id = Number(insPage.run(p.id, `bulk-${i}`, `Bulk ${i}`, LONG).lastInsertRowid);
      if (i + 1 < N) insLink.run(id, `bulk-${i + 1}`);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const t0 = performance.now();
  const r = await lint(p.id);
  const ms = performance.now() - t0;
  assert.deepEqual(r.orphans.map((x: Any) => x.slug), ["bulk-0"]);
  assert.equal(r.counts.missing, 0);
  assert.ok(ms < 1500, `lint took ${Math.round(ms)} ms for ${N} pages`);
});

test("GET /wiki/pages/:id marks cited memories that are history", async () => {
  const { ok: okc, entry: mk } = await import("./helpers.ts");
  const oldM = await mk({ title: "cited old fact" });
  const newM = await mk({ title: "cited new fact" });
  await okc("POST", `/entries/${newM.id}/links`, { to: oldM.id, type: "supersedes" });
  const page = await okc<any>("POST", "/wiki/pages", { project_id: null, title: "Cites history", body: `see [#${oldM.id}] and [#${newM.id}]` });
  const d = await okc<any>("GET", `/wiki/pages/${page.id}`);
  const byId = Object.fromEntries(d.cites.map((e: any) => [e.id, e]));
  assert.equal(byId[oldM.id].superseded_by, newM.id);
  assert.equal(byId[newM.id].superseded_by, null);
});
