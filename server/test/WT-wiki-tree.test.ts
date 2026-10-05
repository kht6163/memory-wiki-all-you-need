// Wiki page tree (ADR-0036): parent_id on pages, one checked write path
// (movePage), suggest-only grouping for flat wikis (G-066), the agent and the
// compose LLM naming a parent, and the web's pure tree module.
import assert from "node:assert/strict";
import { test } from "node:test";

const { call, db, llmDefault, llmReset, ok, project, runQueueOnce, turn } = await import("./helpers.ts");
const { suggestTree, treeOrder } = await import("../src/wiki-tree.ts");
const { MAX_TREE_DEPTH } = await import("../src/wiki.ts");
const tree = await import("../../web/src/wiki-tree.ts");

type Any = any;
const page = (b: Any) => ok<Any>("POST", "/wiki/pages", b);
const get = (id: number) => ok<Any>("GET", `/wiki/pages/${id}`).then((r) => r.page);
const revs = (id: number) => Number((db.prepare("SELECT COUNT(*) AS n FROM wiki_revisions WHERE page_id = ?").get(id) as Any).n);
let seq = 0;
const freshProject = () => project(`github.com/test/tree-${++seq}`, `tree-${seq}`);

test("G-066: parent_id is set on create and by PATCH; a move bumps updated_at but writes no revision; revert never moves", async () => {
  const p = await freshProject();
  const top = await page({ project_id: p.id, slug: "decisions", title: "Decisions", body: "list" });
  const child = await page({ project_id: p.id, slug: "adr-1", title: "ADR 1", body: "one", parent_id: top.id });
  assert.equal(child.parent_id, top.id);
  const loose = await page({ project_id: p.id, slug: "loose", title: "Loose", body: "v1" });
  assert.equal(loose.parent_id, null);
  const before = revs(loose.id);
  await ok("PATCH", `/wiki/pages/${loose.id}`, { body: "v2" });
  const moved = await ok<Any>("PATCH", `/wiki/pages/${loose.id}`, { parent_id: top.id });
  assert.equal(moved.parent_id, top.id);
  assert.ok(moved.updated_at >= loose.updated_at);
  assert.equal(revs(loose.id), before + 1, "only the body edit made a revision");
  const history = (await ok<Any>("GET", `/wiki/pages/${loose.id}`)).revisions;
  await ok("POST", `/wiki/pages/${loose.id}/revert`, { revisionId: history.at(-1).id });
  const reverted = await get(loose.id);
  assert.equal(reverted.body, "v1");
  assert.equal(reverted.parent_id, top.id, "revert keeps the page where it is");
  assert.equal((await ok<Any>("PATCH", `/wiki/pages/${loose.id}`, { parent_id: null })).parent_id, null);
  // a move and an edit together
  const both = await ok<Any>("PATCH", `/wiki/pages/${loose.id}`, { parent_id: top.id, title: "Loose (moved)" });
  assert.equal(both.parent_id, top.id);
  assert.equal(both.title, "Loose (moved)");
});

