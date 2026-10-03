import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { REASON_DELETE_WARNING, addProposal, markReasonDeletes, versionOf } from "../src/review.ts";
import { db, entry, llmCalls, llmReply, llmReset, ok, project, runQueueOnce } from "./helpers.ts";

// v0.6.1 re-measure leftovers: entities derived from an edit when the LLM omits them,
// and a delete of the reason memory next to an update that absorbed its outcome.

type Any = any;
let pn = 0;
const freshProject = async () => {
  pn++;
  return project(`github.com/test/r2-review-reason-${pn}`, `r2-review-reason-${pn}`);
};
const getEntry = async (id: number) => (await ok("GET", `/entries/${id}`)) as { entry: Any; entities: Any[] };
const names = (e: { entities: Any[] }) => e.entities.map((x) => x.name ?? x).sort();
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

test("G-046: an edit without entities drops the entity its removed passage last named, applied in one revision", async () => {
  const p = await freshProject();
  const m = await entry({
    project_id: p.id,
    title: "test setup",
    body: "Tests run on Vitest.\nFixture: seed users from FakerJS before each run.",
    entities: ["Vitest", "FakerJS"],
  });
  await entry({ project_id: p.id, title: "ci", body: "x" });
  const { job, proposals } = await runReview(p.id, {
    proposals: [{ kind: "update", ids: [m.id], edits: [{ old: "\nFixture: seed users from FakerJS before each run.", new: "" }], reason: "fixture is transient" }],
  });
  assert.equal(proposals.length, 1, JSON.stringify(job.result));
  assert.deepEqual(proposals[0].data.entities, ["Vitest"], "shown like an LLM-given list");
  const revsBefore = Number(db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE entry_id = ?`).get(m.id)!.n);
  await ok("POST", `/review/proposals/${proposals[0].id}/apply`);
  const e = await getEntry(m.id);
  assert.equal(e.entry.body, "Tests run on Vitest.");
  assert.deepEqual(names(e), ["Vitest"]);
  const revs = db.prepare(`SELECT body, entities FROM revisions WHERE entry_id = ? ORDER BY id DESC`).all(m.id);
  assert.equal(revs.length, revsBefore + 1, "body and entities in one revision");
  assert.equal(revs[0].body, "Tests run on Vitest.");
  assert.match(String(revs[0].entities), /Vitest/);
  assert.doesNotMatch(String(revs[0].entities), /FakerJS/);
  // The prompt says what omitting "entities" now means.
  assert.match(llmCalls.at(-1)!.system, /an entity named only in a passage your edits remove is dropped; to keep such an entity, list it/);
});

test("G-046: a name the text still mentions by an alias (old name) stays", async () => {
  const p = await freshProject();
  const jobId = newJobId(p.id);
  // Entities are global: unique names so the rename does not leak into other tests.
  const m = await entry({ project_id: p.id, title: "db", body: "uses CouchDBX\nCouch pool size 20", entities: ["Couch"] });
  const n = await entry({ project_id: p.id, title: "db 2", body: "uses CouchDBX\nCouch pool size 5", entities: ["Couch"] });
  const ent = (await getEntry(m.id)).entities[0];
  await ok("PATCH", `/entities/${ent.id}`, { name: "CouchDBX" });
  assert.deepEqual(names(await getEntry(m.id)), ["CouchDBX"]);
  const pr = addProposal(jobId, { kind: "update", ids: [m.id], edits: [{ old: "uses CouchDBX\n", new: "" }] }, seen([m.id]))!;
  assert.ok(pr);
  assert.equal(pr.data.entities, undefined, "still named by its old spelling");
  const pr2 = addProposal(jobId, { kind: "update", ids: [n.id], edits: [{ old: "uses CouchDBX\nCouch pool size 5", new: "pool size 5" }] }, seen([n.id]))!;
  assert.deepEqual(pr2.data.entities, [], "no spelling left: dropped");
});

test("G-046: a name still in the body or title stays; a given list is used as is (subset rule)", async () => {
  const p = await freshProject();
  const jobId = newJobId(p.id);
  const a = await entry({ project_id: p.id, title: "redis cache", body: "Redis caches sessions.\nRedis also holds locks.", entities: ["Redis"] });
  const pa = addProposal(jobId, { kind: "update", ids: [a.id], edits: [{ old: "\nRedis also holds locks.", new: "" }] }, seen([a.id]))!;
  assert.ok(pa);
  assert.equal(pa.data.entities, undefined, "still mentioned after the edit");

  const b = await entry({ project_id: p.id, title: "Kafka topics", body: "orders topic on Kafka", entities: ["Kafka"] });
  const pb = addProposal(jobId, { kind: "update", ids: [b.id], edits: [{ old: "orders topic on Kafka", new: "orders topic" }] }, seen([b.id]))!;
  assert.equal(pb.data.entities, undefined, "the title still names it");

  const c = await entry({ project_id: p.id, title: "stack", body: "uses Postgres and Nginx", entities: ["Postgres", "Nginx"] });
  // The LLM's own list wins (kept Nginx although the edit removes its mention).
  const pc = addProposal(jobId, { kind: "update", ids: [c.id], edits: [{ old: " and Nginx", new: "" }], entities: ["Postgres", "Nginx"], title: "stack db" }, seen([c.id]))!;
  assert.equal(pc.data.entities, undefined, "same set as now, so no change to entities");
  assert.equal(addProposal(jobId, { kind: "update", ids: [c.id], edits: [{ old: " and Nginx", new: "" }], entities: ["Traefik"] }, seen([c.id])), null, "a given list still obeys the subset rule");
});

test("G-046: folded parts where one lists entities and one does not drop both parts' removed entities", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "deps", body: "uses Lodash\nuses Moment\nuses Axios", entities: ["Lodash", "Moment", "Axios"] });
  await entry({ project_id: p.id, title: "deps 2", body: "x" });
  const { job, proposals } = await runReview(p.id, {
    proposals: [
      { kind: "update", ids: [m.id], edits: [{ old: "uses Lodash\n", new: "" }], entities: ["Moment", "Axios"], reason: "lodash removed" },
      { kind: "update", ids: [m.id], edits: [{ old: "\nuses Axios", new: "" }], reason: "axios removed" },
    ],
  });
  assert.equal(proposals.length, 1, JSON.stringify(job.result));
  assert.deepEqual(proposals[0].data.entities, ["Moment"]);
});

test("G-052: deleting the reason memory next to an update of the memory it explains is flagged, not dropped", async () => {
  const p = await freshProject();
  const reason = await entry({ project_id: p.id, category: "decision", title: "why pnpm", body: "Chose pnpm because npm installs took 4 minutes in CI." });
  const outcome = await entry({ project_id: p.id, category: "convention", title: "package manager", body: "Use pnpm." });
  const stale = await entry({ project_id: p.id, category: "fact", title: "old task", body: "migrating lockfile (in progress)" });
  await ok("POST", `/entries/${outcome.id}/links`, { to: reason.id, type: "because" });
  const gone = await entry({ project_id: p.id, title: "deleted follower", body: "y" });
  await ok("POST", `/entries/${gone.id}/links`, { to: reason.id, type: "because" });
  await ok("DELETE", `/entries/${gone.id}`);
  const { job, proposals } = await runReview(p.id, {
    proposals: [
      // The delete comes first: the check runs after the whole batch.
      { kind: "delete", ids: [reason.id], reason: "the convention now states it" },
      { kind: "update", ids: [outcome.id], edits: [{ old: "Use pnpm.", new: "Use pnpm (CI installs were too slow with npm)." }], reason: "absorb the outcome" },
      { kind: "delete", ids: [stale.id], reason: "transient" },
    ],
  });
  assert.equal(job.status, "done");
  assert.equal(proposals.length, 3, "kept: a person decides");
  const del = proposals.find((x) => x.kind === "delete" && x.entry_ids[0] === reason.id);
  assert.equal(del.data.warning, REASON_DELETE_WARNING);
  assert.equal(proposals.find((x) => x.kind === "delete" && x.entry_ids[0] === stale.id).data.warning, undefined);
  assert.equal(proposals.find((x) => x.kind === "update").data.warning, undefined);
  // The LLM is told which memories a memory is the reason for, and not to delete it for that.
  const call = llmCalls.at(-1)!;
  assert.match(call.system, /Never delete a memory that records a decision or its reason/);
  const shown = call.user.split("\n").find((l) => l.includes(`"id":${reason.id},`))!;
  assert.deepEqual(JSON.parse(shown).reason_for, [outcome.id], "live memories only (G-017)");
});

test("G-052: a decision memory linked to or sharing an entity with the updated memory is flagged; others are not", async () => {
  const p = await freshProject();
  const jobId = newJobId(p.id);
  const upd = await entry({ project_id: p.id, title: "deploy", body: "Deploy with Helm.", entities: ["Helm"] });
  const viaEntity = await entry({ project_id: p.id, category: "decision", title: "helm over kustomize", body: "Helm chosen for templating.", entities: ["Helm"] });
  const viaLink = await entry({ project_id: p.id, category: "decision", title: "deploy owner", body: "Platform team owns deploys." });
  const plainFact = await entry({ project_id: p.id, category: "fact", title: "helm version", body: "Helm 3.14", entities: ["Helm"] });
  const otherDecision = await entry({ project_id: p.id, category: "decision", title: "logging", body: "Use pino." });
  await ok("POST", `/entries/${viaLink.id}/links`, { to: upd.id, type: "related" });
  const add = (raw: Record<string, unknown>) => assert.ok(addProposal(jobId, raw, seen((raw.ids as number[]) ?? [])));
  for (const d of [viaEntity, viaLink, plainFact, otherDecision]) add({ kind: "delete", ids: [d.id], reason: "covered" });
  assert.equal(markReasonDeletes(jobId), 0, "no update in the job yet");
  add({ kind: "update", ids: [upd.id], title: "deploy (helm 3)" });
  assert.equal(markReasonDeletes(jobId), 2);
  assert.equal(markReasonDeletes(jobId), 0, "already flagged");
  const warnOf = (id: number) =>
    JSON.parse(String(db.prepare(`SELECT data FROM review_proposals WHERE job_id = ? AND kind = 'delete' AND entry_ids = ?`).get(jobId, JSON.stringify([id]))!.data)).warning;
  assert.equal(warnOf(viaEntity.id), REASON_DELETE_WARNING);
  assert.equal(warnOf(viaLink.id), REASON_DELETE_WARNING);
  assert.equal(warnOf(plainFact.id), undefined, "not a decision, not a because-reason");
  assert.equal(warnOf(otherDecision.id), undefined, "a decision unrelated to the update");
});

test("G-052: a delete still open from an earlier job is flagged when a later job updates the memory it explains", async () => {
  const p = await freshProject();
  const reason = await entry({ project_id: p.id, category: "decision", title: "why bun", body: "Chose Bun for faster test startup." });
  const outcome = await entry({ project_id: p.id, category: "convention", title: "runtime", body: "Run tests with Bun." });
  await ok("POST", `/entries/${outcome.id}/links`, { to: reason.id, type: "because" });
  const first = await runReview(p.id, { proposals: [{ kind: "delete", ids: [reason.id], reason: "covered" }] });
  assert.equal(first.proposals.length, 1);
  assert.equal(first.proposals[0].data.warning, undefined, "no update yet");
  const second = await runReview(p.id, {
    proposals: [
      { kind: "update", ids: [outcome.id], edits: [{ old: "Run tests with Bun.", new: "Run tests with Bun (faster startup)." }], reason: "absorb" },
      { kind: "delete", ids: [reason.id], reason: "covered" },
    ],
  });
  assert.equal(second.proposals.length, 1, "the repeated delete is a duplicate of the open one");
  const del = (await ok<Any[]>("GET", `/review/proposals?job_id=${first.job.id}`)).find((x) => x.kind === "delete");
  assert.equal(del.data.warning, REASON_DELETE_WARNING);
});
