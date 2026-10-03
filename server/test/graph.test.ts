// Memory graph: entities (mentions), typed links, neighbors, graph view,
// backfill job and orphan pruning. Guards G-017 and G-020.
//
// A small backfill chunk budget is needed, so the env is set before any
// server module loads and everything is imported dynamically.
process.env.GRAPH_BACKFILL_CHUNK_CHARS = "800";

import assert from "node:assert/strict";
import { test } from "node:test";

const { call, entry, llmCalls, llmReply, llmReset, ok, project, runQueueOnce } = await import("./helpers.ts");

type Any = any;

const health = () => ok<Any>("GET", "/health");
const entityIdsOf = async (id: number): Promise<number[]> => (await ok<Any>("GET", `/entries/${id}`)).entities.map((e: Any) => e.id);
const idsInPrompt = (user: string): number[] => [...user.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]));

// ------------------------------------------------------------------ G-017

test("G-017: soft delete hides links and mentions everywhere, restore brings them back", async () => {
  const base = await health();
  const a = await entry({ title: "g017 memory A", entities: ["Zeta Queue Lib"] });
  const b = await entry({ title: "g017 memory B", entities: ["Zeta Shared Thing"] });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "because" });

  const withLink = await health();
  assert.equal(withLink.links, base.links + 1);
  assert.equal(withLink.entities, base.entities + 2);
  const zeta = (await ok<Any[]>("GET", "/entities?q=zeta queue")).find((e) => e.name === "Zeta Queue Lib");
  assert.ok(zeta, "entity listed while its memory is live");

  await ok("DELETE", `/entries/${a.id}`);
  const afterDelete = await health();
  assert.equal(afterDelete.links, base.links, "/health links ignores a link to a deleted memory");
  assert.equal(afterDelete.entities, base.entities + 1, "entity only the deleted memory mentions is not counted");
  const nb = await ok<Any>("GET", `/graph/neighbors?id=${b.id}`);
  assert.equal(nb.kind, "memory");
  assert.ok(!nb.links.some((l: Any) => l.other.id === a.id), "neighbors of B must not show deleted A");
  const bDetail = await ok<Any>("GET", `/entries/${b.id}`);
  assert.equal(bDetail.links.length, 0);
  assert.equal((await call("GET", `/graph/neighbors?id=${a.id}`)).status, 404);
  assert.ok(!(await ok<Any[]>("GET", "/entities?q=zeta queue")).some((e) => e.name === "Zeta Queue Lib"));
  const ent = await ok<Any>("GET", `/entities/${zeta.id}`);
  assert.equal(ent.memories.length, 0, "entity page lists only live memories");
  assert.equal((await call("GET", "/graph/neighbors?entity=Zeta Queue Lib")).status, 200, "soft delete keeps the entity row");

  await ok("POST", `/entries/${a.id}/restore`);
  const restored = await health();
  assert.equal(restored.links, base.links + 1);
  assert.equal(restored.entities, base.entities + 2);
  const nb2 = await ok<Any>("GET", `/graph/neighbors?id=${b.id}`);
  assert.deepEqual(
    nb2.links.map((l: Any) => [l.other.id, l.type, l.dir]),
    [[a.id, "because", "in"]],
  );
  assert.deepEqual(await entityIdsOf(a.id), [zeta.id], "mention row survived the soft delete");
});

test("G-017: a new link needs two live memories", async () => {
  const a = await entry({ title: "g017 live end" });
  const b = await entry({ title: "g017 dead end" });
  await ok("DELETE", `/entries/${b.id}`);
  assert.equal((await call("POST", `/entries/${a.id}/links`, { to: b.id, type: "related" })).status, 404);
  assert.equal((await call("POST", `/entries/${b.id}/links`, { to: a.id, type: "related" })).status, 404);
  assert.equal((await call("POST", `/entries/${a.id}/links`, { to: 999999, type: "related" })).status, 404);
  assert.equal((await call("POST", `/entries/${a.id}/links`, { to: a.id, type: "related" })).status, 400);
  assert.equal((await call("POST", `/entries/${a.id}/links`, { to: b.id, type: "likes" })).status, 400);
  await ok("POST", `/entries/${b.id}/restore`);
  assert.equal((await call("POST", `/entries/${a.id}/links`, { to: b.id, type: "related" })).status, 201);
  // "related" is symmetric and stored once.
  await ok("POST", `/entries/${b.id}/links`, { to: a.id, type: "related" });
  assert.equal((await ok<Any>("GET", `/entries/${a.id}`)).links.length, 1);
});

