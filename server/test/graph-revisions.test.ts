// Graph edit history: link add/remove and entity update/merge/delete are
// recorded once, with enough of the previous state to revert them. Reverts
// must keep one entity per thing (G-020).
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, db, entry, ok, project } from "./helpers.ts";
import { addLink } from "../src/graph.ts";

type Any = any;

const entityIdsOf = async (id: number): Promise<number[]> => (await ok<Any>("GET", `/entries/${id}`)).entities.map((e: Any) => e.id);
const revisions = (q = "") => ok<Any[]>("GET", `/graph/revisions?limit=500${q}`);
const revert = (id: number) => call<Any>("POST", `/graph/revisions/${id}/revert`);
const linkRow = (from: number, to: number, type: string) =>
  db.prepare(`SELECT * FROM entry_links WHERE from_id = ? AND to_id = ? AND type = ?`).get(from, to, type) as Any;
const resolve = async (name: string) => (await ok<Any>("GET", `/graph/neighbors?entity=${encodeURIComponent(name)}`)).entity;

test("link add / remove are recorded once and revert both ways", async () => {
  const a = await entry({ title: "rev link A" });
  const b = await entry({ title: "rev link B" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "depends_on" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "depends_on" }); // no-op: not recorded
  let revs = await revisions(`&entry_id=${a.id}`);
  assert.equal(revs.length, 1);
  assert.equal(revs[0].target, "link");
  assert.equal(revs[0].action, "add");
  assert.equal(revs[0].author, "human");
  assert.equal(revs[0].revertible, true);
  assert.deepEqual([revs[0].snapshot.from_id, revs[0].snapshot.to_id, revs[0].snapshot.type], [a.id, b.id, "depends_on"]);

  // Revert the add → the link is gone, and the removal is itself recorded.
  const r1 = await revert(revs[0].id);
  assert.equal(r1.status, 200);
  assert.ok(r1.data.revision.reverted_at);
  assert.equal(r1.data.revert.action, "remove");
  assert.equal(r1.data.revert.snapshot.revert_of, revs[0].id);
  assert.equal(linkRow(a.id, b.id, "depends_on"), undefined);
  assert.equal((await revert(revs[0].id)).status, 409, "reverting twice is 409");

  // Revert the revert → the link is back.
  assert.equal((await revert(r1.data.revert.id)).status, 200);
  assert.ok(linkRow(a.id, b.id, "depends_on"));

  // Remove via the API: recorded once (a second remove is a no-op), with the link's author.
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=depends_on`);
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=depends_on`);
  revs = await revisions(`&entry_id=${a.id}`);
  assert.deepEqual(revs.map((r) => r.action), ["remove", "add", "remove", "add"]);
  const removed = revs[0];
  assert.equal(removed.snapshot.retires, 1);
  assert.equal(removed.snapshot.link_author, "human");
  assert.equal((await revert(removed.id)).status, 200);
  assert.ok(linkRow(a.id, b.id, "depends_on"));
});