test("G-066: self, a descendant, another wiki, the trash, a missing page and too deep are refused", async () => {
  const p = await freshProject();
  const other = await freshProject();
  const a = await page({ project_id: p.id, slug: "a", title: "A", body: "x" });
  const b = await page({ project_id: p.id, slug: "b", title: "B", body: "x", parent_id: a.id });
  const c = await page({ project_id: p.id, slug: "c", title: "C", body: "x", parent_id: b.id });
  const elsewhere = await page({ project_id: other.id, slug: "e", title: "E", body: "x" });
  const global = await page({ project_id: null, slug: `g-${seq}`, title: "G", body: "x" });
  const bad = async (id: number, parent_id: unknown, status: number, error: RegExp) => {
    const r = await call<Any>("PATCH", `/wiki/pages/${id}`, { parent_id });
    assert.equal(r.status, status, JSON.stringify(parent_id));
    assert.match(r.data.error, error);
  };
  await bad(a.id, a.id, 400, /own parent/);
  await bad(a.id, c.id, 400, /under this one/);
  await bad(a.id, elsewhere.id, 400, /same wiki/);
  await bad(a.id, global.id, 400, /same wiki/);
  await bad(global.id, a.id, 400, /same wiki/);
  await bad(a.id, 999999, 404, /parent page not found/);
  await bad(a.id, "3", 400, /page id or null/);
  const trashed = await page({ project_id: p.id, slug: "t", title: "T", body: "x" });
  await ok("DELETE", `/wiki/pages/${trashed.id}`);
  await bad(a.id, trashed.id, 400, /trash/);
  // depth: a chain of MAX_TREE_DEPTH levels is fine, one more is not (also via a subtree move)
  let parent = a.id;
  const chain = [a.id];
  for (let i = 2; i <= MAX_TREE_DEPTH; i++) {
    const n = await page({ project_id: p.id, slug: `d${i}`, title: `D${i}`, body: "x", parent_id: parent });
    chain.push(n.id);
    parent = n.id;
  }
  const r = await call<Any>("POST", "/wiki/pages", { project_id: p.id, slug: "too-deep", title: "Too deep", body: "x", parent_id: parent });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /too deep/);
  const sub = await page({ project_id: p.id, slug: "sub", title: "Sub", body: "x" });
  await page({ project_id: p.id, slug: "sub-kid", title: "Sub kid", body: "x", parent_id: sub.id });
  await bad(sub.id, chain[MAX_TREE_DEPTH - 2], 400, /too deep/);
  // nothing changed on refusal
  assert.equal((await get(a.id)).parent_id, null);
});

test("G-066: a deleted parent leaves the child's parent_id for restore; the child is shown at the top level meanwhile", async () => {
  const p = await freshProject();
  const top = await page({ project_id: p.id, slug: "top", title: "Top", body: "x" });
  const kid = await page({ project_id: p.id, slug: "kid", title: "Kid", body: "x", parent_id: top.id });
  await ok("DELETE", `/wiki/pages/${top.id}`);
  const live = await ok<Any[]>("GET", `/wiki/pages?project_id=${p.id}`);
  assert.equal(live.find((x) => x.id === kid.id).parent_id, top.id);
  const roots = tree.buildTree(live);
  assert.ok(roots.some((n) => n.page.id === kid.id), "orphan shown at the top level");
  await ok("POST", `/wiki/pages/${top.id}/restore`);
  const back = tree.buildTree(await ok<Any[]>("GET", `/wiki/pages?project_id=${p.id}`));
  assert.deepEqual(back.find((n) => n.page.id === top.id)!.children.map((n) => n.page.id), [kid.id]);
});

test("G-066: suggestions never write; on a production-shaped wiki they are exactly the ADRs under the index and part 2 under part 1", async () => {
  const p = await freshProject();
  const mk = (slug: string, title: string, body: string) => page({ project_id: p.id, slug, title, body });
  const adrs = [];
  for (const n of ["0001-stages", "0002-context", "0003-rules", "0004-concurrency"]) adrs.push(await mk(`adr-${n}`, `ADR ${n}`, `[[adr-index]] [[analysis]]`));
  const index = await mk("adr-index", "ADR 목록", adrs.map((a) => `[[${a.slug}]]`).join(" ") + " [[analysis]]");
  await mk("analysis", "Analysis of old projects", "[[adr-index]] [[adr-0001-stages]]");
  const exp = await mk("experiments", "Experiments (1/2)", "[[experiments-2]]");
  const exp2 = await mk("experiments-2", "Experiments (2/2)", "[[experiments]]");
  await mk("review-log", "Review log", "x");
  await mk("review", "Review", "x");
  await mk("overview", "Overview", adrs.map((a) => `[[${a.slug}]]`).join(" "));
  const before = db.prepare("SELECT id, parent_id, updated_at FROM wiki_pages WHERE project_id = ? ORDER BY id").all(p.id);
  const s = await ok<Any[]>("GET", `/wiki/tree/suggest?project_id=${p.id}`);
  assert.deepEqual(db.prepare("SELECT id, parent_id, updated_at FROM wiki_pages WHERE project_id = ? ORDER BY id").all(p.id), before, "read-only");
  assert.deepEqual(
    s.map((x) => [x.page.slug, x.parent.slug, x.reason]).sort(),
    [...adrs.map((a) => [a.slug, "adr-index", "index"]), ["experiments-2", "experiments", "continuation"]].sort(),
  );
  // apply all at once; then nothing is left to suggest
  const applied = await ok<Any[]>("POST", "/wiki/tree/apply", { moves: s.map((x) => ({ id: x.page.id, parent_id: x.parent.id })) });
  assert.equal(applied.length, 5);
  assert.equal((await get(exp2.id)).parent_id, exp.id);
  assert.equal((await get(adrs[0].id)).parent_id, index.id);
  assert.deepEqual(await ok("GET", `/wiki/tree/suggest?project_id=${p.id}`), []);
});

