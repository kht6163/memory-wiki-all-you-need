// Project merge: a project split off by an origin change (G-007) is merged
// into another one. Everything moves in one transaction, the source key stays
// as an alias of the target, and the source row is gone afterwards.
import assert from "node:assert/strict";
import { test } from "node:test";

const { call, db, entry, ok, project, turn } = await import("./helpers.ts");

type Any = any;
let seq = 0;
async function proj(name?: string) {
  seq++;
  return project(`github.com/test/pm-${seq}`, name ?? `pm-${seq}`);
}
const ctx = (key: string, prompt = "") => ok<Any>("POST", "/context", { project: { key, name: "x" }, prompt });
const page = (project_id: number, slug: string, body = "") => ok<Any>("POST", "/wiki/pages", { project_id, slug, title: slug, body });
const doneTurns = () => db.exec(`UPDATE turns SET status = 'done' WHERE status IN ('pending','processing')`);
const projectRows = () => Number((db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as Any).n);
const total = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Any).n);

test("G-060: preview counts and wiki conflicts, then merge moves everything and the old key injects into the target", async () => {
  const src = await proj("old-name");
  const dst = await proj("new-name");
  const m1 = await entry({ project_id: src.id, title: "deploy uses port 9123", body: "x" });
  const m2 = await entry({ project_id: src.id, title: "trashed memory" });
  await ok("DELETE", `/entries/${m2.id}`);
  await entry({ project_id: dst.id, title: "target memory" });
  await turn([{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }], src);
  doneTurns();
  const sOverview = await page(src.id, "overview", "see [[setup]] and [[Overview#top|home]] and [[overview]]");
  await page(src.id, "setup", "back to [[overview]]");
  const tOverview = await page(dst.id, "overview", "target overview");
  // The renamed slug's first choice is already used in the target.
  await page(dst.id, "overview-old-name", "taken");

  const before = Object.fromEntries(["entries", "turns", "wiki_pages", "wiki_revisions", "wiki_citations", "revisions"].map((t) => [t, total(t)]));

  const rowsBefore = projectRows();
  const pv = await ok<Any>("GET", `/projects/${src.id}/merge-preview?into=${dst.id}`);
  assert.deepEqual(pv.source, { id: src.id, key: src.key, name: "old-name" });
  assert.deepEqual(pv.target, { id: dst.id, key: dst.key, name: "new-name" });
  assert.deepEqual(pv.counts, { entries: 2, turns: 1, wiki_pages: 2, wiki_jobs: 0, review_jobs: 0, review_proposals_pending: 0 });
  assert.deepEqual(pv.wiki_conflicts, [{ slug: "overview", source_page_id: sOverview.id, target_page_id: tOverview.id, new_slug: "overview-old-name-2" }]);
  assert.equal(pv.policy, "none");
  assert.equal(pv.description, "none");
  assert.deepEqual(pv.aliases, [src.key]);
  assert.equal(projectRows(), rowsBefore, "preview changes nothing");

  const r = await ok<Any>("POST", `/projects/${src.id}/merge`, { into: dst.id });
  assert.equal(r.target.id, dst.id);
  assert.deepEqual(r.moved, pv.counts);
  assert.deepEqual(r.wiki_conflicts, pv.wiki_conflicts);
  assert.deepEqual(r.aliases, [src.key]);
  assert.deepEqual(r.target.aliases, [src.key]);

  // Source row gone, nothing lost.
  assert.equal((await call("GET", `/projects/${src.id}`)).status, 404);
  assert.equal(projectRows(), rowsBefore - 1);
  for (const [t, n] of Object.entries(before)) assert.equal(total(t), t === "wiki_revisions" ? n + 2 : n, t);
  assert.equal(Number((db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE project_id = ?`).get(dst.id) as Any).n), 3);
  assert.equal(Number((db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE project_id = ?`).get(dst.id) as Any).n), 1);

  // Both the new key and the old key inject the moved memory.
  for (const key of [dst.key, src.key]) {
    const c = await ctx(key);
    assert.equal(c.project.id, dst.id, key);
    assert.ok(c.included.includes(m1.id), key);
    assert.match(c.system, /deploy uses port 9123/);
  }
  assert.deepEqual((await ok<Any>("GET", `/projects/${dst.id}`)).aliases, [src.key]);

  // Wiki: the source overview was renamed; its links that meant it follow it.
  const pages = await ok<Any[]>("GET", `/wiki/pages?project_id=${dst.id}`);
  assert.deepEqual(pages.map((p) => p.slug).sort(), ["overview", "overview-old-name", "overview-old-name-2", "setup"]);
  const renamed = (await ok<Any>("GET", `/wiki/pages/${sOverview.id}`)).page;
  assert.equal(renamed.slug, "overview-old-name-2");
  assert.equal(renamed.body, "see [[setup]] and [[overview-old-name-2#top|home]] and [[overview-old-name-2|overview]]");
  const setup = (await ok<Any>("GET", `/wiki/by-slug?project_id=${dst.id}&slug=setup`));
  assert.equal(setup.body, "back to [[overview-old-name-2|overview]]");
  const links = db.prepare(`SELECT to_slug FROM wiki_links WHERE page_id = ?`).all(setup.id).map((x: Any) => x.to_slug);
  assert.deepEqual(links, ["overview-old-name-2"]);
  assert.deepEqual(db.prepare(`SELECT to_slug FROM wiki_links WHERE page_id = ?`).all(renamed.id).map((x: Any) => x.to_slug), ["setup"]);
  // The target's own overview is untouched.
  assert.equal((await ok<Any>("GET", `/wiki/pages/${tOverview.id}`)).page.body, "target overview");
});