test("link revert: deleted memory → 404, would-be supersedes cycle → 409, already existing → 409", async () => {
  const a = await entry({ title: "rev cyc A" });
  const b = await entry({ title: "rev cyc B" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "supersedes" });
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=supersedes`);
  await ok("POST", `/entries/${b.id}/links`, { to: a.id, type: "supersedes" });
  const [, removed] = await revisions(`&entry_id=${a.id}`);
  assert.equal(removed.action, "remove");
  assert.equal((await revert(removed.id)).status, 409, "B already supersedes A");
  assert.equal((await ok<Any>("GET", `/graph/revisions?entry_id=${a.id}`)).find((r: Any) => r.id === removed.id).reverted_at, null);

  const c = await entry({ title: "rev gone C" });
  await ok("POST", `/entries/${a.id}/links`, { to: c.id, type: "related" });
  await ok("DELETE", `/entries/${a.id}/links?to=${c.id}&type=related`);
  const [rm] = await revisions(`&entry_id=${c.id}`);
  await ok("DELETE", `/entries/${c.id}`);
  assert.equal((await revert(rm.id)).status, 404);
  await ok("POST", `/entries/${c.id}/restore`);
  await ok("POST", `/entries/${a.id}/links`, { to: c.id, type: "related" });
  assert.equal((await revert(rm.id)).status, 409, "the link exists again");
});

test("a legacy supersedes link turned on records an add whose revert turns it off again", async () => {
  const a = await entry({ title: "rev legacy A" });
  const b = await entry({ title: "rev legacy B" });
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', 'llm', 0)`).run(a.id, b.id);
  assert.equal(addLink(a.id, b.id, "supersedes", "llm"), true);
  const [add] = await revisions(`&entry_id=${a.id}`);
  assert.equal(add.action, "add");
  assert.equal(add.author, "llm");
  assert.deepEqual(add.snapshot.prior, { retires: 0, author: "llm" });
  const r = await revert(add.id);
  assert.equal(r.status, 200);
  assert.equal(linkRow(a.id, b.id, "supersedes").retires, 0, "kept, informational again");
  assert.equal((await revert(r.data.revert.id)).status, 200);
  assert.equal(linkRow(a.id, b.id, "supersedes").retires, 1);

  // Removing an informational link and reverting keeps it informational.
  db.prepare(`UPDATE entry_links SET retires = 0 WHERE from_id = ? AND to_id = ?`).run(a.id, b.id);
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=supersedes`);
  const [rm] = await revisions(`&entry_id=${a.id}`);
  assert.equal(rm.snapshot.retires, 0);
  assert.equal((await revert(rm.id)).status, 200);
  assert.equal(linkRow(a.id, b.id, "supersedes").retires, 0);
});

test("entity rename is recorded and reverted; the old name resolves to it again", async () => {
  const m = await entry({ title: "rev rename", entities: [{ name: "Kestrel Store", kind: "tool" }] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Kestrel DB", kind: "service", description: "renamed" });
  await ok("PATCH", `/entities/${id}`, { name: "Kestrel DB" }); // no change: not recorded
  const revs = await revisions(`&entity_id=${id}`);
  assert.equal(revs.length, 1);
  const up = revs[0];
  assert.equal(up.action, "update");
  assert.deepEqual(up.snapshot.before, { name: "Kestrel Store", kind: "tool", description: "" });
  assert.deepEqual(up.snapshot.after, { name: "Kestrel DB", kind: "service", description: "renamed" });
  assert.deepEqual(up.snapshot.aliases_added, ["kestrelstore"]);

  assert.equal((await revert(up.id)).status, 200);
  const ent = (await ok<Any>("GET", `/entities/${id}`)).entity;
  assert.equal(ent.name, "Kestrel Store");
  assert.equal(ent.kind, "tool");
  assert.equal(ent.description, "");
  assert.deepEqual(ent.aliases, [], "the alias the rename added is gone, the reverted name is not kept");
  assert.equal((await resolve("kestrel-store")).id, id);
  assert.equal((await call("GET", `/graph/neighbors?entity=${encodeURIComponent("Kestrel DB")}`)).status, 404);
  assert.equal((await revert(up.id)).status, 409);
});

test("rename revert is 409 when the old name now belongs to another entity (G-020)", async () => {
  const m = await entry({ title: "rev rename conflict", entities: ["Plover Cache"] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Plover KV" });
  const [up] = await revisions(`&entity_id=${id}`);
  // Drop the alias by hand (as a delete of the alias would) and let a new entity take the name.
  db.prepare(`DELETE FROM entity_aliases WHERE norm = 'plovercache'`).run();
  const other = await entry({ title: "rev rename conflict other", entities: ["Plover Cache"] });
  const [otherId] = await entityIdsOf(other.id);
  assert.notEqual(otherId, id);
  assert.equal((await revert(up.id)).status, 409);
  assert.equal((await ok<Any>("GET", `/entities/${id}`)).entity.name, "Plover KV");
});

test("merge is recorded and reverted: entity, aliases and mentions come back (G-020)", async () => {
  const m1 = await entry({ title: "rev merge only-from", entities: ["Gannet Queue"] });
  const m2 = await entry({ title: "rev merge both", entities: ["Gannet Queue", "Tern Queue"] });
  const m3 = await entry({ title: "rev merge only-into", entities: ["Tern Queue"] });
  const [from] = await entityIdsOf(m1.id);
  const [into] = await entityIdsOf(m3.id);
  await ok("PATCH", `/entities/${from}`, { name: "Gannet MQ", description: "from desc" }); // alias "gannetqueue"
  await ok("POST", `/entities/${from}/merge`, { into });
  const merge = (await revisions(`&entity_id=${from}`))[0];
  assert.equal(merge.action, "merge");
  assert.equal((await revisions(`&entity_id=${into}`)).filter((r) => r.action === "merge").length, 1);
  assert.deepEqual(merge.snapshot.entries, [m1.id, m2.id]);
  assert.deepEqual(merge.snapshot.new_target_mentions, [m1.id]);
  assert.equal(merge.snapshot.description_copied, true);
  assert.equal((await resolve("Gannet MQ")).id, into);

  // The target is renamed after the merge: the revert still works.
  await ok("PATCH", `/entities/${into}`, { name: "Tern Broker" });
  const r = await revert(merge.id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.revert.action, "unmerge");
  assert.equal(r.data.revert.revertible, true, "an unmerge can be reverted (merges again)");

  const back = (await ok<Any>("GET", `/entities/${from}`)).entity;
  assert.equal(back.id, from, "same id when free");
  assert.equal(back.name, "Gannet MQ");
  assert.equal(back.description, "from desc");
  assert.deepEqual(back.aliases, ["gannetqueue"]);
  assert.deepEqual(await entityIdsOf(m1.id), [from], "target mention added by the merge is removed");
  assert.deepEqual((await entityIdsOf(m2.id)).sort(), [from, into].sort());
  assert.deepEqual(await entityIdsOf(m3.id), [into]);
  const target = (await ok<Any>("GET", `/entities/${into}`)).entity;
  assert.equal(target.name, "Tern Broker");
  assert.equal(target.description, "", "copied description is taken back");
  assert.deepEqual(target.aliases, ["ternqueue"]);
  for (const n of ["Gannet MQ", "gannet-queue"]) assert.equal((await resolve(n)).id, from, n);
  assert.equal((await resolve("Tern Queue")).id, into);
  assert.equal((await revert(merge.id)).status, 409);
  // Reverting the unmerge merges again, recorded as a new merge that is itself revertible.
  const again = await revert(r.data.revert.id);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.revert.action, "merge");
  assert.equal(again.data.revert.snapshot.revert_of, r.data.revert.id);
  assert.equal(again.data.revert.revertible, true);
  assert.equal((await call("GET", `/entities/${from}`)).status, 404);
  assert.equal((await resolve("Gannet MQ")).id, into);
  assert.equal((await revert(r.data.revert.id)).status, 409, "reverting the unmerge twice is 409");
});

test("merge revert is 409 when the target took the merged-away name", async () => {
  const m1 = await entry({ title: "rev merge name A", entities: ["Skua Logs"] });
  const m2 = await entry({ title: "rev merge name B", entities: ["Skua Trace"] });
  const [from] = await entityIdsOf(m1.id);
  const [into] = await entityIdsOf(m2.id);
  await ok("POST", `/entities/${from}/merge`, { into });
  const [merge] = await revisions(`&entity_id=${from}`);
  await ok("PATCH", `/entities/${into}`, { name: "Skua Logs" });
  assert.equal((await revert(merge.id)).status, 409);
  assert.equal((await call("GET", `/entities/${from}`)).status, 404);
  assert.deepEqual(await entityIdsOf(m1.id), [into], "nothing changed");
});

test("delete is recorded and reverted with aliases and mentions of live memories", async () => {
  const m1 = await entry({ title: "rev delete 1", entities: ["Petrel Jobs"] });
  const m2 = await entry({ title: "rev delete 2", entities: ["Petrel Jobs"] });
  const [id] = await entityIdsOf(m1.id);
  await ok("PATCH", `/entities/${id}`, { name: "Petrel Scheduler" });
  await ok("DELETE", `/entities/${id}`);
  const [del] = await revisions(`&entity_id=${id}`);
  assert.equal(del.action, "delete");
  assert.deepEqual(del.snapshot.aliases, ["petreljobs"]);
  assert.deepEqual(del.snapshot.entries, [m1.id, m2.id]);
  assert.equal((await revisions(`&entry_id=${m2.id}`)).filter((r) => r.action === "delete").length, 1);
  await ok("DELETE", `/entries/${m2.id}/purge`);

  const r = await revert(del.id);
  assert.equal(r.status, 200);
  assert.equal(r.data.revert.action, "restore");
  const ent = (await ok<Any>("GET", `/entities/${id}`)).entity;
  assert.equal(ent.name, "Petrel Scheduler");
  assert.deepEqual(ent.aliases, ["petreljobs"]);
  assert.deepEqual(await entityIdsOf(m1.id), [id]);
  assert.equal((await resolve("petrel jobs")).id, id);
  assert.equal((await revert(del.id)).status, 409);
});

test("a bare orphan prune (no aliases, no dismissed pairs) is not recorded", async () => {
  const m = await entry({ title: "rev prune", entities: ["Shearwater Tmp"] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entries/${m.id}`, { entities: [] });
  assert.equal((await call("GET", `/entities/${id}`)).status, 404, "pruned");
  assert.deepEqual(await revisions(`&entity_id=${id}`), []);
  assert.equal((await revert(999999)).status, 404);
});