test("G-017: /graph drops a soft-deleted memory's node and edges and restores them", async () => {
  const p = await project("github.com/test/g017-graph", "g017-graph");
  const a = await entry({ project_id: p.id, title: "g017 graph A", entities: ["Kestrel Cache"] });
  const b = await entry({ project_id: p.id, title: "g017 graph B", entities: ["Kestrel Cache"] });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "depends_on" });

  const g1 = await ok<Any>("GET", `/graph?project_id=${p.id}`);
  assert.ok(g1.nodes.some((n: Any) => n.id === `m${a.id}`));
  assert.ok(g1.edges.some((e: Any) => e.id === `l${a.id}-${b.id}-depends_on`));
  assert.ok(g1.edges.some((e: Any) => e.source === `m${a.id}` && e.type === "mentions"));
  assert.equal(g1.nodes.find((n: Any) => n.type === "entity" && n.label === "Kestrel Cache").count, 2);

  await ok("DELETE", `/entries/${a.id}`);
  const g2 = await ok<Any>("GET", `/graph?project_id=${p.id}`);
  assert.ok(!g2.nodes.some((n: Any) => n.id === `m${a.id}`));
  assert.ok(!g2.edges.some((e: Any) => e.source === `m${a.id}` || e.target === `m${a.id}`));
  assert.equal(g2.nodes.find((n: Any) => n.type === "entity" && n.label === "Kestrel Cache").count, 1);
  const gAll = await ok<Any>("GET", "/graph");
  assert.ok(!gAll.nodes.some((n: Any) => n.id === `m${a.id}`), "global graph view also hides it");

  await ok("POST", `/entries/${a.id}/restore`);
  const g3 = await ok<Any>("GET", `/graph?project_id=${p.id}`);
  assert.ok(g3.edges.some((e: Any) => e.id === `l${a.id}-${b.id}-depends_on`));
});

// ------------------------------------------------------------------ G-020

test("G-020: case, spaces, . _ - and trailing versions resolve to one entity", async () => {
  // Slashes are kept in the norm since v0.6.1 (a path "k8s/" is not the name "k8s").
  const variants = ["PostgreSQL 16", "postgres-ql", "Postgre_SQL", "postgre.sql", "POSTGRESQL", "  PostgreSQL   v16.1 ", "Postgre SQL"];
  const one = await entry({ title: "g020 all spellings", entities: variants });
  const ids = await entityIdsOf(one.id);
  assert.equal(ids.length, 1, "all variants on one memory collapse into one mention");
  for (const v of variants) {
    const e = await entry({ title: `g020 spelled ${v}`, entities: [v] });
    assert.deepEqual(await entityIdsOf(e.id), ids, `"${v}" resolves to the same entity`);
  }
  const ent = await ok<Any>("GET", `/entities/${ids[0]}`);
  assert.equal(ent.entity.name, "PostgreSQL", "display name drops the trailing version");
  assert.equal(ent.memories.length, variants.length + 1);
  const listed = await ok<Any[]>("GET", "/entities?q=postgres");
  assert.equal(listed.filter((e) => e.id === ids[0]).length, 1);
  assert.equal(listed.length, 1, "only one entity for PostgreSQL");
  const nb = await ok<Any>("GET", `/graph/neighbors?entity=${encodeURIComponent("postgre-sql 15")}`);
  assert.equal(nb.entity.id, ids[0]);
});

