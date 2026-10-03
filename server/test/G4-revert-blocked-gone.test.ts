// The revision list also shows the two reverts that used to fail only on click
// with a 404 (G-041): a link removal whose memory is in the trash
// (endpoint_trashed) and an entity update whose entity was deleted or merged
// away (entity_gone). Both carry the revert's own 404 and message, and lift
// once the memory / entity is back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, db, entry, ok } from "./helpers.ts";
import { ApiError, describeError, revertBlockText } from "../../web/src/errors.ts";

type Any = any;
const revisions = (q = "") => ok<Any[]>("GET", `/graph/revisions?limit=500${q}`);
const revert = (id: number) => call<Any>("POST", `/graph/revisions/${id}/revert`);
const byId = async (id: number) => (await revisions()).find((r) => r.id === id)!;
const entityIdsOf = async (id: number): Promise<number[]> => (await ok<Any>("GET", `/entries/${id}`)).entities.map((e: Any) => e.id);
const revisionCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM graph_revisions`).get() as Any).n;
const linkRow = (from: number, to: number, type: string) =>
  db.prepare(`SELECT retires FROM entry_links WHERE from_id = ? AND to_id = ? AND type = ?`).get(from, to, type);

/** List and revert agree: blocked ⇔ the revert fails with the same status and message, writes nothing. */
async function assertBlocked(rev: Any, code: string, status: number) {
  assert.equal(rev.revertible, false);
  assert.equal(rev.blocked?.code, code);
  assert.equal(rev.blocked.status ?? 409, status);
  assert.equal(describeError(new ApiError(status, rev.blocked.message)).known, true, `no Korean rule for: ${rev.blocked.message}`);
  const n = revisionCount();
  const r = await revert(rev.id);
  assert.equal(r.status, status, JSON.stringify(r.data));
  assert.equal(r.data.error, rev.blocked.message);
  assert.equal(revisionCount(), n, "nothing recorded");
  const again = await byId(rev.id);
  assert.equal(again.reverted_at, null);
  assert.deepEqual(again.blocked, rev.blocked, "the full list says the same");
}

test("G-041: a link removal whose memory is in the trash is endpoint_trashed (404) until the memory is restored", async () => {
  const a = await entry({ title: "g4 trash A" });
  const b = await entry({ title: "g4 trash B" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "related" });
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=related`);
  const [rm] = await revisions(`&entry_id=${b.id}`);
  assert.equal(rm.action, "remove");
  await ok("DELETE", `/entries/${b.id}`);
  const blocked = await byId(rm.id);
  assert.equal(blocked.blocked.entry_id, b.id);
  // The revert's own message today (addLink: trash checked first).
  assert.equal(blocked.blocked.message, "both memories must exist");
  await assertBlocked(blocked, "endpoint_trashed", 404);
  assert.equal(linkRow(a.id, b.id, "related"), undefined, "never linked");
  // The web says to restore it from the trash first.
  const text = revertBlockText(blocked.blocked);
  assert.match(text, new RegExp(`#${b.id}.*휴지통.*되살리세요`));

  await ok("POST", `/entries/${b.id}/restore`);
  const back = await byId(rm.id);
  assert.equal(back.blocked, null);
  assert.equal(back.revertible, true);
  assert.equal((await revert(rm.id)).status, 200);
  assert.ok(linkRow(a.id, b.id, "related"));
});

test("G-041: the trashed end may be either side, and a legacy informational removal is blocked too", async () => {
  const a = await entry({ title: "g4 trash legacy A" });
  const b = await entry({ title: "g4 trash legacy B" });
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', 'llm', 0)`).run(a.id, b.id);
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=supersedes`);
  const [rm] = await revisions(`&entry_id=${a.id}`);
  assert.equal(rm.snapshot.retires, 0);
  await ok("DELETE", `/entries/${a.id}`);
  const blocked = await byId(rm.id);
  assert.equal(blocked.blocked.entry_id, a.id);
  await assertBlocked(blocked, "endpoint_trashed", 404);
  await ok("POST", `/entries/${a.id}/restore`);
  assert.equal((await byId(rm.id)).revertible, true);
  assert.equal((await revert(rm.id)).status, 200);
  assert.equal(Number((linkRow(a.id, b.id, "supersedes") as Any).retires), 0, "put back as it was");
});

test("G-041: one end purged and the other trashed is endpoint_purged (restoring would not help)", async () => {
  const a = await entry({ title: "g4 trash purge A" });
  const b = await entry({ title: "g4 trash purge B" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "depends_on" });
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=depends_on`);
  const [rm] = await revisions(`&entry_id=${a.id}`);
  await ok("DELETE", `/entries/${a.id}`); // from: trash
  await ok("DELETE", `/entries/${b.id}`);
  await ok("DELETE", `/entries/${b.id}/purge`); // to: gone for good
  const blocked = await byId(rm.id);
  assert.equal(blocked.blocked.entry_id, b.id);
  await assertBlocked(blocked, "endpoint_purged", 409);
});