test("G-066: apply is all-or-nothing", async () => {
  const p = await freshProject();
  const a = await page({ project_id: p.id, slug: "a", title: "A", body: "x" });
  const b = await page({ project_id: p.id, slug: "b", title: "B", body: "x" });
  const r = await call<Any>("POST", "/wiki/tree/apply", { moves: [{ id: b.id, parent_id: a.id }, { id: a.id, parent_id: b.id }] });
  assert.equal(r.status, 400);
  assert.equal((await get(b.id)).parent_id, null, "the first move was rolled back");
  assert.equal((await call("POST", "/wiki/tree/apply", { moves: [] })).status, 400);
  for (const bad of [[null], ["x"], [{ parent_id: 1 }]]) assert.equal((await call("POST", "/wiki/tree/apply", { moves: bad })).status, 400, JSON.stringify(bad));
});

test("ADR-0036: pure suggestions skip cycles, pages that already have a parent, and overview", () => {
  const pg = (id: number, slug: string, title = slug, parent_id: number | null = null) => ({ id, slug, title, parent_id });
  const pages = [pg(1, "a-index", "A 목록"), pg(2, "a-one"), pg(3, "a-two", "a-two", 9), pg(4, "overview"), pg(5, "notes"), pg(6, "notes-2"), pg(7, "list", "목차"), pg(8, "x"), pg(9, "y")];
  const links = new Map<number, Set<string>>([
    [1, new Set(["a-one", "a-two", "overview", "notes"])],
    [7, new Set(["x", "y", "a-index"])],
    [8, new Set(["list"])],
    [9, new Set(["list"])],
    [2, new Set(["a-index"])],
  ]);
  const s = suggestTree(pages, links);
  assert.deepEqual(
    s.map((x) => [x.page.slug, x.parent.slug]),
    [
      ["a-one", "a-index"],
      ["notes-2", "notes"],
      ["x", "list"],
      ["y", "list"],
    ],
    "a-two keeps its parent; 'list' holds only pages linking back (not a-index); overview never moves",
  );
});

test("ADR-0036: wiki_write may name a parent by slug; an unknown parent is refused", async () => {
  const p = await freshProject();
  const ref = { key: p.key, name: p.name };
  await ok("POST", "/agent/wiki", { project: ref, slug: "guides", title: "Guides", body: "all guides" });
  const r = await ok<Any>("POST", "/agent/wiki", { project: ref, slug: "deploy", title: "Deploy", body: "steps", parent: "guides" });
  const guides = await ok<Any>("GET", `/wiki/by-slug?project_id=${p.id}&slug=guides`);
  assert.equal(r.page.parent_id, guides.id);
  const moved = await ok<Any>("POST", "/agent/wiki", { project: ref, slug: "deploy", body: "steps v2", parent: "" });
  assert.equal(moved.page.parent_id, null, "empty parent = top level");
  const kept = await ok<Any>("POST", "/agent/wiki", { project: ref, slug: "deploy", body: "steps v3" });
  assert.equal(kept.page.parent_id, null, "absent parent = unchanged");
  const bad = await call<Any>("POST", "/agent/wiki", { project: ref, slug: "x", title: "X", body: "y", parent: "nope" });
  assert.equal(bad.status, 404);
  assert.match(bad.data.error, /parent page "nope" not found/);
});