test("G-020: rename keeps the old spelling as an alias", async () => {
  const e1 = await entry({ title: "g020 rename source", entities: [{ name: "Old Widget", kind: "tool" }] });
  const [id] = await entityIdsOf(e1.id);
  const renamed = await ok<Any>("PATCH", `/entities/${id}`, { name: "New Widget" });
  assert.equal(renamed.name, "New Widget");
  assert.equal(renamed.kind, "tool");
  assert.ok(renamed.aliases.includes("oldwidget"));

  const e2 = await entry({ title: "g020 mentions the old spelling", entities: ["old-widget"] });
  assert.deepEqual(await entityIdsOf(e2.id), [id], "old spelling still resolves");
  const nb = await ok<Any>("GET", `/graph/neighbors?entity=${encodeURIComponent("OLD_WIDGET")}`);
  assert.equal(nb.entity.id, id);
  assert.equal(nb.entity.name, "New Widget");

  // Renaming back makes the old name canonical again without leaving a self-alias.
  const back = await ok<Any>("PATCH", `/entities/${id}`, { name: "Old Widget" });
  assert.ok(!back.aliases.includes("oldwidget"));
  assert.ok(back.aliases.includes("newwidget"));
});

test("G-020: renaming onto another entity's name or alias is 409", async () => {
  const a = await entry({ title: "g020 conflict A", entities: ["Falcon Proxy"] });
  const b = await entry({ title: "g020 conflict B", entities: ["Heron Proxy"] });
  const [fa] = await entityIdsOf(a.id);
  const [hb] = await entityIdsOf(b.id);
  const r1 = await call("PATCH", `/entities/${hb}`, { name: "falcon-proxy 2" });
  assert.equal(r1.status, 409);
  await ok("PATCH", `/entities/${fa}`, { name: "Osprey Proxy" }); // "falconproxy" becomes an alias of fa
  const r2 = await call("PATCH", `/entities/${hb}`, { name: "Falcon Proxy" });
  assert.equal(r2.status, 409, "an alias also counts as taken");
  const unchanged = await ok<Any>("GET", `/entities/${hb}`);
  assert.equal(unchanged.entity.name, "Heron Proxy");
  // Case-only change of its own name is fine.
  assert.equal((await ok<Any>("PATCH", `/entities/${hb}`, { name: "HERON proxy" })).name, "HERON proxy");
});

test("G-020: merge moves mentions and keeps the old names as aliases", async () => {
  const m1 = await entry({ title: "g020 uses mysql", entities: ["MySQL"] });
  const m2 = await entry({ title: "g020 uses mariadb", entities: ["MariaDB"] });
  const m3 = await entry({ title: "g020 uses both", entities: ["MySQL", "MariaDB"] });
  const [my] = await entityIdsOf(m1.id);
  const [maria] = await entityIdsOf(m2.id);
  await ok("PATCH", `/entities/${maria}`, { name: "Maria Database" }); // gives maria an alias "mariadb"

  const merged = await ok<Any>("POST", `/entities/${maria}/merge`, { into: my });
  assert.equal(merged.id, my);
  assert.ok(merged.aliases.includes("mariadatabase"), "merged entity's name becomes an alias");
  assert.ok(merged.aliases.includes("mariadb"), "merged entity's aliases move over");
  assert.equal((await call("GET", `/entities/${maria}`)).status, 404);

  const page = await ok<Any>("GET", `/entities/${my}`);
  assert.deepEqual(page.memories.map((m: Any) => m.id).sort(), [m1.id, m2.id, m3.id].sort());
  assert.deepEqual(await entityIdsOf(m3.id), [my], "a memory mentioning both has one mention after merge");
  const m4 = await entry({ title: "g020 mariadb again", entities: ["Maria-DB"] });
  assert.deepEqual(await entityIdsOf(m4.id), [my]);
  assert.equal((await ok<Any>("GET", "/graph/neighbors?entity=MariaDB")).entity.id, my);
  assert.equal((await call("POST", `/entities/${my}/merge`, { into: my })).status, 400);
});

// --------------------------------------------------------------- neighbors

