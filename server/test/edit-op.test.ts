// Exact-substring "edit" of a memory body: the curation op {"op":"edit"} and
// review update proposals with data.edits. Only an "old" passage that occurs
// exactly once (CRLF → LF, nothing fuzzier) is replaced; shown candidates only
// (G-009); review proposals re-check version (G-021) and uniqueness on apply.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { addProposal, versionOf } from "../src/review.ts";
import { replaceExactlyOnce } from "../src/store.ts";
import { call, db, entry, llmReply, llmReset, ok, project, runQueueOnce, turn } from "./helpers.ts";

type Any = any;
let seq = 0;
async function freshProject() {
  seq++;
  return project(`github.com/test/edit-${seq}`, `edit-${seq}`);
}
const getEntry = async (id: number) => (await ok<Any>("GET", `/entries/${id}`)).entry;
const getTurn = (id: number) => ok<Any>("GET", `/turns/${id}`);
const revisions = (id: number) =>
  db.prepare(`SELECT action, body, author, turn_id FROM revisions WHERE entry_id = ? ORDER BY id`).all(id) as unknown as {
    action: string;
    body: string;
    author: string;
    turn_id: number | null;
  }[];
const newJobId = (projectId: number) => Number(db.prepare(`INSERT INTO review_jobs (project_id, status, payload) VALUES (?, 'done', '{"entries":[]}')`).run(projectId).lastInsertRowid);

beforeEach(() => llmReset());

test("replaceExactlyOnce: exact match only, overlapping occurrences are not unique, CRLF normalized", () => {
  assert.deepEqual(replaceExactlyOnce("a b c", "b", "B"), { body: "a B c" });
  assert.deepEqual(replaceExactlyOnce("a b c", "", "x"), { error: "edit_invalid" });
  assert.deepEqual(replaceExactlyOnce("a b c", 3, "x"), { error: "edit_invalid" });
  assert.deepEqual(replaceExactlyOnce("a b c", "b", undefined), { error: "edit_invalid" });
  assert.deepEqual(replaceExactlyOnce("a b c", "B", "x"), { error: "edit_not_found" }, "case-sensitive");
  assert.deepEqual(replaceExactlyOnce("a  b", "a b", "x"), { error: "edit_not_found" }, "no whitespace folding");
  assert.deepEqual(replaceExactlyOnce("aaa", "aa", "x"), { error: "edit_not_unique" }, "overlap counts");
  assert.deepEqual(replaceExactlyOnce("x\r\ny\r\nz", "y\nz", "Y\r\nZ"), { body: "x\nY\nZ" });
});

test("curation edit: a unique passage is replaced with an llm revision tied to the turn; not found / not unique are skipped", async () => {
  const p = await freshProject();
  const body = ["- port: 8765", "- data dir: /srv/data", "- log level: info", "- retries: 3", "- retries backoff: 2s"].join("\n");
  const m = await entry({ project_id: p.id, title: "server runtime settings", body });
  llmReply({
    ops: [
      { op: "edit", id: m.id, old: "- port: 8765", new: "- port: 9000", reason: "port changed" },
      { op: "edit", id: m.id, old: "- port: 1234", new: "x", reason: "not there" },
      { op: "edit", id: m.id, old: "- retries", new: "x", reason: "ambiguous" },
      { op: "edit", id: m.id, old: "", new: "x", reason: "empty" },
    ],
  });
  const t = await turn([{ role: "user", text: "server runtime settings: the port is now 9000" }], p);
  await runQueueOnce();

  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.applied.map((a: Any) => [a.op, a.entryId]), [["update", m.id]]);
  assert.deepEqual(
    done.result.skipped.map((s: Any) => [s.op, s.reason, s.entryId]),
    [
      ["edit", "edit_not_found", m.id],
      ["edit", "edit_not_unique", m.id],
      ["edit", "edit_invalid", m.id],
    ],
  );
  const e = await getEntry(m.id);
  assert.equal(e.body, body.replace("- port: 8765", "- port: 9000"), "only the passage changed; every other line kept");
  const last = revisions(m.id).at(-1)!;
  assert.equal(last.action, "update");
  assert.equal(last.author, "llm");
  assert.equal(last.turn_id, t.id);
  assert.equal(revisions(m.id).length, 2, "one revision for the one applied edit");
});

