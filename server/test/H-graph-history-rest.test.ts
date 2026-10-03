// The rest of the graph history (v0.6.5): orphan prunes of entities with aliases or
// dismissed pairs are recorded as revertible deletes, unmerge / restore can be
// reverted (merge / delete again), and moveLinks can record the links it drops or
// moves. Blocks follow the shared check (G-041); writes stay atomic (G-034).
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, db, entry, ok, project } from "./helpers.ts";
import { moveLinks } from "../src/graph.ts";

type Any = any;

const entityIdsOf = async (id: number): Promise<number[]> => (await ok<Any>("GET", `/entries/${id}`)).entities.map((e: Any) => e.id);
const revisions = (q = "") => ok<Any[]>("GET", `/graph/revisions?limit=500${q}`);
const revert = (id: number) => call<Any>("POST", `/graph/revisions/${id}/revert`);
const resolve = async (name: string) => (await call<Any>("GET", `/graph/neighbors?entity=${encodeURIComponent(name)}`)).data?.entity;
const revisionCount = () => Number((db.prepare(`SELECT COUNT(*) AS n FROM graph_revisions`).get() as Any).n);

test("G-057: an orphan-pruned entity with aliases is recorded and restored through revert", async () => {
  const m = await entry({ title: "H prune alias", entities: ["Kestrel Cache"] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Kestrel Store", kind: "service" }); // alias "kestrelcache"
  await ok("PATCH", `/entries/${m.id}`, { entities: [] });
  assert.equal((await call("GET", `/entities/${id}`)).status, 404, "pruned");

  const [prune] = await revisions(`&entity_id=${id}`);
  assert.equal(prune.action, "delete");
  assert.equal(prune.snapshot.reason, "orphan");
  assert.equal(prune.author, "human", "the memory edit's author");
  assert.deepEqual(prune.snapshot.aliases, ["kestrelcache"]);
  assert.deepEqual(prune.snapshot.entries, []);
  assert.equal(prune.revertible, true);
  assert.equal(prune.blocked, null);

  const r = await revert(prune.id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.revert.action, "restore");
  const back = (await ok<Any>("GET", `/entities/${id}`)).entity;
  assert.equal(back.id, id, "same id");
  assert.equal(back.name, "Kestrel Store");
  assert.equal(back.kind, "service");
  assert.deepEqual(back.aliases, ["kestrelcache"]);
  // The next mention of either spelling lands on the restored entity.
  const m2 = await entry({ title: "H prune alias again", entities: ["kestrel-cache"] });
  assert.deepEqual(await entityIdsOf(m2.id), [id]);
});

test("G-057: a prune of an entity with a dismissed pair is recorded; the pair comes back", async () => {
  const a = await entry({ title: "H prune pair A", entities: ["Plover Sync"] });
  const b = await entry({ title: "H prune pair B", entities: ["Plover Syncer"] });
  const [pa] = await entityIdsOf(a.id);
  const [pb] = await entityIdsOf(b.id);
  await ok("POST", `/entities/similar/dismiss`, { a: pa, b: pb });
  await ok("PATCH", `/entries/${a.id}`, { entities: [] });
  const [prune] = await revisions(`&entity_id=${pa}`);
  assert.equal(prune?.snapshot.reason, "orphan");
  assert.deepEqual(prune.snapshot.dismissed, [pb]);
  assert.equal((await revert(prune.id)).status, 200);
  assert.ok(db.prepare(`SELECT 1 FROM entity_pair_dismissed WHERE a = ? AND b = ?`).get(Math.min(pa, pb), Math.max(pa, pb)));
});

test("G-057: a bare orphan from LLM churn is not recorded", async () => {
  const m = await entry({ title: "H prune bare", entities: ["Bare Churn Thing"] });
  const [id] = await entityIdsOf(m.id);
  const before = revisionCount();
  await ok("PATCH", `/entries/${m.id}`, { entities: [] });
  assert.equal((await call("GET", `/entities/${id}`)).status, 404);
  assert.equal(revisionCount(), before);
});

test("G-041: an orphan-prune revert whose name was taken since is blocked, and the revert agrees", async () => {
  const m = await entry({ title: "H prune taken", entities: ["Avocet Queue"] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Avocet Bus" });
  await ok("PATCH", `/entries/${m.id}`, { entities: [] });
  const [prune] = await revisions(`&entity_id=${id}`);
  const n = await entry({ title: "H prune taken new", entities: ["Avocet Bus"] });
  const [newId] = await entityIdsOf(n.id);
  assert.notEqual(newId, id, "ids are never reused (G-035)");

  const [listed] = await revisions(`&entity_id=${id}`);
  assert.equal(listed.id, prune.id);
  assert.equal(listed.revertible, false);
  assert.equal(listed.blocked.code, "name_taken");
  assert.equal(listed.blocked.entity_id, newId);
  const r = await revert(prune.id);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, listed.blocked.message);
  assert.equal((await call("GET", `/entities/${id}`)).status, 404, "nothing changed");
});

test("G-057: a restored orphan dropped by a later purge is recorded again", async () => {
  const m = await entry({ title: "H prune purge", entities: ["Dunlin Feed"] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Dunlin Stream" });
  await ok("PATCH", `/entries/${m.id}`, { entities: [] });
  const [prune] = await revisions(`&entity_id=${id}`);
  assert.equal((await revert(prune.id)).status, 200);
  // The restored entity has no mention; a purge anywhere runs the bulk prune.
  const x = await entry({ title: "H prune purge other" });
  await ok("DELETE", `/entries/${x.id}`);
  await ok("DELETE", `/entries/${x.id}/purge`);
  assert.equal((await call("GET", `/entities/${id}`)).status, 404);
  const [again] = await revisions(`&entity_id=${id}`);
  assert.equal(again.action, "delete");
  assert.equal(again.snapshot.reason, "orphan");
  assert.equal(again.author, "human", "a bulk prune is the person's purge");
  assert.equal(again.revertible, true);
  assert.equal((await revert(again.id)).status, 200);
  assert.deepEqual((await ok<Any>("GET", `/entities/${id}`)).entity.aliases, ["dunlinfeed"]);
});

test("G-034: reverting a delete revert deletes again, and that delete is revertible", async () => {
  const m = await entry({ title: "H restore again", entities: ["Turnstone API"] });
  const [id] = await entityIdsOf(m.id);
  await ok("DELETE", `/entities/${id}`);
  const [del] = await revisions(`&entity_id=${id}`);
  const r = await revert(del.id);
  assert.equal(r.data.revert.action, "restore");
  assert.equal(r.data.revert.revertible, true);

  const again = await revert(r.data.revert.id);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.revert.action, "delete");
  assert.equal(again.data.revert.snapshot.revert_of, r.data.revert.id);
  assert.deepEqual(again.data.revert.snapshot.entries, [m.id]);
  assert.equal((await call("GET", `/entities/${id}`)).status, 404);
  assert.deepEqual(await entityIdsOf(m.id), []);
  assert.equal((await revert(r.data.revert.id)).status, 409, "twice is 409");

  assert.equal((await revert(again.data.revert.id)).status, 200);
  assert.deepEqual(await entityIdsOf(m.id), [id]);
});

test("G-041: a restore whose entity is gone again is blocked as entity_gone, and the revert agrees", async () => {
  const m = await entry({ title: "H restore gone", entities: ["Sanderling DB"] });
  const [id] = await entityIdsOf(m.id);
  await ok("DELETE", `/entities/${id}`);
  const [del] = await revisions(`&entity_id=${id}`);
  const restore = (await revert(del.id)).data.revert;
  await ok("DELETE", `/entities/${id}`); // deleted again by hand
  const listed = (await revisions(`&entity_id=${id}`)).find((x) => x.id === restore.id);
  assert.equal(listed.revertible, false);
  assert.equal(listed.blocked.code, "entity_gone");
  assert.equal(listed.blocked.status, 404);
  const r = await revert(restore.id);
  assert.equal(r.status, 404);
  assert.equal(r.data.error, listed.blocked.message);
  assert.equal(listed.blocked.message, "entity not found");
});

test("G-041: an unmerge is blocked when its entity or the target is gone, and the revert agrees", async () => {
  const a = await entry({ title: "H unmerge A", entities: ["Godwit Search"] });
  const b = await entry({ title: "H unmerge B", entities: ["Godwit Index"] });
  const [from] = await entityIdsOf(a.id);
  const [into] = await entityIdsOf(b.id);
  await ok("POST", `/entities/${from}/merge`, { into });
  const [merge] = await revisions(`&entity_id=${from}`);
  const unmerge = (await revert(merge.id)).data.revert;
  assert.equal(unmerge.action, "unmerge");

  await ok("DELETE", `/entities/${into}`);
  let listed = (await revisions(`&entity_id=${from}`)).find((x) => x.id === unmerge.id);
  assert.equal(listed.blocked.code, "merge_target_gone");
  assert.equal(listed.blocked.entity_id, into);
  let r = await revert(unmerge.id);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, listed.blocked.message);

  await ok("DELETE", `/entities/${from}`);
  listed = (await revisions(`&entity_id=${from}`)).find((x) => x.id === unmerge.id);
  assert.equal(listed.blocked.code, "entity_gone", "the entity itself is checked first");
  assert.equal(listed.blocked.entity_id, from);
  r = await revert(unmerge.id);
  assert.equal(r.status, 404);
  assert.equal(r.data.error, listed.blocked.message);
  assert.equal((await call("GET", `/entities/${into}`)).status, 404, "nothing changed");
});

test("G-057: moveLinks with an author records drops and moves; without one nothing", async () => {
  const keep = await entry({ title: "H move keep" });
  const gone = await entry({ title: "H move gone" });
  const x = await entry({ title: "H move x" });
  const y = await entry({ title: "H move y" });
  const z = await entry({ title: "H move z" });
  await ok("POST", `/entries/${gone.id}/links`, { to: x.id, type: "depends_on" }); // moves to keep → x
  await ok("POST", `/entries/${y.id}/links`, { to: gone.id, type: "because" }); // moves to y → keep
  await ok("POST", `/entries/${gone.id}/links`, { to: keep.id, type: "related" }); // between the two: dropped
  await ok("POST", `/entries/${keep.id}/links`, { to: z.id, type: "depends_on" });
  await ok("POST", `/entries/${gone.id}/links`, { to: z.id, type: "depends_on" }); // duplicate of keep → z: dropped
  const w = await entry({ title: "H move w" });
  await ok("POST", `/entries/${w.id}/links`, { to: gone.id, type: "supersedes" }); // retiring, into gone: dropped (G-026)
  assert.equal(Number((db.prepare(`SELECT retires FROM entry_links WHERE from_id = ? AND to_id = ?`).get(w.id, gone.id) as Any).retires), 1);
  const maxBefore = Number((db.prepare(`SELECT MAX(id) AS id FROM graph_revisions`).get() as Any).id);
  moveLinks(gone.id, keep.id, { author: "human" });
  const recorded = (await revisions()).filter((r) => r.id > maxBefore);
  const removes = recorded.filter((r) => r.action === "remove");
  const adds = recorded.filter((r) => r.action === "add");
  assert.equal(removes.length, 5, "every link of the merged-away memory");
  assert.ok(removes.some((r) => r.snapshot.from_id === w.id && r.snapshot.type === "supersedes"), "the retiring supersedes is a remove");
  assert.ok(!adds.some((r) => r.snapshot.from_id === w.id), "and never an add");
  assert.equal(db.prepare(`SELECT 1 FROM entry_links WHERE from_id = ? AND to_id = ?`).get(w.id, keep.id), undefined, "not moved onto keep");
  assert.deepEqual(
    adds.map((r) => [r.snapshot.from_id, r.snapshot.to_id, r.snapshot.type]).sort(),
    [[keep.id, x.id, "depends_on"], [y.id, keep.id, "because"]].sort(),
  );
  for (const r of adds) assert.equal(r.snapshot.moved_from, gone.id);
  const links = db.prepare(`SELECT from_id, to_id, type FROM entry_links WHERE from_id IN (?, ?) OR to_id IN (?, ?) ORDER BY from_id, to_id`).all(keep.id, gone.id, keep.id, gone.id) as Any[];
  assert.equal(links.length, 3, JSON.stringify(links));

  // The merged-away memory goes to the trash: its "remove"s wait for it (G-041).
  await ok("DELETE", `/entries/${gone.id}`);
  const rm = (await revisions(`&entry_id=${gone.id}`)).find((r) => r.action === "remove" && r.snapshot.to_id === x.id);
  assert.equal(rm.blocked.code, "endpoint_trashed");
  // Reverting a move's add takes the link off the kept memory.
  const add = adds.find((r) => r.snapshot.to_id === x.id);
  assert.equal((await revert(add.id)).status, 200);
  assert.equal(db.prepare(`SELECT 1 FROM entry_links WHERE from_id = ? AND to_id = ?`).get(keep.id, x.id), undefined);
  await ok("POST", `/entries/${gone.id}/restore`);
  assert.equal((await revert(rm.id)).status, 200);
  assert.ok(db.prepare(`SELECT 1 FROM entry_links WHERE from_id = ? AND to_id = ? AND type = 'depends_on'`).get(gone.id, x.id));

  // No author: the old behavior, nothing recorded.
  const p = await entry({ title: "H move plain p" });
  const q = await entry({ title: "H move plain q" });
  await ok("POST", `/entries/${q.id}/links`, { to: x.id, type: "related" });
  const n = revisionCount();
  moveLinks(q.id, p.id);
  assert.equal(revisionCount(), n);
  assert.ok(db.prepare(`SELECT 1 FROM entry_links WHERE from_id = ? AND to_id = ?`).get(p.id, x.id));
});

test("G-057: deleting a project records the orphans it leaves (author human)", async () => {
  const p = await project("github.com/test/h-prune-project", "h-prune-project");
  const m = await entry({ title: "H prune project", project_id: p.id, entities: ["Godwit Index"] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Godwit Search" }); // alias: worth recording
  await ok("DELETE", `/projects/${p.id}`);
  assert.equal((await call("GET", `/entities/${id}`)).status, 404, "pruned with the project");
  const [prune] = await revisions(`&entity_id=${id}`);
  assert.equal(prune.action, "delete");
  assert.equal(prune.snapshot.reason, "orphan");
  assert.equal(prune.author, "human");
  assert.deepEqual(prune.snapshot.aliases, ["godwitindex"]);
});