test("entity ids are never reused: a rename revert after delete does not touch a newer entity", async () => {
  const m = await entry({ title: "rev reuse A", entities: ["Alpha Thing"] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Beta Thing" });
  const [up] = await revisions(`&entity_id=${id}`);
  await ok("DELETE", `/entities/${id}`);
  const m2 = await entry({ title: "rev reuse B", entities: ["Gamma Unrelated"] });
  const [newId] = await entityIdsOf(m2.id);
  assert.ok(newId > id, "the deleted entity's id is not handed out again");

  assert.equal((await revert(up.id)).status, 404);
  const other = (await ok<Any>("GET", `/entities/${newId}`)).entity;
  assert.equal(other.name, "Gamma Unrelated");
  assert.deepEqual(other.aliases, []);
  assert.deepEqual((await revisions(`&entity_id=${id}`)).map((r) => r.action), ["delete", "update"]);
  assert.deepEqual(await revisions(`&entity_id=${newId}`), []);
});

test("delete revert is 409 when the name is now another entity's alias (G-020)", async () => {
  const m = await entry({ title: "rev heron 1", entities: ["Heron Foo"] });
  const [id] = await entityIdsOf(m.id);
  await ok("DELETE", `/entities/${id}`);
  const [del] = await revisions(`&entity_id=${id}`);
  const m2 = await entry({ title: "rev heron 2", entities: ["Heron Foo"] });
  const [newId] = await entityIdsOf(m2.id);
  await ok("PATCH", `/entities/${newId}`, { name: "Heron Bar" }); // alias "heronfoo" → newId
  const count = () => (db.prepare(`SELECT count(*) AS n FROM entities`).get() as Any).n;
  const before = count();

  assert.equal((await revert(del.id)).status, 409);
  assert.equal(count(), before);
  assert.equal((db.prepare(`SELECT entity_id FROM entity_aliases WHERE norm = 'heronfoo'`).get() as Any).entity_id, newId);
  assert.equal((await resolve("Heron Foo")).id, newId);
  assert.deepEqual(await entityIdsOf(m.id), []);
  assert.equal((await revisions(`&entity_id=${id}`))[0].reverted_at, null);
});

test("reverting the removal of a legacy (retires = 0) supersedes link restores it as it was, even in a legacy cycle or across projects", async () => {
  // A v0.5 database may hold A⇄B supersedes pairs and project → global supersedes links;
  // migration step 5 kept them informational. Removing one must stay revertible.
  const p = await project("github.com/test/rev-legacy-cycle", "rev-legacy-cycle");
  const a = await entry({ project_id: p.id, title: "rev legacy cycle A" });
  const b = await entry({ project_id: p.id, title: "rev legacy cycle B" });
  const g = await entry({ title: "rev legacy cross G" });
  const at = "2020-02-03T04:05:06.000Z";
  const ins = db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, created_at, retires) VALUES (?, ?, 'supersedes', ?, ?, 0)`);
  ins.run(a.id, b.id, "llm", at);
  ins.run(b.id, a.id, "llm", at);
  ins.run(a.id, g.id, "human", at);

  for (const [from, to, author] of [[a.id, b.id, "llm"], [a.id, g.id, "human"]] as const) {
    await ok("DELETE", `/entries/${from}/links?to=${to}&type=supersedes`);
    const rm = (await revisions(`&entry_id=${to}`)).find((r) => r.action === "remove")!;
    assert.equal(rm.snapshot.retires, 0);
    assert.equal(rm.revertible, true);
    const r = await revert(rm.id);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.revert.action, "add");
    const row = linkRow(from, to, "supersedes");
    assert.equal(row.retires, 0, "still informational");
    assert.equal(row.author, author, "original link author");
    assert.equal(row.created_at, at, "original creation time");
    // The restored add is itself revertible (removes the row again, still informational).
    const r2 = await revert(r.data.revert.id);
    assert.equal(r2.status, 200, JSON.stringify(r2.data));
    assert.equal(linkRow(from, to, "supersedes"), undefined);
    assert.equal(r2.data.revert.snapshot.retires, 0);
  }
  // Nothing got retired along the way.
  for (const x of [a, b, g]) assert.equal((await ok<Any>("GET", `/entries/${x.id}`)).entry.superseded_by, null);

  // Restoring onto a deleted memory is still 404.
  ins.run(b.id, g.id, "llm", at);
  await ok("DELETE", `/entries/${b.id}/links?to=${g.id}&type=supersedes`);
  const rm = (await revisions(`&entry_id=${g.id}`)).find((r) => r.action === "remove" && r.snapshot.from_id === b.id)!;
  await ok("DELETE", `/entries/${g.id}`);
  assert.equal((await revert(rm.id)).status, 404);
});

test("an informational (retires = 0) supersedes link does not block a new retiring link the other way", async () => {
  const a = await entry({ title: "rev info walk A" });
  const b = await entry({ title: "rev info walk B" });
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', 'llm', 0)`).run(a.id, b.id);
  // B → A retires A; the legacy A → B retires nothing, so it is no cycle.
  assert.equal(addLink(b.id, a.id, "supersedes", "human"), true);
  assert.equal((await ok<Any>("GET", `/entries/${a.id}`)).entry.superseded_by, b.id);
  assert.equal((await ok<Any>("GET", `/entries/${b.id}`)).entry.superseded_by, null);
});