test("G-059: aliases resolve on upsert and never create a project", async () => {
  const src = await proj();
  const dst = await proj();
  await ok("POST", `/projects/${src.id}/merge`, { into: dst.id });
  const n = projectRows();
  const c = await ok<Any>("POST", "/context", { project: { key: src.key, name: "again", remote: "git@github.com:test/old.git" }, prompt: "" });
  assert.equal(c.project.id, dst.id);
  assert.equal(projectRows(), n, "no new row for an alias key");
  await turn([{ role: "user", text: "from the old checkout" }], src);
  assert.equal(projectRows(), n);
  assert.equal(Number((db.prepare(`SELECT project_id FROM turns ORDER BY id DESC LIMIT 1`).get() as Any).project_id), dst.id);
  doneTurns();
  const p = await ok<Any>("GET", `/projects/${dst.id}`);
  assert.equal(p.remote, "git@github.com:test/old.git");
  assert.ok(p.last_seen_at);
  // Search by the old key works too.
  assert.equal((await call("GET", `/wiki/pages?project=${encodeURIComponent(src.key)}`)).status, 200);
});

test("G-060: policy and description rules", async () => {
  const setPolicy = (id: number, text: string) => ok("PUT", "/policy", { project_id: id, text });
  const policy = async (id: number) => (await ok<Any>("GET", `/policy?project_id=${id}`)).text;

  // both: target kept, source appended under a marker.
  let s = await proj("src-both");
  let t = await proj();
  await setPolicy(s.id, "source rule");
  await setPolicy(t.id, "target rule");
  await ok("PATCH", `/projects/${s.id}`, { description: "source desc" });
  await ok("PATCH", `/projects/${t.id}`, { description: "target desc" });
  let pv = await ok<Any>("GET", `/projects/${s.id}/merge-preview?into=${t.id}`);
  assert.equal(pv.policy, "both");
  assert.equal(pv.description, "target");
  let r = await ok<Any>("POST", `/projects/${s.id}/merge`, { into: t.id });
  assert.equal(await policy(t.id), "target rule\n\n--- (merged from src-both) ---\nsource rule");
  assert.equal(r.target.description, "target desc");
  assert.equal(Number((db.prepare(`SELECT COUNT(*) AS n FROM curation_policies WHERE project_id = ?`).get(s.id) as Any).n), 0);

  // source: target had none.
  s = await proj();
  t = await proj();
  await setPolicy(s.id, "only source");
  await ok("PATCH", `/projects/${s.id}`, { description: "only source desc" });
  pv = await ok<Any>("GET", `/projects/${s.id}/merge-preview?into=${t.id}`);
  assert.equal(pv.policy, "source");
  assert.equal(pv.description, "source");
  r = await ok<Any>("POST", `/projects/${s.id}/merge`, { into: t.id });
  assert.equal(await policy(t.id), "only source");
  assert.equal(r.target.description, "only source desc");

  // target: source had none.
  s = await proj();
  t = await proj();
  await setPolicy(t.id, "only target");
  pv = await ok<Any>("GET", `/projects/${s.id}/merge-preview?into=${t.id}`);
  assert.equal(pv.policy, "target");
  await ok("POST", `/projects/${s.id}/merge`, { into: t.id });
  assert.equal(await policy(t.id), "only target");
});