test("graph/neighbors by entity respects project visibility and lists co-occurring entities", async () => {
  const p = await project("github.com/test/nb-one", "nb-one");
  const q = await project("github.com/test/nb-two", "nb-two");
  const g = await entry({ title: "nb global osprey", entities: ["Osprey Bus", "Wren Lib"] });
  const own = await entry({ project_id: p.id, title: "nb project osprey", entities: ["Osprey Bus", "Wren Lib", "Lark Tool"] });
  const other = await entry({ project_id: q.id, title: "nb other project osprey", entities: ["Osprey Bus"] });

  const noProj = await ok<Any>("GET", "/graph/neighbors?entity=osprey bus");
  assert.equal(noProj.kind, "entity");
  assert.deepEqual(noProj.memories.map((m: Any) => m.id), [g.id], "without a project only global/user memories");

  const fromP = await ok<Any>("GET", `/graph/neighbors?entity=Osprey_Bus&project_id=${p.id}`);
  const ids = fromP.memories.map((m: Any) => m.id);
  assert.ok(ids.includes(g.id) && ids.includes(own.id));
  assert.ok(!ids.includes(other.id), "another project's memory stays hidden");
  const rel = Object.fromEntries(fromP.related.map((r: Any) => [r.name, r.count]));
  assert.equal(rel["Wren Lib"], 2);
  assert.equal(rel["Lark Tool"], 1);
  assert.ok(!("Osprey Bus" in rel));

  const byKey = await ok<Any>("GET", `/graph/neighbors?entity=osprey%20bus&project=${encodeURIComponent("github.com/test/nb-two")}`);
  assert.deepEqual(byKey.memories.map((m: Any) => m.id).sort(), [g.id, other.id].sort());

  const missing = await call<Any>("GET", "/graph/neighbors?entity=Osprey");
  assert.equal(missing.status, 404);
  assert.match(JSON.stringify(missing.data), /Osprey Bus/, "404 suggests similar entities");
});

test("graph/neighbors by id returns the memory, its entities and links", async () => {
  const a = await entry({ title: "nb id A", entities: [{ name: "Plover Service", kind: "service" }] });
  const b = await entry({ title: "nb id B" });
  await ok("POST", `/entries/${b.id}/links`, { to: a.id, type: "supersedes" });
  const r = await ok<Any>("GET", `/graph/neighbors?id=${a.id}`);
  assert.equal(r.kind, "memory");
  assert.equal(r.memory.id, a.id);
  assert.deepEqual(r.entities.map((e: Any) => [e.name, e.kind]), [["Plover Service", "service"]]);
  assert.deepEqual(r.links.map((l: Any) => [l.other.id, l.type, l.dir]), [[b.id, "supersedes", "in"]]);
  assert.equal((await call("GET", "/graph/neighbors?id=987654")).status, 404);
});

// -------------------------------------------------------------- graph data

test("/graph for a project includes global memories sharing an entity and counts unlinked", async () => {
  const p = await project("github.com/test/graph-view", "graph-view");
  const own = await entry({ project_id: p.id, title: "gv own redis", entities: ["Sparrow Store"] });
  const bare = await entry({ project_id: p.id, title: "gv own without entities" });
  const bare2 = await entry({ project_id: p.id, title: "gv own without entities 2" });
  await entry({ project_id: p.id, category: "standing", title: "gv standing rule", entities: ["Sparrow Store"] });
  const shared = await entry({ title: "gv global sparrow", entities: ["sparrow-store", "Finch Lib"] });
  const unrelated = await entry({ title: "gv global unrelated", entities: ["Gull Lib"] });
  const noEnt = await entry({ title: "gv global without entities" });
  await ok("POST", `/entries/${shared.id}/links`, { to: own.id, type: "related" });

  const g = await ok<Any>("GET", `/graph?project_id=${p.id}`);
  const memIds = g.nodes.filter((n: Any) => n.type === "memory").map((n: Any) => n.entryId).sort((x: number, y: number) => x - y);
  assert.deepEqual(memIds, [own.id, bare.id, bare2.id, shared.id].sort((x, y) => x - y));
  assert.ok(!memIds.includes(unrelated.id) && !memIds.includes(noEnt.id));
  assert.equal(g.unlinked, 2, "unlinked counts the project's own memories only");
  assert.equal(g.truncated, false);
  const labels = g.nodes.filter((n: Any) => n.type === "entity").map((n: Any) => n.label).sort();
  assert.deepEqual(labels, ["Finch Lib", "Sparrow Store"]);
  assert.equal(g.nodes.find((n: Any) => n.label === "Sparrow Store").count, 2, "standing memories are not in the view");
  assert.ok(g.edges.some((e: Any) => e.type === "related" && e.source === `m${shared.id}` && e.target === `m${own.id}`));

  const limited = await ok<Any>("GET", `/graph?project_id=${p.id}&limit=1`);
  assert.equal(limited.truncated, true);
  assert.equal(limited.nodes.filter((n: Any) => n.type === "memory").length, 1);
});

