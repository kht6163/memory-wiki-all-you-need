import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { addProposal, applyExactEdits, combineUpdateProposals, versionOf } from "../src/review.ts";
import { call, db, entry, llmReply, llmReset, ok, project, runQueueOnce } from "./helpers.ts";

// Review update proposals with several exact edits (data.edits) and an entity
// subset (data.entities); the legacy single data.edit still applies.

type Any = any;
let pn = 0;
const freshProject = async () => {
  pn++;
  return project(`github.com/test/r-review-edits-${pn}`, `r-review-edits-${pn}`);
};
const getEntry = async (id: number) => (await ok("GET", `/entries/${id}`)) as { entry: Any; entities: Any[] };
const names = (e: { entities: Any[] }) => e.entities.map((x) => x.name ?? x).sort();
const revisions = (id: number) => Number(db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE entry_id = ?`).get(id)!.n);
const seen = (ids: number[]) => new Map(ids.map((id) => [id, versionOf(id)]));
const newJobId = (projectId: number) =>
  Number(db.prepare(`INSERT INTO review_jobs (project_id, status, payload) VALUES (?, 'done', '{"entries":[]}')`).run(projectId).lastInsertRowid);

async function runReview(pid: number, reply: unknown) {
  const job = await ok("POST", "/review", { project_id: pid });
  llmReply(reply);
  await runQueueOnce();
  const j = (await ok<Any[]>("GET", "/review/jobs?limit=100")).find((x) => x.id === job.id);
  const proposals = await ok<Any[]>("GET", `/review/proposals?job_id=${job.id}`);
  return { job: j, proposals };
}

beforeEach(() => llmReset());

test("G-045: applyExactEdits looks every old up in the original body; overlap / not unique / not found fail as a whole", () => {
  const body = "port 5432\nhost db1\nuser app";
  assert.deepEqual(applyExactEdits(body, [{ old: "host db1", new: "host db2" }, { old: "port 5432", new: "port 6432" }]), { body: "port 6432\nhost db2\nuser app" });
  // An edit's "new" never creates the next edit's match (both looked up in the original).
  assert.deepEqual(applyExactEdits("a b", [{ old: "a", new: "b" }, { old: "b", new: "c" }]), { body: "b c" });
  assert.deepEqual(applyExactEdits(body, [{ old: "port 5432\nhost", new: "x" }, { old: "host db1", new: "y" }]), { error: "edit_overlap", index: 1 });
  assert.deepEqual(applyExactEdits(body, [{ old: "host db1", new: "x" }, { old: "host db1", new: "y" }]), { error: "edit_overlap", index: 1 });
  assert.equal((applyExactEdits(body, [{ old: "db1", new: "x" }, { old: "nope", new: "y" }]) as Any).error, "edit_not_found");
  assert.equal((applyExactEdits("x x", [{ old: "x", new: "y" }]) as Any).error, "edit_not_unique");
  assert.equal((applyExactEdits(body, [{ old: "db1" }]) as Any).error, "edit_invalid", "a missing new is not a deletion");
  assert.deepEqual(applyExactEdits("a\r\nb", [{ old: "a\r\nb", new: "c\r\nd" }]), { body: "c\nd" });
});

test("G-045: several edit proposals for one memory in one answer become ONE proposal with data.edits, applied in one revision", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "db settings", body: "port 5432\nhost db1\nuser app\npool 10" });
  await entry({ project_id: p.id, title: "db backups", body: "nightly" });
  const { job, proposals } = await runReview(p.id, {
    proposals: [
      { kind: "update", ids: [m.id], edit: { old: "port 5432", new: "port 6432" }, reason: "port moved" },
      { kind: "update", ids: [m.id], edit: { old: "host db1", new: "host db2" }, reason: "host moved" },
      { kind: "update", ids: [m.id], edits: [{ old: "pool 10", new: "pool 20" }], title: "db settings (prod)", reason: "pool raised" },
    ],
  });
  assert.equal(job.status, "done");
  assert.equal(proposals.length, 1, "folded into one proposal");
  const pr = proposals[0];
  assert.deepEqual(pr.data.edits, [
    { old: "port 5432", new: "port 6432" },
    { old: "host db1", new: "host db2" },
    { old: "pool 10", new: "pool 20" },
  ]);
  assert.equal(pr.data.edit, undefined, "new proposals are written as data.edits only");
  assert.equal(pr.data.body, undefined);
  assert.equal(pr.data.title, "db settings (prod)");
  assert.equal(pr.reason, "port moved; host moved; pool raised");
  assert.equal(job.result.proposals, 1);
  assert.equal(job.result.dropped_count, 0);
  assert.equal((await getEntry(m.id)).entry.body, "port 5432\nhost db1\nuser app\npool 10", "nothing changes before apply (G-021)");

  const before = revisions(m.id);
  assert.equal((await ok<Any>("POST", `/review/proposals/${pr.id}/apply`)).status, "applied");
  const e = await getEntry(m.id);
  assert.equal(e.entry.body, "port 6432\nhost db2\nuser app\npool 20");
  assert.equal(e.entry.title, "db settings (prod)");
  assert.equal(revisions(m.id), before + 1, "all edits land in one revision");
});

test("G-045: proposals that cannot be folded or stored are reported on job.result.dropped with a reason", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "lint rules", body: "rule A on\nrule B on\nrule C on" });
  const n = await entry({ project_id: p.id, title: "lint runner", body: "eslint" });
  const { job, proposals } = await runReview(p.id, {
    proposals: [
      { kind: "update", ids: [m.id], edit: { old: "rule A on", new: "rule A off" }, reason: "a" },
      { kind: "update", ids: [m.id], edit: { old: "rule A on\nrule B", new: "x" }, reason: "overlaps a" },
      { kind: "update", ids: [m.id], edit: { old: " on", new: " off" }, reason: "not unique" },
      { kind: "update", ids: [m.id], edit: { old: "rule Z", new: "x" }, reason: "not found" },
      { kind: "update", ids: [m.id], edit: { old: "rule A on", new: "rule A off" }, reason: "same again" },
      { kind: "update", ids: [m.id], edit: { old: "rule C on", new: "key sk-" + "q".repeat(30) }, reason: "secret" },
      { kind: "update", ids: [n.id], title: "", reason: "nothing" },
    ],
  });
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].data.edits, [{ old: "rule A on", new: "rule A off" }]);
  const reasons = job.result.dropped.map((d: Any) => d.reason).sort();
  assert.deepEqual(reasons, ["duplicate", "edit_not_found", "edit_not_unique", "edit_overlap", "no_change", "secret"]);
  assert.equal(job.result.dropped_count, 6);
  assert.deepEqual(job.result.dropped.find((d: Any) => d.reason === "no_change").ids, [n.id]);
});

test("G-045: an LLM proposal with edits is all-or-nothing at proposal time; apply re-checks (409 stale, 422 no longer unique)", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "ports", body: "web 80\napi 81" });
  const jobId = newJobId(p.id);
  const one = () => seen([m.id]);
  assert.equal(addProposal(jobId, { kind: "update", ids: [m.id], edits: [{ old: "web 80", new: "web 8080" }, { old: "nope", new: "x" }] }, one()), null);
  assert.equal(addProposal(jobId, { kind: "update", ids: [m.id], edits: "web 80" }, one()), null, "malformed edits");
  assert.equal(addProposal(jobId, { kind: "update", ids: [m.id], edits: [{ old: "web 80", new: "w".repeat(20_001) }] }, one()), null, "too long");

  const a = addProposal(jobId, { kind: "update", ids: [m.id], edits: [{ old: "web 80", new: "web 8080" }, { old: "api 81", new: "api 8081" }], reason: "r1" }, one())!;
  assert.ok(a);
  // Same version, body changed without a revision so one passage is no longer unique → 422, nothing applied.
  db.prepare(`UPDATE entries SET body = ? WHERE id = ?`).run("web 80\napi 81\napi 81", m.id);
  let r = await call("POST", `/review/proposals/${a.id}/apply`);
  assert.equal(r.status, 422);
  assert.equal((await getEntry(m.id)).entry.body, "web 80\napi 81\napi 81");

  await ok("PATCH", `/entries/${m.id}`, { body: "web 80\napi 81" });
  const b = addProposal(jobId, { kind: "update", ids: [m.id], edits: [{ old: "web 80", new: "web 8080" }, { old: "api 81", new: "api 8081" }], reason: "r2" }, one())!;
  assert.ok(b);
  await ok("PATCH", `/entries/${m.id}`, { title: "ports (edited)" });
  r = await call("POST", `/review/proposals/${b.id}/apply`);
  assert.equal(r.status, 409, "version check first (G-021)");
  assert.equal((await getEntry(m.id)).entry.body, "web 80\napi 81");
});

test("G-045: a pending proposal stored with the v0.6.0 single data.edit still applies", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "cache", body: "ttl 60\nsize 1g" });
  const jobId = newJobId(p.id);
  const data = { snap: { [String(m.id)]: versionOf(m.id) }, edit: { old: "ttl 60", new: "ttl 120" } };
  const id = Number(
    db.prepare(`INSERT INTO review_proposals (job_id, kind, entry_ids, data, reason) VALUES (?, 'update', ?, ?, 'legacy')`).run(jobId, JSON.stringify([m.id]), JSON.stringify(data)).lastInsertRowid,
  );
  assert.equal((await ok<Any>("POST", `/review/proposals/${id}/apply`)).status, "applied");
  assert.equal((await getEntry(m.id)).entry.body, "ttl 120\nsize 1g");
});

test("G-046: an update may drop entities (subset only), applied with the edit in the same revision", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "stack", body: "uses PostgreSQL and Redis for caching", entities: ["PostgreSQL", "Redis"] });
  await entry({ project_id: p.id, title: "stack notes", body: "x" });
  const { job, proposals } = await runReview(p.id, {
    proposals: [
      { kind: "update", ids: [m.id], edit: { old: " and Redis for caching", new: "" }, reason: "redis removed" },
      { kind: "update", ids: [m.id], entities: ["postgresql"], reason: "drop redis entity" },
    ],
  });
  assert.equal(proposals.length, 1, job.result.dropped);
  assert.deepEqual(proposals[0].data.entities, ["PostgreSQL"], "matched by norm, stored as the current name");
  assert.deepEqual(proposals[0].data.edits, [{ old: " and Redis for caching", new: "" }]);

  const before = revisions(m.id);
  await ok("POST", `/review/proposals/${proposals[0].id}/apply`);
  const e = await getEntry(m.id);
  assert.equal(e.entry.body, "uses PostgreSQL");
  assert.deepEqual(names(e), ["PostgreSQL"]);
  assert.equal(revisions(m.id), before + 1, "text and entities in one revision");
});

test("G-046: a name the memory does not have rejects the proposal; the same set counts as no change; [] removes all", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "queue", body: "uses Kafka", entities: ["Kafka", "Zookeeper"] });
  const jobId = newJobId(p.id);
  const one = () => seen([m.id]);
  assert.equal(addProposal(jobId, { kind: "update", ids: [m.id], entities: ["Kafka", "RabbitMQ"] }, one()), null, "no new entities from review");
  assert.equal(addProposal(jobId, { kind: "update", ids: [m.id], entities: "Kafka" }, one()), null, "malformed");
  assert.equal(addProposal(jobId, { kind: "update", ids: [m.id], entities: ["zookeeper", "Kafka"] }, one()), null, "same set → nothing to change");
  const withTitle = addProposal(jobId, { kind: "update", ids: [m.id], title: "queue (kafka)", entities: ["Kafka", "Zookeeper"] }, one())!;
  assert.equal(withTitle.data.entities, undefined, "same set is dropped from the proposal");
  await ok("POST", `/review/proposals/${withTitle.id}/apply`);

  const none = addProposal(jobId, { kind: "update", ids: [m.id], entities: [] }, one())!;
  assert.deepEqual(none.data.entities, []);
  await ok("POST", `/review/proposals/${none.id}/apply`);
  assert.deepEqual(names(await getEntry(m.id)), []);

  // Through the LLM path the rejection is reported, not silent.
  await entry({ project_id: p.id, title: "queue 2", body: "y" });
  const { job, proposals } = await runReview(p.id, { proposals: [{ kind: "update", ids: [m.id], entities: ["NewThing"], reason: "x" }] });
  assert.equal(proposals.length, 0);
  assert.deepEqual(job.result.dropped, [{ kind: "update", ids: [m.id], reason: "entities_not_subset" }]);
});

test("G-045: folding keeps a full-body rewrite separate and only folds rewrite-free updates", () => {
  const { proposals, dropped } = combineUpdateProposals(
    [
      { kind: "update", ids: [1], body: "rewrite" },
      { kind: "update", ids: [1], edit: { old: "a", new: "b" }, reason: "x" },
      { kind: "delete", ids: [2] },
      { kind: "update", ids: [1], category: "standing", reason: "promote" },
      { kind: "update", ids: [1], edit: { old: "c", new: "d" }, category: "fact", reason: "y" },
    ],
    () => "a c",
  );
  assert.deepEqual(dropped, [{ kind: "update", ids: [1], reason: "no_change" }], "a standing-only part changes nothing");
  assert.deepEqual(proposals, [
    { kind: "update", ids: [1], body: "rewrite" },
    { kind: "update", ids: [1], edits: [{ old: "a", new: "b" }, { old: "c", new: "d" }], category: "fact", reason: "x; y" },
    { kind: "delete", ids: [2] },
  ]);
});