test("G-060: 400 same id or missing into, 404 unknown, 409 while a job or turn is pending", async () => {
  const s = await proj();
  const t = await proj();
  const same = await call("POST", `/projects/${s.id}/merge`, { into: s.id });
  assert.equal(same.status, 400);
  assert.equal(same.data.error, "cannot merge a project into itself");
  for (const r of [await call("GET", `/projects/${s.id}/merge-preview`), await call("POST", `/projects/${s.id}/merge`, {})]) {
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "into is required");
  }
  for (const r of [await call("GET", `/projects/${s.id}/merge-preview?into=abc`), await call("POST", `/projects/${s.id}/merge`, { into: 0 })]) {
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "invalid id");
  }
  assert.equal((await call("POST", `/projects/${s.id}/merge`, { into: 999999 })).status, 404);
  assert.equal((await call("GET", `/projects/999999/merge-preview?into=${t.id}`)).status, 404);

  const job = db.prepare(`INSERT INTO wiki_jobs (project_id, kind, payload) VALUES (?, 'compose', '{"turns":[]}')`).run(t.id);
  for (const r of [await call("GET", `/projects/${s.id}/merge-preview?into=${t.id}`), await call("POST", `/projects/${s.id}/merge`, { into: t.id })]) {
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "a job is running for one of these projects — try again when it finishes");
  }
  db.prepare(`UPDATE wiki_jobs SET status = 'done' WHERE id = ?`).run(job.lastInsertRowid);

  db.prepare(`INSERT INTO graph_jobs (payload) VALUES (?)`).run(JSON.stringify({ entries: [], projectId: s.id }));
  assert.equal((await call("POST", `/projects/${s.id}/merge`, { into: t.id })).status, 409);
  db.exec(`UPDATE graph_jobs SET status = 'done'`);

  db.prepare(`INSERT INTO review_jobs (project_id) VALUES (?)`).run(s.id);
  assert.equal((await call("POST", `/projects/${s.id}/merge`, { into: t.id })).status, 409);
  db.exec(`UPDATE review_jobs SET status = 'done'`);

  await turn([{ role: "user", text: "pending turn" }], s);
  assert.equal((await call("POST", `/projects/${s.id}/merge`, { into: t.id })).status, 409);
  doneTurns();

  // Refused merges changed nothing; now it goes through and moves the jobs too.
  assert.ok((await ok<Any>("GET", `/projects/${s.id}`)).id);
  const r = await ok<Any>("POST", `/projects/${s.id}/merge`, { into: t.id });
  assert.equal(r.moved.review_jobs, 1);
  assert.equal(r.moved.turns, 1);
  const g = db.prepare(`SELECT payload FROM graph_jobs ORDER BY id DESC LIMIT 1`).get() as Any;
  assert.equal(JSON.parse(g.payload).projectId, t.id);
});

test("G-059: merging into a project with aliases, and a chain A→B→C", async () => {
  const a = await proj();
  const b = await proj();
  const c = await proj();
  const ma = await entry({ project_id: a.id, title: "memory from A" });
  await ok("POST", `/projects/${a.id}/merge`, { into: b.id });
  assert.deepEqual((await ok<Any>("GET", `/projects/${b.id}`)).aliases, [a.key]);

  // Merging another project into B keeps B's aliases.
  const d = await proj();
  await ok("POST", `/projects/${d.id}/merge`, { into: b.id });
  assert.deepEqual((await ok<Any>("GET", `/projects/${b.id}`)).aliases.sort(), [a.key, d.key].sort());

  // B into C: B's key and B's aliases all resolve to C.
  const pv = await ok<Any>("GET", `/projects/${b.id}/merge-preview?into=${c.id}`);
  assert.deepEqual(pv.aliases.slice().sort(), [b.key, a.key, d.key].sort());
  assert.equal(pv.aliases[0], b.key);
  const n = projectRows();
  await ok("POST", `/projects/${b.id}/merge`, { into: c.id });
  assert.equal(projectRows(), n - 1);
  assert.deepEqual((await ok<Any>("GET", `/projects/${c.id}`)).aliases.sort(), [a.key, b.key, d.key].sort());
  for (const key of [a.key, b.key, d.key]) {
    const r = await ctx(key);
    assert.equal(r.project.id, c.id, key);
    assert.ok(r.included.includes(ma.id), key);
  }
  assert.equal(projectRows(), n - 1, "resolving aliases created nothing");
  assert.equal(Number((db.prepare(`SELECT COUNT(*) AS n FROM project_aliases WHERE project_id NOT IN (SELECT id FROM projects)`).get() as Any).n), 0);
});