test("ADR-0036: compose sees the tree and may place pages; a parent created in the same reply works, a bad one is ignored", async () => {
  const p = await freshProject();
  await page({ project_id: p.id, slug: "decisions", title: "Decisions", body: "d" });
  await page({ project_id: p.id, slug: "old", title: "Old", body: "o", parent_id: (await ok<Any>("GET", `/wiki/by-slug?project_id=${p.id}&slug=decisions`)).id });
  let user = "";
  llmReset();
  llmDefault((c: { system: string; user: string }) => {
    if (!c.system.includes("You maintain a wiki")) return { ops: [], note: "nothing" };
    user = c.user;
    return {
      pages: [
        { action: "create", slug: "adr-7", title: "ADR 7", body: "seven", parent: "guides" },
        { action: "create", slug: "guides", title: "Guides", body: "g" },
        { action: "create", slug: "stray", title: "Stray", body: "s", parent: "overview" },
        { action: "create", slug: "lost", title: "Lost", body: "l", parent: "does-not-exist" },
      ],
      note: "ok",
    };
  });
  const t = await turn([{ role: "user", text: "we decided to document the deploy guide" }, { role: "assistant", text: "ok" }], { key: p.key, name: p.name }, "s-tree");
  await runQueueOnce();
  await ok("POST", "/wiki/compose", { project_id: p.id, turn_ids: [t.id] });
  await runQueueOnce();
  assert.match(user, /- old — Old \(under decisions\)/, "the prompt shows where pages sit");
  const by = async (slug: string) => ok<Any>("GET", `/wiki/by-slug?project_id=${p.id}&slug=${slug}`);
  assert.equal((await by("adr-7")).parent_id, (await by("guides")).id);
  assert.equal((await by("stray")).parent_id, null, "never under overview");
  assert.equal((await by("lost")).parent_id, null, "unknown parent ignored, page still created");
  llmReset();
});

test("ADR-0036: a project merge keeps the tree", async () => {
  const src = await freshProject();
  const dst = await freshProject();
  const top = await page({ project_id: src.id, slug: "m-top", title: "Top", body: "x" });
  const kid = await page({ project_id: src.id, slug: "m-kid", title: "Kid", body: "x", parent_id: top.id });
  await ok("POST", `/projects/${src.id}/merge`, { into: dst.id });
  const moved = await get(kid.id);
  assert.equal(moved.project_id, dst.id);
  assert.equal(moved.parent_id, top.id);
  assert.equal((await get(top.id)).project_id, dst.id);
});

test("web-ui: wiki-tree builds, filters, flattens and finds ancestors and descendants", () => {
  const pg = (id: number, parent_id: number | null, title = `p${id}`) => ({ id, parent_id, slug: `s${id}`, title });
  const pages = [pg(1, null), pg(2, 1), pg(3, 2), pg(4, null), pg(5, 99), pg(6, 7), pg(7, 6)];
  const roots = tree.buildTree(pages);
  assert.deepEqual(
    roots.map((n) => n.page.id),
    [1, 4, 5, 7],
    "missing parent → top; a cycle is cut at one edge",
  );
  const all = tree.flatten(roots, new Set(), true);
  assert.equal(all.length, pages.length, "every page exactly once");
  assert.deepEqual(
    tree.flatten(roots, new Set([1])).map((r) => r.page.id),
    [1, 4, 5, 7, 6],
  );
  assert.deepEqual(
    tree.flatten(roots, new Set()).map((r) => [r.page.id, r.depth]),
    [[1, 0], [2, 1], [3, 2], [4, 0], [5, 0], [7, 0], [6, 1]],
  );
  assert.deepEqual(tree.ancestors(pages, 3).map((p) => p.id), [1, 2]);
  assert.deepEqual(tree.ancestors(pages, 7).map((p) => p.id), [6], "cycle-safe");
  assert.deepEqual([...tree.descendantIds(pages, 1)].sort(), [2, 3]);
  const f = tree.filterTree(roots, (p) => p.id === 3);
  assert.deepEqual(tree.flatten(f, new Set(), true).map((r) => r.page.id), [1, 2, 3], "a match keeps its ancestors");
  assert.deepEqual([...tree.parentIds(roots)].sort(), [1, 2, 7]);
});