test("G-041: a link that was added again and has a trashed end keeps the revert's 404", async () => {
  const a = await entry({ title: "g4 trash again A" });
  const b = await entry({ title: "g4 trash again B" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "related" });
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=related`);
  const [rm] = await revisions(`&entry_id=${a.id}`);
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "related" });
  await ok("DELETE", `/entries/${b.id}`);
  await assertBlocked(await byId(rm.id), "endpoint_trashed", 404);
  await ok("POST", `/entries/${b.id}/restore`);
  await assertBlocked(await byId(rm.id), "link_exists", 409);
});

test("G-041: an entity update whose entity was deleted is entity_gone (404) until the delete is reverted", async () => {
  const m = await entry({ title: "g4 gone delete", entities: ["Pipit Alpha"] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Pipit Beta" });
  const [up] = await revisions(`&entity_id=${id}`);
  assert.equal(up.action, "update");
  assert.equal(up.revertible, true);
  await ok("DELETE", `/entities/${id}`);
  const blocked = await byId(up.id);
  assert.equal(blocked.blocked.entity_id, id);
  assert.equal(blocked.blocked.message, "entity not found");
  await assertBlocked(blocked, "entity_gone", 404);
  assert.match(revertBlockText(blocked.blocked), new RegExp(`#${id}.*삭제나 합치기를 먼저 되돌리세요`));

  const del = (await revisions(`&entity_id=${id}`)).find((r) => r.action === "delete")!;
  assert.equal((await revert(del.id)).status, 200);
  const back = await byId(up.id);
  assert.equal(back.blocked, null);
  assert.equal(back.revertible, true);
  const r = await revert(up.id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await ok<Any>("GET", `/entities/${id}`)).entity.name, "Pipit Alpha");
});

test("G-041: an entity update whose entity was merged away is entity_gone until the merge is reverted", async () => {
  const m1 = await entry({ title: "g4 gone merge from", entities: ["Wagtail One"] });
  const m2 = await entry({ title: "g4 gone merge into", entities: ["Wagtail Hub"] });
  const [from] = await entityIdsOf(m1.id);
  const [into] = await entityIdsOf(m2.id);
  await ok("PATCH", `/entities/${from}`, { description: "g4 described" });
  const [up] = await revisions(`&entity_id=${from}`);
  await ok("POST", `/entities/${from}/merge`, { into });
  await assertBlocked(await byId(up.id), "entity_gone", 404);

  const merge = (await revisions(`&entity_id=${from}`)).find((r) => r.action === "merge")!;
  assert.equal(merge.revertible, true, "the merge revert recreates the entity: gone is not a block there");
  assert.equal((await revert(merge.id)).status, 200);
  const back = await byId(up.id);
  assert.equal(back.blocked, null);
  assert.equal(back.revertible, true);
  assert.equal((await revert(up.id)).status, 200);
});

test("G-041: blocked 404 messages are the same text the add-link / entity routes answer", async () => {
  // endpoint_trashed vs POST /entries/:id/links to a trashed memory.
  const a = await entry({ title: "g4 same A" });
  const b = await entry({ title: "g4 same B" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "related" });
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=related`);
  const [rm] = await revisions(`&entry_id=${b.id}`);
  await ok("DELETE", `/entries/${b.id}`);
  const trashed = (await byId(rm.id)).blocked;
  assert.equal(trashed.code, "endpoint_trashed");
  const add = await call<Any>("POST", `/entries/${a.id}/links`, { to: b.id, type: "related" });
  assert.equal(add.status, 404);
  assert.equal(add.data.error, trashed.message);

  // entity_gone vs PATCH /entities/:id on the deleted entity.
  const m = await entry({ title: "g4 same entity", entities: ["Pipit Same"] });
  const [id] = await entityIdsOf(m.id);
  await ok("PATCH", `/entities/${id}`, { name: "Pipit Same Two" });
  const [up] = await revisions(`&entity_id=${id}`);
  await ok("DELETE", `/entities/${id}`);
  const gone = (await byId(up.id)).blocked;
  assert.equal(gone.code, "entity_gone");
  const patch = await call<Any>("PATCH", `/entities/${id}`, { name: "Pipit Same Three" });
  assert.equal(patch.status, 404);
  assert.equal(patch.data.error, gone.message);
});