test("G-060: deleting the merged project frees its aliases", async () => {
  const s = await proj();
  const t = await proj();
  await ok("POST", `/projects/${s.id}/merge`, { into: t.id });
  await ok("DELETE", `/projects/${t.id}`);
  const again = await ctx(s.key);
  assert.notEqual(again.project.id, t.id);
  assert.equal(again.project.key, s.key);
});

test("G-060: composed turns stay composed, jobs and pending proposals are counted and moved, a rename alone leaves a revision", async () => {
  const { composableTurns } = await import("../src/wiki.ts");
  const src = await proj("composed-src");
  const dst = await proj();
  const t1 = await turn([{ role: "user", text: "composed already" }], src);
  const t2 = await turn([{ role: "user", text: "composed in both scopes" }], src);
  doneTurns();
  db.prepare(`INSERT INTO wiki_composed (scope, turn_id) VALUES (?, ?)`).run(src.id, t1.id);
  db.prepare(`INSERT INTO wiki_composed (scope, turn_id) VALUES (?, ?)`).run(src.id, t2.id);
  db.prepare(`INSERT INTO wiki_composed (scope, turn_id) VALUES (?, ?)`).run(dst.id, t2.id); // OR IGNORE path
  db.prepare(`INSERT INTO wiki_jobs (project_id, kind, payload, status) VALUES (?, 'compose', '{"turns":[]}', 'done')`).run(src.id);
  const rj = Number(db.prepare(`INSERT INTO review_jobs (project_id, status) VALUES (?, 'done')`).run(src.id).lastInsertRowid);
  const prop = db.prepare(`INSERT INTO review_proposals (job_id, kind, entry_ids, status) VALUES (?, 'delete', '[]', ?)`);
  prop.run(rj, "pending");
  prop.run(rj, "applied");
  // A conflicting page with no links: only its slug changes.
  const lone = await page(src.id, "notes", "plain");
  await page(dst.id, "notes", "target notes");

  const pv = await ok<Any>("GET", `/projects/${src.id}/merge-preview?into=${dst.id}`);
  assert.equal(pv.counts.wiki_jobs, 1);
  assert.equal(pv.counts.review_jobs, 1);
  assert.equal(pv.counts.review_proposals_pending, 1);
  const revsBefore = total("wiki_revisions");
  const r = await ok<Any>("POST", `/projects/${src.id}/merge`, { into: dst.id });
  assert.deepEqual(r.moved, pv.counts);
  const scopeRows = (scope: number) => Number((db.prepare(`SELECT COUNT(*) AS n FROM wiki_composed WHERE scope = ?`).get(scope) as Any).n);
  assert.equal(scopeRows(src.id), 0);
  assert.equal(scopeRows(dst.id), 2);
  const uncomposed = composableTurns(dst.id, { uncomposed: true }).map((x) => x.id);
  assert.ok(!uncomposed.includes(t1.id) && !uncomposed.includes(t2.id), "composed turns are not composed again");
  assert.equal(Number((db.prepare(`SELECT COUNT(*) AS n FROM wiki_jobs WHERE project_id = ?`).get(dst.id) as Any).n), 1);
  assert.equal(Number((db.prepare(`SELECT project_id FROM review_jobs WHERE id = ?`).get(rj) as Any).project_id), dst.id);

  assert.equal(total("wiki_revisions"), revsBefore + 1);
  const rev = db.prepare(`SELECT body, reason FROM wiki_revisions WHERE page_id = ? ORDER BY id DESC LIMIT 1`).get(lone.id) as Any;
  assert.equal(rev.body, "plain");
  assert.match(rev.reason, /project merge: .* renamed from notes$/);
});

test("G-060: a merged policy over the policy limit is refused before anything changes", async () => {
  const s = await proj();
  const t = await proj();
  await ok("PUT", "/policy", { project_id: s.id, text: "s".repeat(2500) });
  await ok("PUT", "/policy", { project_id: t.id, text: "t".repeat(2500) });
  for (const r of [await call("GET", `/projects/${s.id}/merge-preview?into=${t.id}`), await call("POST", `/projects/${s.id}/merge`, { into: t.id })]) {
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "policy is too long (max 4000)");
  }
  assert.ok((await ok<Any>("GET", `/projects/${s.id}`)).id);
  // Shortened enough, it goes through and stays editable.
  await ok("PUT", "/policy", { project_id: s.id, text: "s".repeat(1000) });
  await ok("POST", `/projects/${s.id}/merge`, { into: t.id });
  const text = (await ok<Any>("GET", `/policy?project_id=${t.id}`)).text;
  assert.ok(text.length <= 4000);
  await ok("PUT", "/policy", { project_id: t.id, text: text + "!" });
});