// ---------------------------------------------------------------- backfill

test("backfill: entities added via the fake LLM, links only inside the batch", async () => {
  llmReset();
  const p = await project("github.com/test/backfill", "backfill");
  const short = "short body for the backfill test, nothing more.";
  const a = await entry({ project_id: p.id, category: "fact", title: "bf A", body: short });
  const b = await entry({ project_id: p.id, category: "fact", title: "bf B", body: short });
  const c = await entry({ project_id: p.id, category: "fact", title: "bf C", body: "x".repeat(1500) });
  const outsider = await entry({ title: "bf outsider global" });

  llmReply(
    (call: Any) => {
      const ids = idsInPrompt(call.user);
      assert.deepEqual(ids, [a.id, b.id], "first batch holds the two small memories");
      return {
        memories: [
          { id: a.id, entities: [{ name: "Tern Engine", kind: "tech" }], links: [{ to: b.id, type: "because" }, { to: c.id, type: "related" }, { to: outsider.id, type: "related" }] },
          { id: b.id, entities: ["Tern Engine 2", "Puffin CLI"], links: [{ to: a.id, type: "bogus" }] },
          { id: outsider.id, entities: ["Should Not Attach"] },
        ],
      };
    },
    (call: Any) => {
      assert.deepEqual(idsInPrompt(call.user), [c.id], "second batch holds the big memory alone");
      return { memories: [{ id: c.id, entities: ["Puffin CLI"], links: [{ to: a.id, type: "depends_on" }] }] };
    },
  );
  const job = await ok<Any>("POST", "/graph/backfill", { project_id: p.id });
  assert.deepEqual(job.payload.entries, [a.id, b.id, c.id]);
  assert.equal((await health()).graphPending >= 1, true);
  await runQueueOnce();
  assert.equal(llmCalls.length, 2);

  const done = (await ok<Any[]>("GET", "/graph/jobs")).find((j) => j.id === job.id);
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.equal(done.result.chunks, 2);
  assert.equal(done.result.links, 1);
  assert.equal(done.result.entities, 4);

  const aD = await ok<Any>("GET", `/entries/${a.id}`);
  assert.deepEqual(aD.entities.map((e: Any) => e.name), ["Tern Engine"]);
  assert.deepEqual(aD.links.map((l: Any) => [l.other.id, l.type, l.dir]), [[b.id, "because", "out"]]);
  const bD = await ok<Any>("GET", `/entries/${b.id}`);
  assert.deepEqual(bD.entities.map((e: Any) => e.name), ["Puffin CLI", "Tern Engine"]);
  const cD = await ok<Any>("GET", `/entries/${c.id}`);
  assert.deepEqual(cD.links, [], "a link to a memory outside the batch is dropped");
  assert.deepEqual(cD.entities.map((e: Any) => e.name), ["Puffin CLI"]);
  assert.deepEqual((await ok<Any>("GET", `/entries/${outsider.id}`)).entities, []);
  assert.equal((await call("GET", "/graph/neighbors?entity=Should Not Attach")).status, 404);

  // Everything has entities now: nothing left to backfill.
  assert.equal((await call("POST", "/graph/backfill", { project_id: p.id })).status, 400);
});

test("backfill never removes existing entities", async () => {
  llmReset();
  const p = await project("github.com/test/backfill-keep", "backfill-keep");
  const a = await entry({ project_id: p.id, title: "bfk A", entities: ["Robin Keep"] });
  llmReply({ memories: [{ id: a.id, entities: ["Stork New"] }] });
  const job = await ok<Any>("POST", "/graph/backfill", { project_id: p.id, all: true });
  await runQueueOnce();
  assert.equal(llmCalls.length, 1);
  assert.match(llmCalls[0].user, /Robin Keep/, "prompt shows the existing entities");
  const done = (await ok<Any[]>("GET", "/graph/jobs")).find((j) => j.id === job.id);
  assert.equal(done.status, "done");
  assert.equal(done.result.entities, 1, "only the addition is counted");
  const names = (await ok<Any>("GET", `/entries/${a.id}`)).entities.map((e: Any) => e.name);
  assert.deepEqual(names, ["Robin Keep", "Stork New"]);
});

