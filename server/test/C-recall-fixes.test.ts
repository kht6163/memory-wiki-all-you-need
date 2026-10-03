// v0.6.1 recall / injection fixes: hub-dampened entity extras, the "N more not
// shown" line surviving a budget too small for any line, direction-distinct
// 1-hop markers, and graph link-removal reverts against purged memories.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.CONTEXT_BUDGET_CHARS = "400";
process.env.RECALL_BUDGET_CHARS = "6000";
delete process.env.GRAPH_RECALL_EXTRA;

const { call, db, entry, ok } = await import("./helpers.ts");
const { config } = await import("../src/config.ts");
const { entityBoost, entityExtraLimit, entityMentionCounts } = await import("../src/search.ts");
const { findEntity } = await import("../src/graph.ts");

type Any = any;
const pad = (n: number) => ".".repeat(n);
/** A project-scoped memory too long to ever fit the 400-char system block. */
const longMem = (pid: number, title: string, extra: Record<string, unknown> = {}) =>
  entry({ scope: "project", project_id: pid, title, body: pad(420), ...extra });

let projSeq = 0;
async function proj() {
  projSeq++;
  const key = `example.com/cfix/p${projSeq}`;
  const r = await ok("POST", "/context", { project: { key, name: `p${projSeq}` }, prompt: "" });
  return r.project as { id: number; key: string; name: string };
}
const ctx = (p: { key: string; name: string }, prompt: string) => ok("POST", "/context", { project: { key: p.key, name: p.name }, prompt });
const link = (from: number, to: number, type: string) => ok("POST", `/entries/${from}/links`, { to, type });
function recallLines(recall: string) {
  return recall
    .split("\n")
    .filter((l) => l.startsWith("- [#"))
    .map((l) => ({ line: l, id: Number(/^- \[#(\d+)\]/.exec(l)![1]), via: /\(graph: (.*)\)$/.exec(l)?.[1] ?? null }));
}
const projectSection = (system: string) => /<project-memory [^>]*>\n([\s\S]*?)\n<\/project-memory>/.exec(system)?.[1] ?? null;

// Runs first: the database has no global memories yet, so an empty project is truly empty.
test("G-044: '(no memories yet)' only when there are no active memories", async () => {
  const p = await proj();
  const empty = await ctx(p, "");
  assert.match(empty.system, /\(no memories yet\)/);

  // Two memories, each longer than the project share of a 400-char budget: no line fits.
  await longMem(p.id, "omitted one");
  await longMem(p.id, "omitted two");
  const r = await ctx(p, "");
  assert.doesNotMatch(r.system, /\(no memories yet\)/, "memories exist, they just do not fit");
  assert.equal(projectSection(r.system), "(2 more not shown — use memory_search)");
  assert.deepEqual(r.included, []);
});

test("G-042: the per-entity extra cap follows the entityBoost hub curve", () => {
  assert.equal(entityExtraLimit(1), 3);
  assert.equal(entityExtraLimit(16), 3);
  assert.equal(entityExtraLimit(17), 1);
  assert.equal(entityExtraLimit(39), 1);
  assert.equal(entityExtraLimit(40), 0);
  assert.equal(entityExtraLimit(100), 0);
  // Monotone with the boost: a smaller boost never allows more extras.
  for (let n = 1; n < 200; n++) assert.ok(entityExtraLimit(n + 1) <= entityExtraLimit(n), `n=${n}`);
  assert.ok(entityBoost(16) >= 1.4 && entityBoost(17) < 1.4);
});

test("G-042: a hub entity named in the prompt adds no unrelated newest memories", async () => {
  const p = await proj();
  const hit = await longMem(p.id, "glimmerfox rollout plan");
  const hub: number[] = [];
  for (let i = 0; i < 40; i++) hub.push((await longMem(p.id, `hub note ${i}`, { entities: [{ name: "Hubtrellis", kind: "tech" }] })).id);
  const small: number[] = [];
  for (let i = 0; i < 2; i++) small.push((await longMem(p.id, `small note ${i}`, { entities: [{ name: "Rarequill", kind: "tech" }] })).id);

  // The count is the same visible, active count the search boost uses.
  const hubId = findEntity("Hubtrellis")!.id;
  const smallId = findEntity("Rarequill")!.id;
  const counts = entityMentionCounts([hubId, smallId], p.id);
  assert.equal(counts.get(hubId), 40);
  assert.equal(counts.get(smallId), 2);

  const r = await ctx(p, "glimmerfox with hubtrellis and rarequill");
  const lines = recallLines(r.recall);
  assert.equal(lines[0].id, hit.id);
  assert.equal(lines.filter((x) => x.via === "Hubtrellis").length, 0, "hub: no newest-first extras");
  assert.deepEqual(lines.filter((x) => x.via === "Rarequill").map((x) => x.id).sort(), [...small].sort(), "small entity: still added");
  assert.ok(lines.filter((x) => x.via !== null).length <= config.graph.recallExtra);

  // Another project's memories never make this project's entity a hub.
  const q = await proj();
  const qHit = await longMem(q.id, "glimmerfox other project");
  const mine = await longMem(q.id, "own reference note", { entities: [{ name: "Hubtrellis", kind: "tech" }] });
  assert.equal(entityMentionCounts([hubId], q.id).get(hubId), 1);
  const rq = recallLines((await ctx(q, "glimmerfox with hubtrellis")).recall);
  assert.equal(rq[0].id, qHit.id);
  assert.deepEqual(rq.filter((x) => x.via === "Hubtrellis").map((x) => x.id), [mine.id]);
});

test("G-042/G-005: a mid-size entity adds exactly one extra, in recall only", async () => {
  const p = await proj();
  await entry({ scope: "project", project_id: p.id, title: "short pinned fact", pinned: true });
  const hit = await longMem(p.id, "pangolinsync migration");
  // 20 mentions: past the hub knee (16) but below 40, so buildContext must pass the
  // per-entity cap of 1 (not the global GRAPH_RECALL_EXTRA) to entityEntries.
  for (let i = 0; i < 20; i++) await longMem(p.id, `stable hub ${i}`, { entities: [{ name: "Stablehubra", kind: "tech" }] });
  assert.equal(entityExtraLimit(20), 1);
  assert.ok(config.graph.recallExtra > 1, "the global cap alone would allow more");
  const a = await ctx(p, "pangolinsync with stablehubra");
  const lines = recallLines(a.recall);
  assert.equal(lines[0].id, hit.id);
  assert.equal(lines.filter((x) => x.via === "Stablehubra").length, 1, "mid-size entity: exactly one extra");
  // The system block is unchanged by the prompt (G-005).
  const b = await ctx(p, "something else entirely");
  assert.equal(a.system, b.system);
  assert.ok(!/\(graph: [^…]/.test(a.system));
});

test("G-043: incoming 1-hop links read differently from outgoing ones", async () => {
  const p = await proj();
  const hit = await longMem(p.id, "quokkaroute gateway");
  const dep = await longMem(p.id, "outgoing dependency");
  const why = await longMem(p.id, "outgoing reason");
  const needsHit = await longMem(p.id, "incoming dependent");
  const followsHit = await longMem(p.id, "incoming consequence");
  await link(hit.id, dep.id, "depends_on");
  await link(hit.id, why.id, "because");
  await link(needsHit.id, hit.id, "depends_on");
  await link(followsHit.id, hit.id, "because");

  const r = await ctx(p, "quokkaroute");
  const via = new Map(recallLines(r.recall).map((x) => [x.id, x.via]));
  assert.equal(via.get(hit.id), null);
  // Outgoing: unchanged (#hit depends on / exists because of the shown memory).
  assert.equal(via.get(dep.id), `depends_on #${hit.id}`);
  assert.equal(via.get(why.id), `because #${hit.id}`);
  // Incoming: the shown memory depends on / follows from #hit.
  assert.equal(via.get(needsHit.id), `needs #${hit.id}`);
  assert.equal(via.get(followsHit.id), `follows from #${hit.id}`);
  // The policy explains both forms.
  assert.match(r.system, /"needs #A" \/ "follows from #A" = this memory depends on \/ exists because of #A/);
});

test("G-043: 2-hop stays outgoing-only with the unchanged marker", async () => {
  const p = await proj();
  const a = await longMem(p.id, "wombatcache front");
  const b = await longMem(p.id, "middle layer");
  const c = await longMem(p.id, "bottom layer");
  const d = await longMem(p.id, "points at middle");
  await link(a.id, b.id, "depends_on");
  await link(b.id, c.id, "depends_on");
  await link(d.id, b.id, "depends_on");
  const via = new Map(recallLines((await ctx(p, "wombatcache")).recall).map((x) => [x.id, x.via]));
  assert.equal(via.get(b.id), `depends_on #${a.id}`);
  assert.equal(via.get(c.id), `depends_on #${b.id} (2-hop)`);
  assert.ok(!via.has(d.id), "incoming links are not followed on the second hop");
});

const revisions = (q = "") => ok<Any[]>("GET", `/graph/revisions?limit=500${q}`);
const revert = (id: number) => call<Any>("POST", `/graph/revisions/${id}/revert`);
const linkRow = (from: number, to: number, type: string) =>
  db.prepare(`SELECT * FROM entry_links WHERE from_id = ? AND to_id = ? AND type = ?`).get(from, to, type) as Any;

test("G-041: reverting a link removal whose memory was purged is 409 and links nothing", async () => {
  const a = await entry({ title: "purge rev A" });
  const b = await entry({ title: "purge rev B" });
  await link(a.id, b.id, "depends_on");
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=depends_on`);
  const [removed] = await revisions(`&entry_id=${b.id}`);
  assert.equal(removed.action, "remove");

  await ok("DELETE", `/entries/${b.id}`);
  await ok("DELETE", `/entries/${b.id}/purge`);
  const r = await revert(removed.id);
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.data), new RegExp(`#${b.id} was permanently deleted`));
  assert.equal((await revisions(`&entry_id=${b.id}`)).find((x: Any) => x.id === removed.id).reverted_at, null, "stays unreverted");
  assert.equal(linkRow(a.id, b.id, "depends_on"), undefined);

  // A newer memory may take the purged id (databases without AUTOINCREMENT): never link it.
  const c = await entry({ title: "purge rev C (maybe reused id)" });
  const r2 = await revert(removed.id);
  assert.equal(r2.status, 409);
  if (c.id === b.id) assert.match(JSON.stringify(r2.data), /is now a different memory/);
  assert.equal(linkRow(a.id, c.id, "depends_on"), undefined);
});

test("G-041: an endpoint id now held by a newer memory is refused (simulated reuse)", async () => {
  const a = await entry({ title: "reuse rev A" });
  const b = await entry({ title: "reuse rev B" });
  await link(a.id, b.id, "because");
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=because`);
  const [removed] = await revisions(`&entry_id=${b.id}`);
  assert.ok(removed.snapshot.to_created_at, "endpoint creation times are recorded");
  const original = (db.prepare(`SELECT created_at FROM entries WHERE id = ?`).get(b.id) as Any).created_at;
  // Same id, different creation time: not the memory the link pointed at.
  db.prepare(`UPDATE entries SET created_at = ? WHERE id = ?`).run(new Date(Date.now() + 60_000).toISOString(), b.id);
  const r = await revert(removed.id);
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.data), new RegExp(`#${b.id} is now a different memory`));
  assert.equal(linkRow(a.id, b.id, "because"), undefined);

  // The genuine endpoints still revert normally (and a trashed one stays 404: restorable).
  db.prepare(`UPDATE entries SET created_at = ? WHERE id = ?`).run(original, b.id);
  assert.equal((await revert(removed.id)).status, 200);
  assert.ok(linkRow(a.id, b.id, "because"));
});

test("G-041: legacy snapshots without creation times fall back to 'created after the removal'", async () => {
  const a = await entry({ title: "legacy rev A" });
  const b = await entry({ title: "legacy rev B" });
  await link(a.id, b.id, "depends_on");
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=depends_on`);
  const [removed] = await revisions(`&entry_id=${b.id}`);
  // Snapshots recorded by v0.6.0 have no endpoint stamps.
  db.prepare(`UPDATE graph_revisions SET snapshot = json_remove(snapshot, '$.from_created_at', '$.to_created_at') WHERE id = ?`).run(removed.id);
  const legacy = (await revisions(`&entry_id=${b.id}`)).find((x: Any) => x.id === removed.id);
  assert.equal(legacy.snapshot.to_created_at, undefined);
  const revAt = (db.prepare(`SELECT created_at FROM graph_revisions WHERE id = ?`).get(removed.id) as Any).created_at as string;
  const original = (db.prepare(`SELECT created_at FROM entries WHERE id = ?`).get(b.id) as Any).created_at as string;
  assert.ok(original <= revAt);

  // (b) An endpoint created after the removal is a different memory: 409, nothing linked.
  db.prepare(`UPDATE entries SET created_at = ? WHERE id = ?`).run(new Date(Date.parse(revAt) + 60_000).toISOString(), b.id);
  const r = await revert(removed.id);
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.data), new RegExp(`#${b.id} is now a different memory`));
  assert.equal(linkRow(a.id, b.id, "depends_on"), undefined);

  // (a) The original memories (created before the removal) revert normally.
  db.prepare(`UPDATE entries SET created_at = ? WHERE id = ?`).run(original, b.id);
  assert.equal((await revert(removed.id)).status, 200);
  assert.ok(linkRow(a.id, b.id, "depends_on"));
});

test("G-041: a supersedes downgrade revision records stamps and refuses a purged endpoint", async () => {
  const a = await entry({ title: "downgrade rev new" });
  const b = await entry({ title: "downgrade rev old" });
  // A pre-v0.6 informational supersedes link; adding it again turns it on, and
  // reverting that add downgrades it (a "remove" revision with downgrade: true).
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', 'agent', 0)`).run(a.id, b.id);
  await link(a.id, b.id, "supersedes");
  const [added] = await revisions(`&entry_id=${b.id}`);
  assert.equal(added.action, "add");
  assert.equal(added.snapshot.prior.retires, 0);
  assert.equal((await revert(added.id)).status, 200);
  const downgrade = (await revisions(`&entry_id=${b.id}`)).find((x: Any) => x.action === "remove" && x.snapshot.downgrade);
  assert.ok(downgrade, "downgrade remove revision recorded");
  const original = (db.prepare(`SELECT created_at FROM entries WHERE id = ?`).get(b.id) as Any).created_at;
  assert.equal(downgrade.snapshot.to_created_at, original);
  assert.ok(downgrade.snapshot.from_created_at);

  // Purge the retired endpoint (drop the informational link first so it can go).
  db.prepare(`DELETE FROM entry_links WHERE from_id = ? AND to_id = ?`).run(a.id, b.id);
  await ok("DELETE", `/entries/${b.id}`);
  await ok("DELETE", `/entries/${b.id}/purge`);
  const r = await revert(downgrade.id);
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.data), new RegExp(`#${b.id} was permanently deleted`));
  assert.equal(linkRow(a.id, b.id, "supersedes"), undefined);
});
