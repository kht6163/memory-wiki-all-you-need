// The web memory list one page at a time (G-089): every filter, chip count and the order run on
// the server. The list used to load at most 1,000 memories and filter them in the browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { db, entry, ok, project } from "./helpers.ts";
import { LIST_CATEGORY_ORDER } from "../src/store.ts";
import { pagerItems } from "../../web/src/pager.ts";

type Any = any;
const page = (q: string) => ok<Any>("GET", `/entries/page?${q}`);

test("G-089: pages cover every memory once, in category order, even when updated_at ties", async () => {
  const p = await project("github.com/test/ml-page", "ml-page");
  const ids: number[] = [];
  for (let i = 0; i < 7; i++) ids.push((await entry({ project_id: p.id, title: `ml fact ${i}`, category: "fact" })).id);
  for (let i = 0; i < 3; i++) ids.push((await entry({ project_id: p.id, title: `ml decision ${i}`, category: "decision" })).id);
  // A bulk import: one timestamp for all.
  db.prepare(`UPDATE entries SET updated_at = '2026-10-01T00:00:00.000Z' WHERE project_id = ?`).run(p.id);

  const seen: Any[] = [];
  for (let off = 0; off < 10; off += 4) {
    const r = await page(`scope=project&project_id=${p.id}&offset=${off}&limit=4`);
    assert.equal(r.total, 10);
    seen.push(...r.items);
  }
  assert.deepEqual(seen.map((e) => e.id).sort((a, b) => a - b), [...ids].sort((a, b) => a - b), "no repeats, no gaps");
  // decision comes before fact in the page's section order; ids descend within a tie.
  assert.deepEqual(seen.map((e) => e.category), [...Array(3).fill("decision"), ...Array(7).fill("fact")]);
  const facts = seen.filter((e) => e.category === "fact").map((e) => e.id);
  assert.deepEqual(facts, [...facts].sort((a, b) => b - a));
  // Items carry their state like GET /entries.
  assert.equal(seen[0].superseded_by, null);
});

test("G-089: text, category and source filters; chip counts present vs what a click gives; history", async () => {
  const p = await project("github.com/test/ml-filter", "ml-filter");
  const a = await entry({ project_id: p.id, title: "ml-filter 배포 절차", category: "convention", body: "helm" });
  const b = await entry({ project_id: p.id, title: "ml-filter 로그", category: "fact", body: "loki" });
  const c = await entry({ project_id: p.id, title: "ml-filter 캐시", category: "fact", body: "redis" });
  db.prepare(`UPDATE entries SET source = 'llm', keywords = '["Varnish"]' WHERE id = ?`).run(c.id);
  const old = await entry({ project_id: p.id, title: "ml-filter 예전 설정", category: "fact" });
  db.prepare(`UPDATE entries SET valid_until = '2000-01-01' WHERE id = ?`).run(old.id);
  const base = `scope=project&project_id=${p.id}`;

  let r = await page(base);
  assert.equal(r.total, 3, "history hidden by default");
  assert.equal(r.historyCount, 1);
  assert.deepEqual(r.cats, { convention: { present: 1, n: 1 }, fact: { present: 2, n: 2 } });
  assert.deepEqual(r.srcs, { human: { present: 2, n: 2 }, llm: { present: 1, n: 1 } });

  // Keywords count as text, case-insensitively.
  r = await page(`${base}&q=varnish`);
  assert.deepEqual(r.items.map((e: Any) => e.id), [c.id]);
  assert.deepEqual(r.cats.convention, { present: 1, n: 0 }, "the chip stays, its count says a click gives nothing");

  r = await page(`${base}&cat=fact&src=human`);
  assert.deepEqual(r.items.map((e: Any) => e.id), [b.id]);
  assert.equal(r.cats.convention.n, 1, "category counts ignore the category filter, keep the source one");
  assert.equal(r.srcs.llm.n, 1, "source counts ignore the source filter, keep the category one");

  r = await page(`${base}&history=1`);
  assert.equal(r.total, 4);
  assert.ok(r.items.find((e: Any) => e.id === old.id).expired);
  assert.equal(r.historyCount, 1);

  r = await page(`${base}&sort=title`);
  assert.deepEqual(r.items.map((e: Any) => e.id), [a.id, b.id, c.id], "sections first (convention, fact), then title (로그 < 캐시)");
});

test("G-089: standing-only page, limit bounds", async () => {
  const s = await entry({ scope: "global", title: "ml-standing 항상 한국어", category: "standing" });
  const r = await page(`scope=global&standing=1&limit=500`);
  assert.ok(r.items.every((e: Any) => e.category === "standing"));
  assert.ok(r.items.some((e: Any) => e.id === s.id));
  assert.ok(r.items.length <= 200);
  const none = await page(`scope=global&standing=1&offset=100000`);
  assert.deepEqual(none.items, []);
  assert.equal(none.total, r.total);
});

test("G-089: server section order is the web page's CATEGORY_ORDER", () => {
  const lib = readFileSync(new URL("../../web/src/lib.tsx", import.meta.url), "utf8");
  const m = /export const CATEGORY_ORDER = (\[[^\]]*\])/.exec(lib);
  assert.ok(m);
  assert.deepEqual(JSON.parse(m![1]), LIST_CATEGORY_ORDER);
});

test("G-089: pager numbers — ends, two around the current page, gaps", () => {
  assert.deepEqual(pagerItems(1, 1), [1]);
  assert.deepEqual(pagerItems(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(pagerItems(1, 10), [1, 2, 3, null, 10]);
  assert.deepEqual(pagerItems(6, 12), [1, null, 4, 5, 6, 7, 8, null, 12]);
  assert.deepEqual(pagerItems(4, 12), [1, 2, 3, 4, 5, 6, null, 12], "a one-page gap shows the page");
});

test("G-089: the trash pages too — deleted memories only, newest deletion first, history not applied", async () => {
  const p = await project("github.com/test/ml-trash", "ml-trash");
  const live = await entry({ project_id: p.id, title: "ml-trash live", category: "fact" });
  const gone: number[] = [];
  for (let i = 0; i < 3; i++) gone.push((await entry({ project_id: p.id, title: `ml-trash gone ${i}`, category: i ? "fact" : "decision" })).id);
  // An expired memory in the trash still shows there: the trash has no history toggle.
  db.prepare(`UPDATE entries SET valid_until = '2000-01-01' WHERE id = ?`).run(gone[1]);
  for (const id of gone) await ok("DELETE", `/entries/${id}`);
  db.prepare(`UPDATE entries SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id IN (${gone.join(",")})`).run();
  db.prepare(`UPDATE entries SET deleted_at = '2026-10-02T00:00:00.000Z' WHERE id = ?`).run(gone[0]);

  const r = await page(`scope=project&project_id=${p.id}&deleted=1&limit=2`);
  assert.equal(r.total, 3);
  assert.equal(r.historyCount, 0);
  // Newest deletion first, then id descending; no category sections.
  assert.deepEqual(r.items.map((e: Any) => e.id), [gone[0], gone[2]]);
  const r2 = await page(`scope=project&project_id=${p.id}&deleted=1&limit=2&offset=2`);
  assert.deepEqual(r2.items.map((e: Any) => e.id), [gone[1]]);
  assert.ok(r2.items[0].deleted_at);
  // The live memory is not in the trash, and the trash is not in the list.
  const l = await page(`scope=project&project_id=${p.id}`);
  assert.deepEqual(l.items.map((e: Any) => e.id), [live.id]);
});
