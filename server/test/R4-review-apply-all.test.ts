import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { call, db, entry, llmReply, llmReset, ok, project, runQueueOnce } from "./helpers.ts";

// "Approve all" (POST /review/proposals/apply {ids}): proposals are applied in order with the
// same checks as one apply; one that an earlier apply made stale is reported, never applied
// blind; conflicts and decided proposals are skipped; bad input is a 400.

type Any = any;
let pn = 0;
const freshProject = async () => {
  pn++;
  return project(`github.com/test/r4-apply-all-${pn}`, `r4-apply-all-${pn}`);
};

async function runReview(pid: number, reply: unknown) {
  const job = await ok("POST", "/review", { project_id: pid });
  llmReply(reply);
  await runQueueOnce();
  return ok<Any[]>("GET", `/review/proposals?job_id=${job.id}`);
}

beforeEach(() => llmReset());

test("apply all: applies in order, an overlapping later proposal goes stale, conflicts stay pending", async () => {
  const p = await freshProject();
  const a = await entry({ project_id: p.id, title: "deploy uses blue-green", body: "two pools", entities: ["deploy"] });
  const b = await entry({ project_id: p.id, title: "deploy is blue-green", body: "two pools behind the router", entities: ["deploy"] });
  const c = await entry({ project_id: p.id, title: "old CI note", body: "obsolete", entities: ["deploy"] });
  const d = await entry({ project_id: p.id, title: "port is 5433", body: "staging", entities: ["deploy"] });
  const e = await entry({ project_id: p.id, title: "port is 5432", body: "staging", entities: ["deploy"] });
  const proposals = await runReview(p.id, {
    proposals: [
      { kind: "merge", ids: [a.id, b.id], keep: b.id, title: "deploy is blue-green", body: "two pools behind the router", reason: "duplicate" },
      { kind: "delete", ids: [c.id], reason: "obsolete" },
      { kind: "delete", ids: [a.id], reason: "also covered" },
      { kind: "conflict", ids: [d.id, e.id], reason: "two ports" },
    ],
  });
  assert.equal(proposals.length, 4, JSON.stringify(proposals.map((x) => x.kind)));
  const byKind = (k: string, id?: number) => proposals.find((x) => x.kind === k && (id === undefined || x.entry_ids.includes(id)))!;
  const merge = byKind("merge");
  const delC = proposals.find((x) => x.kind === "delete" && x.entry_ids[0] === c.id)!;
  const delA = proposals.find((x) => x.kind === "delete" && x.entry_ids[0] === a.id)!;
  const conflict = byKind("conflict");

  const r = await ok("POST", "/review/proposals/apply", { ids: [merge.id, delC.id, delA.id, conflict.id, merge.id] });
  assert.deepEqual(r.applied, [merge.id, delC.id]);
  assert.deepEqual(r.failed.map((f: Any) => [f.id, f.status]), [[delA.id, 409]]);
  assert.deepEqual(r.skipped, [{ id: conflict.id, reason: "conflict" }]);

  const status = async (id: number) => (await ok<Any[]>("GET", `/review/proposals?project_id=${p.id}&status=`)).find((x) => x.id === id)?.status;
  assert.equal(await status(merge.id), "applied");
  assert.equal(await status(delC.id), "applied");
  assert.equal(await status(delA.id), "stale");
  assert.equal(await status(conflict.id), "pending");
  assert.ok((await ok("GET", `/entries/${c.id}`)).entry.deleted_at, "the delete was applied");

  // Already decided → skipped, nothing applied twice.
  const again = await ok("POST", "/review/proposals/apply", { ids: [merge.id, 999999] });
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, [
    { id: merge.id, reason: "not_pending" },
    { id: 999999, reason: "not_found" },
  ]);
});

test("apply all: a delete carrying a warning (it removes a decision's reason) is left for a person", async () => {
  const p = await freshProject();
  const r1 = await entry({ project_id: p.id, title: "why we chose Postgres", body: "decision", entities: ["db"] });
  await entry({ project_id: p.id, title: "db is Postgres", body: "x", entities: ["db"] });
  const [del] = await runReview(p.id, { proposals: [{ kind: "delete", ids: [r1.id], reason: "old" }] });
  db.prepare("UPDATE review_proposals SET data = json_set(data, '$.warning', 'reason memory') WHERE id = ?").run(del.id);
  const r = await ok("POST", "/review/proposals/apply", { ids: [del.id] });
  assert.deepEqual(r.skipped, [{ id: del.id, reason: "warning" }]);
  assert.equal((await ok("GET", `/entries/${r1.id}`)).entry.deleted_at, null);
});

test("apply all: ids must be 1-500 positive integers", async () => {
  for (const body of [{}, { ids: [] }, { ids: "1" }, { ids: [1.5] }, { ids: [0] }, { ids: Array.from({ length: 501 }, (_, i) => i + 1) }]) {
    assert.equal((await call("POST", "/review/proposals/apply", body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
});
