// Recall ranking and reach inside G-018 (bounded graph recall) and G-005
// (stable block independent of the prompt): entity boost with hub dampening
// on search hits, and a second graph hop via depends_on / because only.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.CONTEXT_BUDGET_CHARS = "400";
process.env.RECALL_BUDGET_CHARS = "3000";
delete process.env.GRAPH_RECALL_EXTRA;

const { db, entry, ok } = await import("./helpers.ts");
const { config } = await import("../src/config.ts");
const { entityBoost, searchEntries } = await import("../src/search.ts");
const { findEntity } = await import("../src/graph.ts");

const pad = (n: number) => ".".repeat(n);
/** A project-scoped memory too long to ever fit the 400-char system block. */
const longMem = (pid: number, title: string, extra: Partial<Parameters<typeof entry>[0]> = {}) =>
  entry({ scope: "project", project_id: pid, title, body: pad(420), ...extra });

let projSeq = 0;
async function proj() {
  projSeq++;
  const key = `example.com/boost/p${projSeq}`;
  const r = await ok("POST", "/context", { project: { key, name: `p${projSeq}` }, prompt: "" });
  return r.project as { id: number; key: string; name: string };
}
const ctx = (p: { key: string; name: string }, prompt: string) => ok("POST", "/context", { project: { key: p.key, name: p.name }, prompt });
const link = (from: number, to: number, type: string) => ok("POST", `/entries/${from}/links`, { to, type });
/** Memory lines of a recall block; the graph marker may itself contain "(2-hop)". */
function recallLines(recall: string) {
  return recall
    .split("\n")
    .filter((l) => l.startsWith("- [#"))
    .map((l) => ({ line: l, id: Number(/^- \[#(\d+)\]/.exec(l)![1]), via: /\(graph: (.*)\)$/.exec(l)?.[1] ?? null }));
}
const entityId = (name: string) => findEntity(name)!.id;

test("entityBoost: +50% for a rare entity, dampened for hubs", () => {
  assert.equal(entityBoost(1), 1.5);
  assert.ok(entityBoost(2) < 1.5 && entityBoost(2) > 1.49);
  assert.ok(entityBoost(40) < entityBoost(5));
  assert.ok(entityBoost(1000) > 1 && entityBoost(1000) < 1.01);
});

test("a hit mentioning a prompt entity outranks an equally matching one without it", async () => {
  const p = await proj();
  // The boosted one is written first, so it would lose the updated_at tie-break without the boost.
  const withEnt = await longMem(p.id, "parrotsync config", { entities: [{ name: "Brontivex", kind: "tech" }] });
  const plain = await longMem(p.id, "parrotsync config");
  const prompt = "parrotsync with brontivex";

  const unboosted = searchEntries(prompt, { projectId: p.id });
  assert.deepEqual(unboosted.map((h) => h.entry.id), [plain.id, withEnt.id]);
  assert.equal(unboosted[0].score, unboosted[1].score);

  const boosted = searchEntries(prompt, { projectId: p.id, boostEntities: [entityId("Brontivex")] });
  assert.deepEqual(boosted.map((h) => h.entry.id), [withEnt.id, plain.id]);
  assert.ok(Math.abs(boosted[0].score - unboosted[0].score * 1.5) < 1e-9);
  assert.equal(boosted[1].score, unboosted[0].score);

  const r = await ctx(p, prompt);
  const lines = recallLines(r.recall);
  assert.deepEqual(lines.map((x) => x.id), [withEnt.id, plain.id]);
  assert.ok(lines.every((x) => x.via === null), "boosted hits are plain search hits, not graph extras");
});

test("a hub entity (many memories) boosts less than a rare one", async () => {
  const p = await proj();
  for (let i = 0; i < 40; i++) await longMem(p.id, `filler ${i}`, { entities: [{ name: "Hubbrix", kind: "tech" }] });
  const rare = await longMem(p.id, "toucanmesh routing", { entities: [{ name: "Rarelquin", kind: "tech" }] });
  const hub = await longMem(p.id, "toucanmesh routing", { entities: [{ name: "Hubbrix", kind: "tech" }] });
  const none = await longMem(p.id, "toucanmesh routing");

  const ents = [entityId("Hubbrix"), entityId("Rarelquin")];
  const hits = searchEntries("toucanmesh hubbrix rarelquin", { projectId: p.id, boostEntities: ents });
  const score = new Map(hits.map((h) => [h.entry.id, h.score]));
  assert.deepEqual(hits.slice(0, 3).map((h) => h.entry.id), [rare.id, hub.id, none.id]);
  assert.ok(Math.abs(score.get(rare.id)! / score.get(none.id)! - entityBoost(1)) < 1e-9);
  assert.ok(Math.abs(score.get(hub.id)! / score.get(none.id)! - entityBoost(41)) < 1e-9);

  // A memory naming both entities takes the stronger (rare) boost, not the product.
  const both = await longMem(p.id, "toucanmesh routing", { entities: [{ name: "Hubbrix", kind: "tech" }, { name: "Rarelquin", kind: "tech" }] });
  const again = new Map(searchEntries("toucanmesh hubbrix rarelquin", { projectId: p.id, boostEntities: ents }).map((h) => [h.entry.id, h.score]));
  assert.ok(Math.abs(again.get(both.id)! / again.get(none.id)! - entityBoost(2)) < 1e-9);
});

test("another project's hub does not dampen this project's boost", async () => {
  const p = await proj();
  const other = await proj();
  // 40 memories in another project make the entity a hub only from there (or across all projects).
  for (let i = 0; i < 40; i++) await longMem(other.id, `elsewhere ${i}`, { entities: [{ name: "Farhubbex", kind: "tech" }] });
  const mine = await longMem(p.id, "kestrelpipe tuning", { entities: [{ name: "Farhubbex", kind: "tech" }] });
  const none = await longMem(p.id, "kestrelpipe tuning");
  const ents = [entityId("Farhubbex")];

  const score = new Map(searchEntries("kestrelpipe farhubbex", { projectId: p.id, boostEntities: ents }).map((h) => [h.entry.id, h.score]));
  assert.ok(Math.abs(score.get(mine.id)! / score.get(none.id)! - entityBoost(1)) < 1e-9);

  // Searching every project sees the whole hub.
  const all = new Map(searchEntries("kestrelpipe farhubbex", { allProjects: true, boostEntities: ents }).map((h) => [h.entry.id, h.score]));
  assert.ok(Math.abs(all.get(mine.id)! / all.get(none.id)! - entityBoost(41)) < 1e-9);
});

test("boostEntities leaves other callers unchanged", async () => {
  const p = await proj();
  const a = await longMem(p.id, "ospreylane cache", { entities: [{ name: "Ventrillo", kind: "tech" }] });
  const plain = searchEntries("ospreylane ventrillo", { projectId: p.id });
  const empty = searchEntries("ospreylane ventrillo", { projectId: p.id, boostEntities: [] });
  assert.deepEqual(empty, plain);
  assert.equal(plain[0].entry.id, a.id);
});

test("2-hop: depends_on chain A→B→C recalls C after B with the (2-hop) marker", async () => {
  const p = await proj();
  const a = await longMem(p.id, "pelicanbus consumer");
  const b = await longMem(p.id, "needs the broker");
  const c = await longMem(p.id, "broker needs the disk volume");
  await link(a.id, b.id, "depends_on");
  await link(b.id, c.id, "depends_on");

  const lines = recallLines((await ctx(p, "pelicanbus")).recall);
  assert.deepEqual(lines.map((x) => x.id), [a.id, b.id, c.id]);
  assert.equal(lines[0].via, null);
  assert.equal(lines[1].via, `depends_on #${a.id}`);
  assert.equal(lines[2].via, `depends_on #${b.id} (2-hop)`);
});

test("2-hop: because is followed too; items come after every 1-hop item", async () => {
  const p = await proj();
  const a = await longMem(p.id, "condorgate limits");
  const b1 = await longMem(p.id, "first one-hop");
  const b2 = await longMem(p.id, "second one-hop");
  const c = await longMem(p.id, "the reason behind it");
  await link(a.id, b1.id, "because");
  await link(b1.id, c.id, "because");
  await link(a.id, b2.id, "depends_on");

  const lines = recallLines((await ctx(p, "condorgate")).recall);
  assert.deepEqual(lines.map((x) => x.id), [a.id, b1.id, b2.id, c.id]);
  assert.equal(lines[3].via, `because #${b1.id} (2-hop)`);
});

test("G-018: 2-hop never exceeds GRAPH_RECALL_EXTRA", async () => {
  const p = await proj();
  const a = await longMem(p.id, "heronpipe stages");
  const hop1: number[] = [];
  const hop2: number[] = [];
  for (let i = 0; i < 3; i++) {
    const b = await longMem(p.id, `stage ${i}`);
    const c = await longMem(p.id, `stage ${i} prerequisite`);
    await link(a.id, b.id, "depends_on");
    await link(b.id, c.id, "depends_on");
    hop1.push(b.id);
    hop2.push(c.id);
  }
  const r = await ctx(p, "heronpipe");
  const lines = recallLines(r.recall);
  const extras = lines.filter((x) => x.via !== null);
  assert.equal(extras.length, config.graph.recallExtra);
  assert.deepEqual(extras.slice(0, 3).map((x) => x.id).sort(), [...hop1].sort(), "1-hop first");
  assert.equal(extras.filter((x) => x.via!.endsWith("(2-hop)")).length, config.graph.recallExtra - 3);
  assert.ok(hop2.includes(extras[3].id));
  assert.ok(lines.reduce((n, x) => n + x.line.length, 0) <= config.recallBudget);
});

test("2-hop never follows supersedes, related, or incoming links", async () => {
  const p = await proj();
  const a = await longMem(p.id, "ibisflow worker");
  const b = await longMem(p.id, "worker needs the scheduler");
  const stale = await entry({ scope: "global", title: "old scheduler notes", body: pad(420) });
  const rel = await longMem(p.id, "loosely related");
  const dependent = await longMem(p.id, "something that needs the scheduler note");
  await link(a.id, b.id, "depends_on");
  // The API refuses this link, but older data may hold it: a project memory
  // cannot retire a global one, so "stale" stays active and only the link type keeps it out.
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author) VALUES (?, ?, 'supersedes', 'human')`).run(b.id, stale.id);
  await link(b.id, rel.id, "related");
  await link(dependent.id, b.id, "depends_on");

  const r = await ctx(p, "ibisflow");
  assert.ok(!r.included.includes(stale.id), "stale is not in the system block");
  assert.ok((await ok("GET", `/entries/${stale.id}`)).entry, "stale still exists");
  assert.equal(recallLines((await ctx(p, "old scheduler")).recall)[0]?.id, stale.id, "stale is still active (recallable by search)");
  assert.deepEqual(recallLines(r.recall).map((x) => x.id), [a.id, b.id]);
});

test("G-005: the system block does not depend on boost or 2-hop recall", async () => {
  const p = await proj();
  await entry({ scope: "project", project_id: p.id, title: "short note", entities: [{ name: "Pumacore", kind: "tech" }] });
  const a = await longMem(p.id, "jaguarline setup", { entities: [{ name: "Pumacore", kind: "tech" }] });
  const b = await longMem(p.id, "depends on x");
  const c = await longMem(p.id, "depends on y");
  await link(a.id, b.id, "depends_on");
  await link(b.id, c.id, "depends_on");
  const r0 = await ctx(p, "");
  const r1 = await ctx(p, "jaguarline with pumacore");
  const r2 = await ctx(p, "something else");
  assert.equal(r1.system, r0.system);
  assert.equal(r2.system, r0.system);
  assert.ok(recallLines(r1.recall).some((x) => x.id === c.id));
  assert.ok(!r1.system.includes("(2-hop)"));
});
