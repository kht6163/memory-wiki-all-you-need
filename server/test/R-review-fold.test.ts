import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { addProposal, combineUpdateProposals, versionOf } from "../src/review.ts";
import { call, db, entry, llmReply, llmReset, ok, project, runQueueOnce } from "./helpers.ts";

// Folding several update proposals for one memory (combineUpdateProposals) and the
// "no silent drops" report on job.result.dropped (body_truncated, over_limit).

type Any = any;
let pn = 0;
const freshProject = async () => {
  pn++;
  return project(`github.com/test/r-review-fold-${pn}`, `r-review-fold-${pn}`);
};
const getEntry = async (id: number) => (await ok("GET", `/entries/${id}`)) as { entry: Any; entities: Any[] };
const names = (e: { entities: Any[] }) => e.entities.map((x) => x.name ?? x).sort();

async function runReview(pid: number, reply: unknown) {
  const job = await ok("POST", "/review", { project_id: pid });
  llmReply(reply);
  await runQueueOnce();
  const j = (await ok<Any[]>("GET", "/review/jobs?limit=100")).find((x) => x.id === job.id);
  const proposals = await ok<Any[]>("GET", `/review/proposals?job_id=${job.id}`);
  return { job: j, proposals };
}

beforeEach(() => llmReset());

test("G-046: parts that each list only what they keep fold into the intersection, not a conflict", async () => {
  const p = await freshProject();
  const m = await entry({
    project_id: p.id,
    title: "infra",
    body: "events go through Kafka.\nrows live in Postgres.\nsessions sit in Redis.",
    entities: ["Kafka", "Postgres", "Redis"],
  });
  await entry({ project_id: p.id, title: "infra notes", body: "x" });
  const { job, proposals } = await runReview(p.id, {
    proposals: [
      { kind: "update", ids: [m.id], edit: { old: "\nsessions sit in Redis.", new: "" }, entities: ["Kafka", "Postgres"], reason: "redis gone" },
      { kind: "update", ids: [m.id], edit: { old: "events go through Kafka.\n", new: "" }, entities: ["Postgres", "Redis"], reason: "kafka gone" },
    ],
  });
  assert.equal(job.result.dropped_count, 0, JSON.stringify(job.result.dropped));
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].data.entities, ["Postgres"]);
  assert.equal(proposals[0].data.edits.length, 2);
  await ok("POST", `/review/proposals/${proposals[0].id}/apply`);
  const e = await getEntry(m.id);
  assert.equal(e.entry.body, "rows live in Postgres.");
  assert.deepEqual(names(e), ["Postgres"]);
});

test("G-045: the same edit twice inside one part folds like a lone proposal (no edit_overlap)", () => {
  const e = { old: "a", new: "b" };
  const { proposals, dropped } = combineUpdateProposals(
    [
      { kind: "update", ids: [1], edits: [e, { ...e }], reason: "x" },
      { kind: "update", ids: [1], edit: { old: "c", new: "d" }, reason: "y" },
    ],
    () => "a c",
  );
  assert.deepEqual(dropped, []);
  assert.deepEqual(proposals, [{ kind: "update", ids: [1], edits: [e, { old: "c", new: "d" }], reason: "x; y" }]);
});

test("G-045: a differing title is dropped as conflicting_title; a folded body over 20,000 chars as too_long", () => {
  const r = combineUpdateProposals(
    [
      { kind: "update", ids: [1], edit: { old: "a", new: "b" }, title: "one", reason: "x" },
      { kind: "update", ids: [1], edit: { old: "c", new: "d" }, title: "two", reason: "y" },
      { kind: "update", ids: [1], title: "one", category: "fact", reason: "z" },
    ],
    () => "a c",
  );
  assert.deepEqual(r.dropped, [{ kind: "update", ids: [1], reason: "conflicting_title" }]);
  assert.deepEqual(r.proposals, [{ kind: "update", ids: [1], edits: [{ old: "a", new: "b" }], title: "one", category: "fact", reason: "x; z" }]);

  const big = combineUpdateProposals(
    [
      { kind: "update", ids: [1], edit: { old: "a", new: "x".repeat(15_000) }, reason: "x" },
      { kind: "update", ids: [1], edit: { old: "c", new: "y".repeat(15_000) }, reason: "y" },
    ],
    () => "a c",
  );
  assert.deepEqual(big.dropped, [{ kind: "update", ids: [1], reason: "too_long" }]);
  assert.equal(big.proposals.length, 1);
  assert.deepEqual((big.proposals[0] as Any).edits, [{ old: "a", new: "x".repeat(15_000) }]);
});

test("G-046: apply re-checks that the proposed entities are still on the memory (422, nothing changes)", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "queue", body: "uses Kafka and Zookeeper", entities: ["Kafka", "Zookeeper"] });
  const jobId = Number(db.prepare(`INSERT INTO review_jobs (project_id, status, payload) VALUES (?, 'done', '{"entries":[]}')`).run(p.id).lastInsertRowid);
  const pr = addProposal(jobId, { kind: "update", ids: [m.id], edits: [{ old: " and Zookeeper", new: "" }], entities: ["Kafka"] }, new Map([[m.id, versionOf(m.id)]]))!;
  assert.ok(pr);
  // Kafka disappears from the memory without a revision (the version check cannot see it).
  db.prepare(`DELETE FROM entry_entities WHERE entry_id = ? AND entity_id IN (SELECT id FROM entities WHERE name = 'Kafka')`).run(m.id);
  const r = await call("POST", `/review/proposals/${pr.id}/apply`);
  assert.equal(r.status, 422);
  const e = await getEntry(m.id);
  assert.equal(e.entry.body, "uses Kafka and Zookeeper");
  assert.deepEqual(names(e), ["Zookeeper"]);
});

test("G-045: a rewrite of a truncated body and proposals past 30 are reported on job.result.dropped", async () => {
  const p = await freshProject();
  const long = `head\n${"filler line about the build cache layout\n".repeat(150)}tail`;
  const big = await entry({ project_id: p.id, title: "build cache layout", body: long });
  const small = await entry({ project_id: p.id, title: "build cache cleanup", body: "weekly" });
  const rest = Array.from({ length: 30 }, (_, i) => ({ kind: "update", ids: [small.id], title: `cleanup ${i}`, reason: "r" }));
  const { job, proposals } = await runReview(p.id, {
    proposals: [{ kind: "update", ids: [big.id], body: "head\ntail", reason: "rewrite" }, ...rest],
  });
  const reasons = job.result.dropped.map((d: Any) => d.reason);
  assert.deepEqual(job.result.dropped.find((d: Any) => d.reason === "body_truncated"), { kind: "update", ids: [big.id], reason: "body_truncated" });
  assert.deepEqual(job.result.dropped.find((d: Any) => d.reason === "over_limit"), { kind: "update", ids: [small.id], reason: "over_limit" });
  assert.equal(reasons.filter((r: string) => r === "over_limit").length, 1, "only the 31st is over the limit");
  assert.equal(job.result.dropped_count, job.result.dropped.length);
  assert.equal(job.result.proposals, proposals.length);
  assert.equal(job.result.proposals + job.result.dropped_count, 31, "every proposal is either stored or reported");
  assert.equal((await getEntry(big.id)).entry.body, long);
});
