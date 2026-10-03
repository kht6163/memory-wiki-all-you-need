// The revision list says up front which link reverts would fail (purged or
// replaced memory, link gone), with the same check the revert route uses, so
// the web can disable the button instead of failing with 409 on click (G-041).
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, db, entry, ok } from "./helpers.ts";
import { describeError, revertBlockText } from "../../web/src/errors.ts";

type Any = any;
const revisions = (q = "") => ok<Any[]>("GET", `/graph/revisions?limit=500${q}`);
const revert = (id: number) => call<Any>("POST", `/graph/revisions/${id}/revert`);
const find = async (q: string, action: string) => (await revisions(q)).find((r) => r.target === "link" && r.action === action)!;

/** List and revert agree: blocked ⇔ the same status (default 409) and message. */
async function assertBlocked(rev: Any, code: string, status = 409) {
  assert.equal(rev.revertible, false);
  assert.equal(rev.blocked?.code, code);
  const r = await revert(rev.id);
  assert.equal(r.status, status);
  assert.equal(r.data.error, rev.blocked.message);
}

test("G-041: a link remove whose memory was purged is listed as not revertible, and revert agrees", async () => {
  const a = await entry({ title: "blocked purge A" });
  const b = await entry({ title: "blocked purge B" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "related" });
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=related`);
  let rm = await find(`&entry_id=${a.id}`, "remove");
  assert.equal(rm.revertible, true);
  assert.equal(rm.blocked, null);

  await ok("DELETE", `/entries/${b.id}`);
  rm = await find(`&entry_id=${a.id}`, "remove");
  assert.equal(rm.blocked?.entry_id, b.id);
  await assertBlocked(rm, "endpoint_trashed", 404);

  await ok("DELETE", `/entries/${b.id}/purge`);
  rm = await find(`&entry_id=${a.id}`, "remove");
  assert.equal(rm.blocked.entry_id, b.id);
  await assertBlocked(rm, "endpoint_purged");
  // Per-memory list and full list say the same.
  const all = (await revisions()).find((r) => r.id === rm.id);
  assert.deepEqual(all.blocked, rm.blocked);
  assert.equal(all.revertible, false);
});

test("G-041: a link remove whose memory id now names a different memory is blocked", async () => {
  const a = await entry({ title: "blocked replace A" });
  const b = await entry({ title: "blocked replace B" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "depends_on" });
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=depends_on`);
  // Simulate rowid reuse (pre-AUTOINCREMENT databases): same id, different creation time.
  db.prepare(`UPDATE entries SET created_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`).run(b.id);
  const rm = await find(`&entry_id=${a.id}`, "remove");
  assert.equal(rm.blocked.entry_id, b.id);
  await assertBlocked(rm, "endpoint_replaced");
  assert.equal(db.prepare(`SELECT 1 FROM entry_links WHERE from_id = ? AND to_id = ?`).get(a.id, b.id), undefined, "never linked");
});

test("G-041: a snapshot without creation times falls back to 'created after the removal' in the list too", async () => {
  const a = await entry({ title: "blocked stampless A" });
  const b = await entry({ title: "blocked stampless B" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "depends_on" });
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=depends_on`);
  let rm = await find(`&entry_id=${a.id}`, "remove");
  // A pre-stamp snapshot (older server): no from/to_created_at.
  db.prepare(`UPDATE graph_revisions SET snapshot = json_remove(snapshot, '$.from_created_at', '$.to_created_at') WHERE id = ?`).run(rm.id);
  rm = await find(`&entry_id=${a.id}`, "remove");
  assert.equal(rm.snapshot.to_created_at, undefined);
  assert.equal(rm.revertible, true, "original memories: not blocked");
  db.prepare(`UPDATE entries SET created_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`).run(b.id);
  rm = await find(`&entry_id=${a.id}`, "remove");
  assert.equal(rm.blocked?.entry_id, b.id);
  await assertBlocked(rm, "endpoint_replaced");
});

test("G-041: a link remove whose link was added again is blocked, in either direction for related", async () => {
  const a = await entry({ title: "blocked exists A" });
  const b = await entry({ title: "blocked exists B" });
  const c = await entry({ title: "blocked exists C" });
  // Same direction.
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "depends_on" });
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=depends_on`);
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "depends_on" });
  const rmAB = (await revisions(`&entry_id=${a.id}`)).find((r) => r.target === "link" && r.action === "remove" && r.snapshot.to_id === b.id)!;
  await assertBlocked(rmAB, "link_exists");
  // "related" is stored once: the reverse link counts as the same link.
  await ok("POST", `/entries/${a.id}/links`, { to: c.id, type: "related" });
  await ok("DELETE", `/entries/${a.id}/links?to=${c.id}&type=related`);
  let rmAC = (await revisions(`&entry_id=${c.id}`)).find((r) => r.target === "link" && r.action === "remove")!;
  assert.equal(rmAC.revertible, true);
  await ok("POST", `/entries/${c.id}/links`, { to: a.id, type: "related" });
  rmAC = (await revisions(`&entry_id=${c.id}`)).find((r) => r.id === rmAC.id)!;
  await assertBlocked(rmAC, "link_exists");
});

