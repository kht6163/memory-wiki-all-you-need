// Graph scopes (ADR-0048, G-082): the web shows one project or the shared (global / user) memories;
// a bare #/graph picks one. Every memory at once stays in the API (and around a focus) only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { graphScopeHref, neighbourhood, pickGraphScope } from "../../web/src/graph-layout.ts";

const { entry, ok, project } = await import("./helpers.ts");

type Any = any;
const memIds = (g: Any): number[] => g.nodes.filter((n: Any) => n.type === "memory").map((n: Any) => n.entryId).sort((a: number, b: number) => a - b);

const heron = "Heron Queue";

test("G-082: /graph?scope=shared holds the global and user memories only, with their entities and links", async () => {
  const p = await project("github.com/test/g082-scope", "g082-scope");
  const mine = await entry({ project_id: p.id, title: "g082 project memory", entities: [heron] });
  const glob = await entry({ title: "g082 global memory", entities: [heron] });
  const user = await entry({ scope: "user", title: "g082 user memory", entities: ["Ibis Lib"] });
  const bare = await entry({ title: "g082 global without entities" });
  await entry({ category: "standing", title: "g082 standing rule", entities: [heron] });
  await ok("POST", `/entries/${glob.id}/links`, { to: user.id, type: "related" });
  await ok("POST", `/entries/${glob.id}/links`, { to: mine.id, type: "related" });

  const g = await ok<Any>("GET", "/graph?scope=shared");
  const ids = memIds(g);
  for (const id of [glob.id, user.id, bare.id]) assert.ok(ids.includes(id), `shared memory ${id} is in`);
  assert.ok(!ids.includes(mine.id), "a project memory is not in the shared scope");
  assert.ok(g.nodes.every((n: Any) => n.type !== "memory" || n.scope === "global" || n.scope === "user"));
  assert.ok(g.nodes.some((n: Any) => n.type === "entity" && n.label === heron));
  assert.equal(g.nodes.find((n: Any) => n.label === heron).count, 1, "only the shared mention counts");
  assert.ok(g.edges.some((e: Any) => e.type === "related" && e.source === `m${glob.id}` && e.target === `m${user.id}`));
  assert.ok(!g.edges.some((e: Any) => e.target === `m${mine.id}`), "no edge to a node outside the scope");
  assert.ok(g.unlinked >= 1, "unlinked counts shared memories");

  // The API's every-memory view is still there (focus links and API users).
  const all = memIds(await ok<Any>("GET", "/graph"));
  for (const id of [mine.id, glob.id, user.id]) assert.ok(all.includes(id));
});

test("G-082: a shared backfill queues only global and user memories without entities", async () => {
  const p = await project("github.com/test/g082-backfill", "g082-backfill");
  const projBare = await entry({ project_id: p.id, title: "g082 bf project bare" });
  const globBare = await entry({ title: "g082 bf global bare" });
  const userBare = await entry({ scope: "user", title: "g082 bf user bare" });
  const job = await ok<Any>("POST", "/graph/backfill", { scope: "shared" });
  assert.equal(job.payload.shared, true);
  assert.equal(job.payload.projectId, null);
  assert.ok(job.payload.entries.includes(globBare.id) && job.payload.entries.includes(userBare.id));
  assert.ok(!job.payload.entries.includes(projBare.id), "a project memory is not in a shared backfill");
  await ok("POST", `/graph/jobs/${job.id}/cancel`);
});

test("G-082: a bare #/graph opens the last scope, else the biggest project, else the shared scope", () => {
  const projects = [
    { id: 1, entry_count: 5 },
    { id: 2, entry_count: 694 },
    { id: 3, entry_count: 291 },
  ];
  assert.equal(pickGraphScope(null, projects), 2, "the project with the most memories");
  assert.equal(pickGraphScope("3", projects), 3, "the scope viewed last");
  assert.equal(pickGraphScope("shared", projects), "shared");
  assert.equal(pickGraphScope("99", projects), 2, "a deleted or merged-away project falls back");
  assert.equal(pickGraphScope("junk", projects), 2);
  assert.equal(pickGraphScope(null, []), "shared", "no project yet");
  assert.equal(pickGraphScope(null, [{ id: 7, entry_count: 0 }]), "shared", "no project has memories");
  assert.equal(graphScopeHref(3), "/graph?project=3");
  assert.equal(graphScopeHref("shared", "m12"), "/graph?scope=shared&focus=m12");
});

test("G-082: the graph page has no every-memory scope option; the bare route redirects", () => {
  const src = readFileSync(new URL("../../web/src/pages/GraphView.tsx", import.meta.url), "utf8");
  assert.ok(!/<option value="">전체<\/option>/.test(src), "no \"전체\" scope option");
  assert.match(src, /<option value="shared">/);
  assert.match(src, /if \(!props\.projectId && !props\.shared && !props\.initialFocus\) return <GraphScopeRedirect \/>/);
});

test("G-083: focus keeps two hops, not the whole connected component", () => {
  // A chain a - b - c - d - e: two hops from a are a, b, c, whatever the edge order.
  const chain = [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
    { source: "c", target: "d" },
    { source: "d", target: "e" },
  ];
  for (const edges of [chain, [...chain].reverse()]) assert.deepEqual([...neighbourhood("a", edges, 2)].sort(), ["a", "b", "c"]);
  assert.deepEqual([...neighbourhood("c", chain, 1)].sort(), ["b", "c", "d"], "both directions");
  assert.deepEqual([...neighbourhood("z", chain, 2)], ["z"], "a node without edges keeps itself");
});

test("G-083: a focus the data does not hold draws nothing, not the whole graph", () => {
  const src = readFileSync(new URL("../../web/src/pages/GraphView.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(f\.focus && !ids\.has\(f\.focus\)\) return \[\];/);
  assert.match(src, /이 노드를 그래프에서 찾지 못했습니다/);
});