test("G-066: a trashed child still counts for depth, and a restore that no longer fits goes to the top level", async () => {
  const p = await freshProject();
  let parent: number | null = null;
  const chain: number[] = [];
  for (let i = 1; i <= MAX_TREE_DEPTH - 1; i++) {
    const n: Any = await page({ project_id: p.id, slug: `c${i}`, title: `C${i}`, body: "x", parent_id: parent });
    chain.push(n.id);
    parent = n.id;
  }
  const a = await page({ project_id: p.id, slug: "a", title: "A", body: "x" });
  const d = await page({ project_id: p.id, slug: "d", title: "D", body: "x", parent_id: a.id });
  await ok("DELETE", `/wiki/pages/${d.id}`);
  const r = await call<Any>("PATCH", `/wiki/pages/${a.id}`, { parent_id: chain.at(-1) });
  assert.equal(r.status, 400, "restoring d later would make the tree too deep");
  assert.match(r.data.error, /too deep/);
  assert.equal((await ok<Any>("PATCH", `/wiki/pages/${a.id}`, { parent_id: chain.at(-2) })).parent_id, chain.at(-2), "one level up fits");
  // A parent in the trash is kept on restore (the web shows the page at the top until it is back).
  const w = await page({ project_id: p.id, slug: "w", title: "W", body: "x" });
  db.prepare("UPDATE wiki_pages SET parent_id = ? WHERE id = ?").run(d.id, w.id);
  await ok("DELETE", `/wiki/pages/${w.id}`);
  await ok("POST", `/wiki/pages/${w.id}/restore`);
  assert.equal((await get(w.id)).parent_id, d.id, "parent in the trash: kept");
  db.prepare("UPDATE wiki_pages SET parent_id = NULL WHERE id = ?").run(w.id);
  // d comes back under a; then a kept parent_id that no longer fits (only reachable by older data) is dropped on restore.
  await ok("POST", `/wiki/pages/${d.id}/restore`);
  assert.equal((await get(d.id)).parent_id, a.id, "d fits under a");
  const z = await page({ project_id: p.id, slug: "z", title: "Z", body: "x" });
  await ok("DELETE", `/wiki/pages/${z.id}`);
  db.prepare("UPDATE wiki_pages SET parent_id = ? WHERE id = ?").run(d.id, z.id); // under d: level 9
  await ok("POST", `/wiki/pages/${z.id}/restore`);
  assert.equal((await get(z.id)).parent_id, null, "lifted to the top level");
});

test("ADR-0036: compose never moves overview and never lifts a page to the top on update", async () => {
  const p = await freshProject();
  const decisions = await page({ project_id: p.id, slug: "decisions", title: "Decisions", body: "d" });
  await page({ project_id: p.id, slug: "adr-1", title: "ADR 1", body: "a", parent_id: decisions.id });
  await page({ project_id: p.id, slug: "overview", title: "Overview", body: "o" });
  llmReset();
  llmDefault((c: { system: string; user: string }) =>
    c.system.includes("You maintain a wiki")
      ? {
          pages: [
            { action: "update", slug: "adr-1", title: "ADR 1", body: "a2", parent: "" },
            { action: "update", slug: "overview", title: "Overview", body: "o2", parent: "decisions" },
          ],
        }
      : { ops: [], note: "nothing" },
  );
  const t = await turn([{ role: "user", text: "update the adr and overview pages please" }, { role: "assistant", text: "ok" }], { key: p.key, name: p.name }, "s-tree-2");
  await runQueueOnce();
  await ok("POST", "/wiki/compose", { project_id: p.id, turn_ids: [t.id] });
  await runQueueOnce();
  const by = async (slug: string) => ok<Any>("GET", `/wiki/by-slug?project_id=${p.id}&slug=${slug}`);
  assert.equal((await by("adr-1")).body, "a2");
  assert.equal((await by("adr-1")).parent_id, decisions.id, "a person's placement kept");
  assert.equal((await by("overview")).parent_id, null, "overview never moves");
  llmReset();
});