test("backfill: an LLM failure marks the job error and retry finishes it", async () => {
  llmReset();
  const p = await project("github.com/test/backfill-retry", "backfill-retry");
  const a = await entry({ project_id: p.id, title: "bfr A" });
  llmReply(new Error("boom"));
  const job = await ok<Any>("POST", "/graph/backfill", { project_id: p.id });
  await runQueueOnce();
  let j = (await ok<Any[]>("GET", "/graph/jobs")).find((x) => x.id === job.id);
  assert.equal(j.status, "error");
  assert.match(j.error, /chunk 1\/1/);
  assert.deepEqual((await ok<Any>("GET", `/entries/${a.id}`)).entities, []);
  assert.equal((await call("POST", `/graph/jobs/${job.id}/retry`)).status, 200);
  llmReply({ memories: [{ id: a.id, entities: ["Swift Retry"] }] });
  await runQueueOnce();
  j = (await ok<Any[]>("GET", "/graph/jobs")).find((x) => x.id === job.id);
  assert.equal(j.status, "done");
  assert.deepEqual((await ok<Any>("GET", `/entries/${a.id}`)).entities.map((e: Any) => e.name), ["Swift Retry"]);
  assert.equal((await call("POST", `/graph/jobs/${job.id}/retry`)).status, 409, "only failed jobs retry");
});

// ----------------------------------------------------------- orphan prune

test("orphan entity is pruned when its last mention is removed, unless it has a description", async () => {
  const a = await entry({ title: "orphan A", entities: ["Magpie Gone"] });
  const b = await entry({ title: "orphan B", entities: ["Magpie Kept"] });
  const [gone] = await entityIdsOf(a.id);
  const [kept] = await entityIdsOf(b.id);
  await ok("PATCH", `/entities/${kept}`, { description: "described by a human" });

  await ok("PATCH", `/entries/${a.id}`, { entities: [] });
  await ok("PATCH", `/entries/${b.id}`, { entities: [] });
  assert.equal((await call("GET", `/entities/${gone}`)).status, 404);
  assert.equal((await call("GET", `/entities/${kept}`)).status, 200, "a described entity survives");
});

test("soft delete keeps the entity; purge and project delete prune orphans", async () => {
  const a = await entry({ title: "prune purge A", entities: ["Heron Purge"] });
  const [hp] = await entityIdsOf(a.id);
  await ok("DELETE", `/entries/${a.id}`);
  assert.equal((await call("GET", `/entities/${hp}`)).status, 200, "soft delete does not prune");
  const again = await entry({ title: "prune purge again", entities: ["heron-purge"] });
  assert.deepEqual(await entityIdsOf(again.id), [hp]);
  await ok("DELETE", `/entries/${again.id}`);
  await ok("DELETE", `/entries/${a.id}/purge`);
  assert.equal((await call("GET", `/entities/${hp}`)).status, 200, "still mentioned by another (soft-deleted) memory");
  await ok("DELETE", `/entries/${again.id}/purge`);
  assert.equal((await call("GET", `/entities/${hp}`)).status, 404, "purge of the last mention prunes");

  const p = await project("github.com/test/prune-project", "prune-project");
  const pe = await entry({ project_id: p.id, title: "prune project only", entities: ["Ibis Project Only", "Ibis Shared"] });
  const g = await entry({ title: "prune global shared", entities: ["Ibis Shared"] });
  const [onlyId, sharedId] = await Promise.all(["Ibis Project Only", "Ibis Shared"].map(async (n) => (await ok<Any>("GET", `/graph/neighbors?entity=${encodeURIComponent(n)}`)).entity.id));
  assert.equal((await entityIdsOf(pe.id)).length, 2);
  await ok("DELETE", `/projects/${p.id}`);
  assert.equal((await call("GET", `/entries/${pe.id}`)).status, 404);
  assert.equal((await call("GET", `/entities/${onlyId}`)).status, 404, "project-only entity pruned with the project");
  assert.equal((await call("GET", `/entities/${sharedId}`)).status, 200);
  assert.deepEqual(await entityIdsOf(g.id), [sharedId]);
});