test("G-041: a legacy informational supersedes row does not block restoring a retiring one; a retiring one does", async () => {
  const a = await entry({ title: "blocked exists sup A" });
  const b = await entry({ title: "blocked exists sup B" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "supersedes" });
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=supersedes`);
  const rm = await find(`&entry_id=${a.id}`, "remove");
  assert.equal(rm.snapshot.retires, 1);
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', 'agent', 0)`).run(a.id, b.id);
  let now = (await revisions(`&entry_id=${a.id}`)).find((r) => r.id === rm.id)!;
  assert.equal(now.blocked, null, "addLink turns the informational row on");
  db.prepare(`UPDATE entry_links SET retires = 1 WHERE from_id = ? AND to_id = ? AND type = 'supersedes'`).run(a.id, b.id);
  now = (await revisions(`&entry_id=${a.id}`)).find((r) => r.id === rm.id)!;
  await assertBlocked(now, "link_exists");
  // Back to informational: the revert goes through and turns it on.
  db.prepare(`UPDATE entry_links SET retires = 0 WHERE from_id = ? AND to_id = ? AND type = 'supersedes'`).run(a.id, b.id);
  assert.equal((await revert(rm.id)).status, 200);
  const row = db.prepare(`SELECT retires FROM entry_links WHERE from_id = ? AND to_id = ? AND type = 'supersedes'`).get(a.id, b.id) as Any;
  assert.equal(Number(row.retires), 1);
});

test("G-041: an informational supersedes remove is blocked by any row of the link", async () => {
  const a = await entry({ title: "blocked exists info A" });
  const b = await entry({ title: "blocked exists info B" });
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', 'agent', 0)`).run(a.id, b.id);
  await ok("DELETE", `/entries/${a.id}/links?to=${b.id}&type=supersedes`);
  const rm = await find(`&entry_id=${a.id}`, "remove");
  assert.equal(rm.snapshot.retires, 0);
  assert.equal(rm.revertible, true);
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', 'agent', 0)`).run(a.id, b.id);
  await assertBlocked((await revisions(`&entry_id=${a.id}`)).find((r) => r.id === rm.id)!, "link_exists");
});

test("G-041: a link add that turned on a legacy supersedes link is blocked once it no longer retires", async () => {
  const a = await entry({ title: "blocked retiring A" });
  const b = await entry({ title: "blocked retiring B" });
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', 'agent', 0)`).run(a.id, b.id);
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "supersedes" });
  let add = await find(`&entry_id=${a.id}`, "add");
  assert.equal(add.snapshot.prior.retires, 0);
  assert.equal(add.revertible, true);
  db.prepare(`UPDATE entry_links SET retires = 0 WHERE from_id = ? AND to_id = ? AND type = 'supersedes'`).run(a.id, b.id);
  add = (await revisions(`&entry_id=${a.id}`)).find((r) => r.id === add.id)!;
  await assertBlocked(add, "link_not_retiring");
});

test("G-041: a link add whose link is gone (memory purged) is blocked; a live one stays revertible", async () => {
  const a = await entry({ title: "blocked add A" });
  const b = await entry({ title: "blocked add B" });
  const c = await entry({ title: "blocked add C" });
  await ok("POST", `/entries/${a.id}/links`, { to: b.id, type: "related" });
  await ok("POST", `/entries/${a.id}/links`, { to: c.id, type: "related" });
  await ok("DELETE", `/entries/${b.id}`);
  await ok("DELETE", `/entries/${b.id}/purge`);
  const adds = (await revisions(`&entry_id=${a.id}`)).filter((r) => r.action === "add");
  const toB = adds.find((r) => r.snapshot.to_id === b.id);
  const toC = adds.find((r) => r.snapshot.to_id === c.id);
  await assertBlocked(toB, "link_gone");
  assert.equal(toC.revertible, true);
  assert.equal(toC.blocked, null);
  assert.equal((await revert(toC.id)).status, 200);
});

test("G-041: the web shows each block reason in Korean, as the 409 would", () => {
  const cases: [Any, RegExp][] = [
    [{ code: "endpoint_purged", entry_id: 7, message: "memory #7 was permanently deleted — this link cannot be restored" }, /#7.*영구 삭제/],
    [{ code: "endpoint_replaced", entry_id: 8, message: "memory #8 is now a different memory (the original was permanently deleted) — this link cannot be restored" }, /#8.*다른 메모리/],
    [{ code: "link_exists", message: "the link already exists" }, /이미 있습니다/],
    [{ code: "link_gone", message: "the link no longer exists" }, /관계가 이제 없습니다/],
    [{ code: "link_not_retiring", message: "the link no longer retires its target" }, /대체하지 않습니다/],
  ];
  for (const [b, re] of cases) {
    assert.match(revertBlockText(b), re);
    const d = describeError(b.message);
    assert.equal(d.known, true);
    assert.equal(revertBlockText(b), d.text);
  }
});
