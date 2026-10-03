// The revision list says up front which entity reverts and which retiring-link
// restores would fail, with the same checks the revert itself runs (G-041):
// entity name taken / moved, merge target gone, nothing to revert, and addLink's
// supersedes cycle / cross-project refusals.
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, db, entry, ok, project } from "./helpers.ts";
import { ApiError, describeError, revertBlockText } from "../../web/src/errors.ts";

type Any = any;
const revisions = (q = "") => ok<Any[]>("GET", `/graph/revisions?limit=500${q}`);
const revert = (id: number) => call<Any>("POST", `/graph/revisions/${id}/revert`);
const find = async (q: string, target: string, action: string) => (await revisions(q)).find((r) => r.target === target && r.action === action)!;
const entityIdsOf = async (id: number): Promise<number[]> => (await ok<Any>("GET", `/entries/${id}`)).entities.map((e: Any) => e.id);
const revisionCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM graph_revisions`).get() as Any).n;

/** List and revert agree: blocked ⇔ the revert fails with the same message, writes nothing, stays unreverted. */
async function assertBlocked(rev: Any, code: string, status = 409) {
  assert.equal(rev.revertible, false);
  assert.equal(rev.blocked?.code, code);
  // A RULES translation, not the generic fallback (which is Korean too and appends the raw message).
  assert.equal(describeError(new ApiError(status, rev.blocked.message)).known, true, `no Korean rule for: ${rev.blocked.message}`);
  const text = revertBlockText(rev.blocked);
  assert.match(text, /[가-힣]/, "the web shows the reason in Korean");
  assert.ok(!text.includes(rev.blocked.message), "translated, not the raw message in parentheses");
  const n = revisionCount();
  const r = await revert(rev.id);
  assert.equal(r.status, status, JSON.stringify(r.data));
  assert.equal(r.data.error, rev.blocked.message);
  assert.equal(revisionCount(), n, "nothing recorded");
  const again = (await revisions()).find((x) => x.id === rev.id);
  assert.equal(again.reverted_at, null);
  assert.deepEqual(again.blocked, rev.blocked, "the full list says the same");
}

test("G-041: an entity rename whose old name now belongs to another entity is listed as blocked (name_taken)", async () => {
  const m = await entry({ title: "g3 osprey 1", entities: ["Osprey One"] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Osprey Two" });
  let up = await find(`&entity_id=${id}`, "entity", "update");
  assert.equal(up.revertible, true);
  assert.equal(up.blocked, null);
  // The old spelling is set free (as if the alias had been dropped) and taken by a new entity.
  db.prepare(`DELETE FROM entity_aliases WHERE norm = 'ospreyone'`).run();
  const m2 = await entry({ title: "g3 osprey 2", entities: ["Osprey One"] });
  const [other] = await entityIdsOf(m2.id);
  assert.notEqual(other, id);
  up = await find(`&entity_id=${id}`, "entity", "update");
  assert.equal(up.blocked.entity_id, other);
  await assertBlocked(up, "name_taken");
});

test("G-041: an entity update already back at its old values is listed as nothing_to_revert (G-034)", async () => {
  const m = await entry({ title: "g3 plover", entities: ["Plover Foo"] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Plover Bar" });
  await ok("PATCH", `/entities/${id}`, { name: "Plover Foo" });
  const revs = await revisions(`&entity_id=${id}`);
  const [second, first] = revs;
  assert.equal(second.revertible, true, "the later rename still has something to undo");
  await assertBlocked(first, "nothing_to_revert");
  // The later one reverts as listed; then the first has something to do again (the name changed).
  assert.equal((await revert(second.id)).status, 200);
  const again = (await revisions(`&entity_id=${id}`)).find((r) => r.id === first.id);
  assert.equal(again.blocked, null);
  assert.equal(again.revertible, true);
});

test("G-041: an entity update whose only effect left is an alias change stays revertible", async () => {
  const m = await entry({ title: "g3 dunlin", entities: ["Dunlin Foo"] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Dunlin Bar" });
  const [up] = await revisions(`&entity_id=${id}`);
  // Back to the old name by hand, but keep the alias of the old spelling around
  // (as a pre-plan database might): the revert still has an alias to drop.
  db.prepare(`UPDATE entities SET name = 'Dunlin Foo', norm = 'dunlinfoo' WHERE id = ?`).run(id);
  db.prepare(`INSERT OR REPLACE INTO entity_aliases (norm, entity_id) VALUES ('dunlinfoo', ?)`).run(id);
  const rev = (await revisions(`&entity_id=${id}`)).find((r) => r.id === up.id);
  assert.equal(rev.blocked, null);
  const r = await revert(up.id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.revert.snapshot.aliases_removed, ["dunlinfoo"]);
  assert.equal(db.prepare(`SELECT 1 FROM entity_aliases WHERE norm = 'dunlinfoo'`).get(), undefined);
});

test("G-041: a merge whose target was deleted is listed as merge_target_gone", async () => {
  await entry({ title: "g3 skua", entities: ["Skua From", "Skua Into"] });
  const from = (await ok<Any>("GET", `/graph/neighbors?entity=Skua%20From`)).entity.id;
  const into = (await ok<Any>("GET", `/graph/neighbors?entity=Skua%20Into`)).entity.id;
  await ok("POST", `/entities/${from}/merge`, { into });
  assert.equal((await find(`&entity_id=${from}`, "entity", "merge")).revertible, true);
  await ok("DELETE", `/entities/${into}`);
  const merge = await find(`&entity_id=${from}`, "entity", "merge");
  assert.equal(merge.blocked.entity_id, into);
  await assertBlocked(merge, "merge_target_gone");
});

test("G-041: a merge whose merged-away name now resolves elsewhere is listed as name_moved", async () => {
  await entry({ title: "g3 tern", entities: ["Noddy From", "Noddy Into", "Noddy Third"] });
  const id = async (n: string) => (await ok<Any>("GET", `/graph/neighbors?entity=${encodeURIComponent(n)}`)).entity.id;
  const [from, into, third] = [await id("Noddy From"), await id("Noddy Into"), await id("Noddy Third")];
  await ok("POST", `/entities/${from}/merge`, { into });
  db.prepare(`UPDATE entity_aliases SET entity_id = ? WHERE norm = 'noddyfrom'`).run(third);
  const merge = await find(`&entity_id=${from}`, "entity", "merge");
  assert.equal(merge.blocked.entity_id, third);
  await assertBlocked(merge, "name_moved");
});

test("G-041: a merge whose target took the merged-away name is listed as name_taken", async () => {
  await entry({ title: "g3 murre", entities: ["Murre From", "Murre Into"] });
  const id = async (n: string) => (await ok<Any>("GET", `/graph/neighbors?entity=${encodeURIComponent(n)}`)).entity.id;
  const [from, into] = [await id("Murre From"), await id("Murre Into")];
  await ok("POST", `/entities/${from}/merge`, { into });
  await ok("PATCH", `/entities/${into}`, { name: "Murre From" });
  const merge = await find(`&entity_id=${from}`, "entity", "merge");
  assert.equal(merge.blocked.entity_id, into);
  await assertBlocked(merge, "name_taken");
});

test("G-041: a delete whose name is now another entity's alias is listed as name_taken (G-020)", async () => {
  const m = await entry({ title: "g3 auk 1", entities: ["Auk Foo"] });
  const [id] = await entityIdsOf(m.id);
  await ok("DELETE", `/entities/${id}`);
  assert.equal((await find(`&entity_id=${id}`, "entity", "delete")).revertible, true);
  const m2 = await entry({ title: "g3 auk 2", entities: ["Auk Foo"] });
  const [newId] = await entityIdsOf(m2.id);
  await ok("PATCH", `/entities/${newId}`, { name: "Auk Bar" }); // alias "aukfoo" → newId
  const del = await find(`&entity_id=${id}`, "entity", "delete");
  assert.equal(del.blocked.entity_id, newId);
  await assertBlocked(del, "name_taken");
});

test("G-041: a retiring supersedes removal that would close a cycle is listed as supersedes_cycle; a trashed memory is endpoint_trashed until restored", async () => {
  const a = await entry({ title: "g3 cycle A" });
  const b = await entry({ title: "g3 cycle B" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "supersedes" });
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=supersedes`);
  await ok("POST", `/entries/${b.id}/links`, { to: a.id, type: "supersedes" });
  const rm = async () => (await revisions(`&entry_id=${a.id}`)).find((r) => r.action === "remove" && r.snapshot.from_id === a.id)!;
  // In the trash: restore first (addLink's 404), listed as endpoint_trashed.
  await ok("DELETE", `/entries/${b.id}`);
  await assertBlocked(await rm(), "endpoint_trashed", 404);
  await ok("POST", `/entries/${b.id}/restore`);
  await assertBlocked(await rm(), "supersedes_cycle");
  assert.equal(db.prepare(`SELECT 1 FROM entry_links WHERE from_id = ? AND to_id = ?`).get(a.id, b.id), undefined);
});

test("G-041: a retiring supersedes removal across projects is listed as cross_project, and revert keeps addLink's 400", async () => {
  const p = await project("github.com/test/g3-cross", "g3-cross");
  const a = await entry({ project_id: p.id, title: "g3 cross project A" });
  const g = await entry({ title: "g3 cross global G" });
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', 'llm', 1)`).run(a.id, g.id);
  await ok("DELETE", `/entries/${a.id}/links?to=${g.id}&type=supersedes`);
  const rm = (await revisions(`&entry_id=${g.id}`)).find((r) => r.action === "remove")!;
  assert.equal(rm.snapshot.retires, 1);
  await assertBlocked(rm, "cross_project", 400);
  assert.equal(db.prepare(`SELECT 1 FROM entry_links WHERE from_id = ? AND to_id = ?`).get(a.id, g.id), undefined);
});