test("merge revert is 409 while the merge target is deleted; restoring the target first keeps every alias with its own entity (G-020)", async () => {
  const graphRevCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM graph_revisions`).get() as Any).n;
  // Bad order first: merge revert before the target's delete revert.
  const setup = async (tag: string) => {
    const ma = await entry({ title: `rev order A ${tag}`, entities: [`Ayy One ${tag}`] });
    const mb = await entry({ title: `rev order B ${tag}`, entities: [`Bee One ${tag}`] });
    const [A] = await entityIdsOf(ma.id);
    const [B] = await entityIdsOf(mb.id);
    await ok("PATCH", `/entities/${A}`, { name: `Ayy Two ${tag}` }); // alias "ayyone<tag>"
    await ok("POST", `/entities/${A}/merge`, { into: B });
    const [merge] = await revisions(`&entity_id=${A}`);
    await ok("DELETE", `/entities/${B}`);
    const [del] = await revisions(`&entity_id=${B}`);
    assert.equal(merge.action, "merge");
    assert.equal(del.action, "delete");
    return { A, B, merge, del, tag };
  };
  const check = async (s: { A: number; B: number; tag: string }) => {
    assert.equal((await resolve(`Ayy One ${s.tag}`)).id, s.A, "old spelling of A resolves to A");
    assert.equal((await resolve(`Ayy Two ${s.tag}`)).id, s.A);
    assert.equal((await resolve(`Bee One ${s.tag}`)).id, s.B);
    assert.deepEqual((await ok<Any>("GET", `/entities/${s.B}`)).entity.aliases, []);
  };

  const s1 = await setup("x");
  const before = graphRevCount();
  const bad = await revert(s1.merge.id);
  assert.equal(bad.status, 409, JSON.stringify(bad.data));
  assert.match(String(bad.data.error), /restore/);
  assert.equal(graphRevCount(), before, "nothing written");
  assert.equal((await revisions(`&entity_id=${s1.A}`)).find((r) => r.id === s1.merge.id).reverted_at, null);
  assert.equal((await revert(s1.del.id)).status, 200);
  assert.equal((await revert(s1.merge.id)).status, 200);
  await check(s1);

  // Good order from the start gives the same result.
  const s2 = await setup("y");
  assert.equal((await revert(s2.del.id)).status, 200);
  assert.equal((await revert(s2.merge.id)).status, 200);
  await check(s2);
});

test("reverting an entity update whose values are already back is 409 and records nothing (G-034)", async () => {
  const m = await entry({ title: "rev noop", entities: [{ name: "Foo Four", kind: "tool" }] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Bar Four" });
  await ok("PATCH", `/entities/${id}`, { name: "Foo Four" });
  const revs = await revisions(`&entity_id=${id}`);
  const rev1 = revs[revs.length - 1];
  assert.deepEqual(rev1.snapshot.before.name, "Foo Four");
  const ent = () => (db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as Any);
  const updatedAt = ent().updated_at;
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM graph_revisions`).get() as Any).n;
  const r = await revert(rev1.id);
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.match(String(r.data.error), /nothing to revert/);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM graph_revisions`).get() as Any).n, count);
  assert.equal(ent().updated_at, updatedAt);
  assert.equal((await revisions(`&entity_id=${id}`)).find((x) => x.id === rev1.id).reverted_at, null);
  assert.equal((await resolve("Bar Four")).id, id, "the alias from the first rename is untouched");
});