test("G-060: a merge that fails midway rolls everything back", async () => {
  const s = await proj("rollback-src");
  const t = await proj();
  const other = await proj();
  const e = await entry({ project_id: s.id, title: "stays in source" });
  const sp = await page(s.id, "overview", "self [[overview]]");
  await page(t.id, "overview", "target");
  // The last step (source key → alias) hits the primary key.
  db.prepare(`INSERT INTO project_aliases (key, project_id) VALUES (?, ?)`).run(s.key, other.id);
  await ok("POST", "/projects/similar/dismiss", { a: s.id, b: other.id });
  const revs = total("wiki_revisions");
  const links = db.prepare(`SELECT to_slug FROM wiki_links WHERE page_id = ?`).all(sp.id).map((x: Any) => x.to_slug);

  const r = await call("POST", `/projects/${s.id}/merge`, { into: t.id });
  assert.equal(r.status, 500);
  assert.ok((await ok<Any>("GET", `/projects/${s.id}`)).id, "source row still there");
  assert.equal(Number((db.prepare(`SELECT project_id FROM entries WHERE id = ?`).get(e.id) as Any).project_id), s.id);
  const pg = db.prepare(`SELECT project_id, slug, body FROM wiki_pages WHERE id = ?`).get(sp.id) as Any;
  assert.deepEqual({ project_id: Number(pg.project_id), slug: pg.slug, body: pg.body }, { project_id: s.id, slug: "overview", body: "self [[overview]]" });
  assert.equal(total("wiki_revisions"), revs);
  assert.deepEqual(db.prepare(`SELECT to_slug FROM wiki_links WHERE page_id = ?`).all(sp.id).map((x: Any) => x.to_slug), links);
  const pairs = db.prepare(`SELECT a, b FROM project_pair_dismissed WHERE a IN (?, ?) OR b IN (?, ?)`).all(s.id, t.id, s.id, t.id).map((x: Any) => [x.a, x.b]);
  assert.deepEqual(pairs, [[Math.min(s.id, other.id), Math.max(s.id, other.id)]], "dismissed pairs unchanged");
  db.prepare(`DELETE FROM project_aliases WHERE key = ?`).run(s.key);
});

test("G-060: a target turn being curated blocks the merge, a pending one does not", async () => {
  const s = await proj();
  const t = await proj();
  const tt = await turn([{ role: "user", text: "target turn" }], t);
  // Pending: curated after the merge with the moved memories in view.
  assert.equal((await call("GET", `/projects/${s.id}/merge-preview?into=${t.id}`)).status, 200);
  db.prepare(`UPDATE turns SET status = 'processing' WHERE id = ?`).run(tt.id);
  for (const r of [await call("GET", `/projects/${s.id}/merge-preview?into=${t.id}`), await call("POST", `/projects/${s.id}/merge`, { into: t.id })]) {
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "a job is running for one of these projects — try again when it finishes");
  }
  db.prepare(`UPDATE turns SET status = 'pending' WHERE id = ?`).run(tt.id);
  await ok("POST", `/projects/${s.id}/merge`, { into: t.id });
  assert.equal((db.prepare(`SELECT status, project_id FROM turns WHERE id = ?`).get(tt.id) as Any).project_id, t.id);
  doneTurns();
});

test("G-060: dismissed similar-project pairs move to the target, the pair with the target itself goes", async () => {
  const s = await proj();
  const t = await proj();
  const x = await proj();
  const y = await proj();
  for (const [a, b] of [[s, t], [s, x], [y, s], [t, y]]) await ok("POST", "/projects/similar/dismiss", { a: a.id, b: b.id });
  await ok("POST", `/projects/${s.id}/merge`, { into: t.id });
  const pairs = db
    .prepare(`SELECT a, b FROM project_pair_dismissed WHERE a IN (?, ?, ?, ?) OR b IN (?, ?, ?, ?) ORDER BY a, b`)
    .all(s.id, t.id, x.id, y.id, s.id, t.id, x.id, y.id)
    .map((r: Any) => [r.a, r.b]);
  const pair = (p: number, q: number) => [Math.min(p, q), Math.max(p, q)];
  assert.deepEqual(pairs, [pair(t.id, x.id), pair(t.id, y.id)].sort((m, n) => m[0] - n[0] || m[1] - n[1]));
});