test("ADR-0036: a suggestion that apply would refuse for depth is not offered", () => {
  const pg = (id: number, slug: string, parent_id: number | null = null) => ({ id, slug, title: slug, parent_id });
  const pages = [pg(1, "x"), pg(2, "x-2")];
  for (let i = 0; i < MAX_TREE_DEPTH - 1; i++) pages.push(pg(10 + i, `k${i}`, i ? 9 + i : 2)); // x-2 already holds a full-height chain
  assert.deepEqual(suggestTree(pages, new Map()), []);
  pages.pop();
  assert.deepEqual(suggestTree(pages, new Map()).map((s) => s.page.slug), ["x-2"]);
});

test("ADR-0037: the agent sees the wiki as a tree, and is told to place pages and write for people", async () => {
  const p = await freshProject();
  const top = await page({ project_id: p.id, slug: "decisions", title: "Decisions", body: "d" });
  const mid = await page({ project_id: p.id, slug: "adr-1", title: "ADR 1", body: "a", parent_id: top.id });
  await page({ project_id: p.id, slug: "adr-1-notes", title: "ADR 1 notes", body: "n", parent_id: mid.id });
  await page({ project_id: p.id, slug: "zeta", title: "Zeta", body: "z" });
  const r = await ok<Any>("POST", "/context", { project: { key: p.key, name: p.name }, prompt: "" });
  const block = r.system.split("<wiki-pages>\n")[1].split("\n</wiki-pages>")[0];
  assert.match(block, /^- decisions — Decisions\n  - adr-1 — ADR 1\n    - adr-1-notes — ADR 1 notes\n/m, "children indented under their parent");
  assert.match(block, /^- zeta — Zeta$/m);
  assert.match(r.system, /Pages form a tree: an indented page sits under the page above it/);
  assert.match(r.system, /give a new page a parent/);
  assert.match(r.system, /tables for anything with repeated fields/);
});

test("ADR-0037: the compose prompt carries the readability rules and allows restructuring a hard-to-read page", async () => {
  const p = await freshProject();
  let system = "";
  llmReset();
  llmDefault((c: { system: string }) => {
    if (!c.system.includes("You maintain a wiki")) return { ops: [], note: "nothing" };
    system = c.system;
    return { pages: [] };
  });
  const t = await turn([{ role: "user", text: "document how we deploy this service" }, { role: "assistant", text: "ok" }], { key: p.key, name: p.name }, "s-style");
  await runQueueOnce();
  await ok("POST", "/wiki/compose", { project_id: p.id, turn_ids: [t.id] });
  await runQueueOnce();
  assert.match(system, /builds the table of contents from them, so do not write a manual table of contents/);
  assert.match(system, /Use a table whenever items share fields/);
  assert.match(system, /you may restructure it into sections, lists and tables while keeping every fact/);
  llmReset();
});

test("ADR-0037: treeOrder lists every page once, children after their parent, cycles and missing parents at the top", () => {
  const pg = (id: number, parent_id: number | null) => ({ id, parent_id, slug: `s${id}`, title: `t${id}` });
  const order = treeOrder([pg(1, null), pg(2, 1), pg(3, 99), pg(4, 5), pg(5, 4), pg(6, 2)]);
  assert.deepEqual(
    order.map((o) => [o.page.id, o.depth]),
    [[1, 0], [2, 1], [6, 2], [3, 0], [5, 0], [4, 1]],
  );
});