test("G-009: an edit on a memory that was not shown is ignored", async () => {
  const p = await freshProject();
  const other = await freshProject();
  const hidden = await entry({ project_id: other.id, title: "zebra quokka unrelated note", body: "keep me" });
  llmReply({ ops: [{ op: "edit", id: hidden.id, old: "keep me", new: "HIJACKED" }] });
  const t = await turn([{ role: "user", text: "the deploy target is staging-2" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.applied, []);
  assert.equal(done.result.skipped, undefined);
  assert.equal((await getEntry(hidden.id)).body, "keep me");
});

test("curation edit: CRLF in the body, old or new still matches exactly and is stored as LF", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "release checklist steps", body: "placeholder" });
  // The store keeps what it is given; put CRLF in directly (an imported memory, say).
  db.prepare(`UPDATE entries SET body = ? WHERE id = ?`).run("1. tag\r\n2. build\r\n3. publish", m.id);
  llmReply({ ops: [{ op: "edit", id: m.id, old: "2. build\n3. publish", new: "2. build\r\n3. sign\r\n4. publish" }] });
  const t = await turn([{ role: "user", text: "release checklist steps: sign before publish" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.equal(done.result.applied.length, 1);
  assert.equal((await getEntry(m.id)).body, "1. tag\n2. build\n3. sign\n4. publish");
});

test("review: an edit proposal on a >4000-char memory is accepted and applies; a full body rewrite of it is not", async () => {
  const p = await freshProject();
  const long = `intro: the cache key is v1\n${"filler line about the build cache layout\n".repeat(150)}tail: keep this line`;
  assert.ok(long.length > 4000);
  const big = await entry({ project_id: p.id, title: "build cache layout", body: long });
  await entry({ project_id: p.id, title: "build cache cleanup", body: "weekly" });

  const job = await ok<Any>("POST", "/review", { project_id: p.id });
  llmReply((c: { user: string }) => {
    assert.ok(c.user.includes('"body_truncated":true'));
    return {
      proposals: [
        { kind: "update", ids: [big.id], body: "intro: the cache key is v2", reason: "rewrite (dropped)" },
        { kind: "update", ids: [big.id], edit: { old: "cache key is v1", new: "cache key is v2" }, body: "ignored", reason: "key bumped" },
      ],
    };
  });
  await runQueueOnce();
  assert.equal((await ok<Any[]>("GET", "/review/jobs?limit=100")).find((j) => j.id === job.id).status, "done");
  const props = await ok<Any[]>("GET", `/review/proposals?job_id=${job.id}`);
  assert.equal(props.length, 1, "the full rewrite of a truncated body is dropped");
  assert.deepEqual(props[0].data.edits, [{ old: "cache key is v1", new: "cache key is v2" }]);
  assert.equal(props[0].data.edit, undefined);
  assert.equal(props[0].data.body, undefined, "an edit replaces any full body");

  const applied = await ok<Any>("POST", `/review/proposals/${props[0].id}/apply`);
  assert.equal(applied.status, "applied");
  const e = await getEntry(big.id);
  assert.equal(e.body, long.replace("cache key is v1", "cache key is v2"));
  assert.ok(e.body.endsWith("tail: keep this line"), "the unseen tail survives");
});

test("review edit: rejected when not exactly once at proposal time; applies only while unchanged and unique", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "lint config", body: "rule A on\nrule B on" });
  const jobId = newJobId(p.id);
  const seen = () => new Map([[m.id, versionOf(m.id)]]);
  assert.equal(addProposal(jobId, { kind: "update", ids: [m.id], edit: { old: "rule C", new: "x" } }, seen()), null, "not found");
  assert.equal(addProposal(jobId, { kind: "update", ids: [m.id], edit: { old: " on", new: " off" } }, seen()), null, "not unique");
  assert.equal(addProposal(jobId, { kind: "update", ids: [m.id], edit: { old: "", new: "x" } }, seen()), null, "empty old");
  assert.equal(addProposal(jobId, { kind: "merge", ids: [m.id], edit: { old: "rule A", new: "x" } }, seen()), null);

  // Stale (G-021): the memory changed after the proposal → 409, nothing applied.
  const stale = addProposal(jobId, { kind: "update", ids: [m.id], edit: { old: "rule A on", new: "rule A off" }, reason: "r1" }, seen())!;
  assert.ok(stale);
  await ok("PATCH", `/entries/${m.id}`, { body: "rule A on\nrule B on\nrule D on" });
  let r = await call("POST", `/review/proposals/${stale.id}/apply`);
  assert.equal(r.status, 409);
  assert.equal((await getEntry(m.id)).body, "rule A on\nrule B on\nrule D on");

  // Same version but the passage is no longer unique (body changed without a revision) → 422.
  const dup = addProposal(jobId, { kind: "update", ids: [m.id], edit: { old: "rule B on", new: "rule B off" }, reason: "r2" }, seen())!;
  assert.ok(dup);
  db.prepare(`UPDATE entries SET body = ? WHERE id = ?`).run("rule B on\nrule B on", m.id);
  r = await call("POST", `/review/proposals/${dup.id}/apply`);
  assert.equal(r.status, 422);
  assert.equal((await getEntry(m.id)).body, "rule B on\nrule B on", "nothing applied");
  assert.equal((await ok<Any[]>("GET", `/review/proposals?job_id=${jobId}`)).find((x) => x.id === dup.id).status, "stale");
});

test("G-002: an edit op on a standing instruction is refused even when its id is allowed", async (t) => {
  const { applyMemoryOps } = await import("../src/worker.ts");
  const s = await entry({ title: "always answer in Korean", body: "rule text", category: "standing" });
  // The worker must skip standing memories itself, not lean on the store's 403:
  // a store rejection is swallowed by the per-op catch and only logged as "op rejected".
  const warn = t.mock.method(console, "warn", () => {});
  const r = applyMemoryOps([{ op: "edit", id: s.id, old: "rule text", new: "HIJACKED" }], null, new Set([s.id]), { author: "llm" }, "test");
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.skipped, []);
  assert.ok(
    !warn.mock.calls.some((c) => String(c.arguments[0]).includes("op rejected")),
    "skipped by the worker, not rejected by the store",
  );
  // With a human author the store would accept the write, so only the worker's skip stops it.
  const h = applyMemoryOps([{ op: "edit", id: s.id, old: "rule text", new: "HIJACKED" }], null, new Set([s.id]), { author: "human" }, "test");
  assert.deepEqual(h.applied, []);
  assert.equal((await getEntry(s.id)).body, "rule text");
  assert.equal(revisions(s.id).length, 1, "no revision written");
});
