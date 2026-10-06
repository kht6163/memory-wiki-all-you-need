import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { call, entry, llmReply, llmReset, ok, project, runQueueOnce } from "./helpers.ts";

// memory_review (POST /agent/review, ADR-0045): the agent lists and reads the pending proposals
// of its project and of global memory (never another project's), and settles CONFLICTS after
// checking — editing the memories first is the normal path, so an edit never blocks a conflict;
// a note is required. Merges, updates and deletes stay a person's (web).

type Any = any;
let pn = 0;
const freshProject = async () => {
  pn++;
  return project(`github.com/test/r5-agent-review-${pn}`, `r5-agent-review-${pn}`);
};
const ref = (p: { key: string; name: string }) => ({ key: p.key, name: p.name, remote: null });
const review = (p: { key: string; name: string } | null, body: Record<string, unknown>) => call<Any>("POST", "/agent/review", { project: p && ref(p), ...body });

async function runReview(pid: number | null, reply: unknown) {
  const job = await ok("POST", "/review", pid ? { project_id: pid } : {});
  llmReply(reply);
  await runQueueOnce();
  return ok<Any[]>("GET", `/review/proposals?job_id=${job.id}`);
}

beforeEach(() => llmReset());

test("list and view: this project's and global proposals, never another project's", async () => {
  const p = await freshProject();
  const other = await freshProject();
  const a = await entry({ project_id: p.id, title: "NEC db is bitz_test", body: "ssh host, db bitz_test", entities: ["nec"] });
  const b = await entry({ project_id: p.id, title: "NEC db is bitz", body: "test instance uses bitz", entities: ["nec"] });
  const [conf] = await runReview(p.id, { proposals: [{ kind: "conflict", ids: [a.id, b.id], note: "bitz_test vs bitz", reason: "db names differ" }] });
  const o1 = await entry({ project_id: other.id, title: "other x", body: "1", entities: ["o"] });
  const o2 = await entry({ project_id: other.id, title: "other y", body: "2", entities: ["o"] });
  const [otherConf] = await runReview(other.id, { proposals: [{ kind: "conflict", ids: [o1.id, o2.id], reason: "other project" }] });

  const list = await review(p, { action: "list" });
  assert.equal(list.status, 200);
  assert.match(list.data.text, new RegExp(`#${conf.id} \\[conflict\\] this project: db names differ`));
  assert.match(list.data.text, /conflict\(s\) you can settle/);
  assert.doesNotMatch(list.data.text, new RegExp(`#${otherConf.id} \\[conflict\\]`));

  const view = await review(p, { action: "view", id: conf.id });
  assert.match(view.data.text, /note: bitz_test vs bitz/);
  assert.match(view.data.text, /ssh host, db bitz_test/, "bodies in full");
  assert.equal((await review(p, { action: "view", id: otherConf.id })).status, 404);
  assert.equal((await review(p, { action: "nope" })).status, 400);
});

test("resolve: a conflict after the agent fixed a memory — note required, stored, gone from the list", async () => {
  const p = await freshProject();
  const a = await entry({ project_id: p.id, title: "NEC db is bitz_test", body: "db bitz_test", entities: ["nec"] });
  const b = await entry({ project_id: p.id, title: "NEC db is bitz", body: "test instance uses bitz", entities: ["nec"] });
  const [conf] = await runReview(p.id, { proposals: [{ kind: "conflict", ids: [a.id, b.id], reason: "db names differ" }] });
  // The agent checked the real config and fixed the wrong one (memory_replace).
  await ok("POST", "/agent/memory", { action: "replace", target: "project", old_text: "test instance uses bitz", content: "NEC test instance uses database bitz_test", project: ref(p) });
  // An edited memory does not make the conflict "blocked" (it is how it gets settled).
  assert.deepEqual((await ok("POST", "/review/proposals/retire-blocked", { project_id: p.id })).retired, []);
  assert.equal((await review(p, { action: "resolve", id: conf.id })).status, 400, "no note");
  assert.equal((await review(p, { action: "resolve", id: conf.id, note: "token sk-abcdefghijklmnopqrstuvwxyz0123456789" })).status, 422);
  const r = await review(p, { action: "resolve", id: conf.id, note: "checked .env DB_NAME=bitz_test on the NEC host; #b was wrong, fixed" });
  assert.equal(r.status, 200);
  assert.match(r.data.text, /^resolved conflict #/);
  const after = (await ok<Any[]>("GET", `/review/proposals?project_id=${p.id}&status=applied`)).find((x) => x.id === conf.id);
  assert.equal(after.data.resolution.by, "agent");
  assert.match(after.data.resolution.note, /DB_NAME=bitz_test/);
  assert.match((await review(p, { action: "list" })).data.text, /No pending review proposals/);
  assert.equal((await review(p, { action: "resolve", id: conf.id, note: "again, nothing more" })).status, 409);
});

test("resolve: only conflicts; after the agent removed the wrong memory the conflict is settled with its note", async () => {
  const p = await freshProject();
  const a = await entry({ project_id: p.id, title: "q is rabbit", body: "x", entities: ["q"] });
  const b = await entry({ project_id: p.id, title: "q is kafka", body: "y", entities: ["q"] });
  const c = await entry({ project_id: p.id, title: "q uses rabbit", body: "z", entities: ["q"] });
  const ps = await runReview(p.id, {
    proposals: [
      { kind: "conflict", ids: [a.id, b.id], reason: "which queue" },
      { kind: "merge", ids: [a.id, c.id], keep: a.id, title: "q is rabbit", body: "x z", reason: "dup" },
    ],
  });
  const conf = ps.find((x) => x.kind === "conflict")!;
  const merge = ps.find((x) => x.kind === "merge")!;
  const refused = await review(p, { action: "resolve", id: merge.id, note: "looks right to me, apply" });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /^only conflicts can be resolved here/);
  // The agent removes the wrong memory: nothing disagrees any more.
  await ok("POST", "/agent/memory", { action: "remove", target: "project", old_text: "q is kafka", project: ref(p) });
  const closed = await review(p, { action: "resolve", id: conf.id, note: "kafka was removed years ago; deleted #b" });
  assert.match(closed.data.text, /^resolved conflict #\d+ \(one of its memories is gone\): kafka was removed/);
  assert.equal(closed.data.proposal.status, "applied");
  assert.match(closed.data.proposal.data.resolution.note, /deleted #b/, "the note is kept");
});

test("a conflict resolved without editing (both right, different hosts) is not proposed again; an edit after it is", async () => {
  const p = await freshProject();
  const a = await entry({ project_id: p.id, title: "dev db is bitz_test", body: "on .61", entities: ["nec"] });
  const b = await entry({ project_id: p.id, title: "test db is bitz", body: "on .70", entities: ["nec"] });
  const pair = { proposals: [{ kind: "conflict", ids: [a.id, b.id], reason: "db names differ" }] };
  const [conf] = await runReview(p.id, pair);
  await review(p, { action: "resolve", id: conf.id, note: "both right: .61 runs bitz_test, .70 runs bitz (checked both .env)" });
  assert.equal((await runReview(p.id, pair)).length, 0, "same memories as when resolved: skipped");
  await ok("PATCH", `/entries/${a.id}`, { body: "on .61, moved to bitz" });
  assert.equal((await runReview(p.id, pair)).length, 1, "changed since: a new conflict may be real");
});

test("proposal entries carry their state (superseded_by, expired) for the web's blocked check", async () => {
  const p = await freshProject();
  const a = await entry({ project_id: p.id, title: "x one", body: "1", entities: ["x"] });
  const b = await entry({ project_id: p.id, title: "x two", body: "2", entities: ["x"] });
  await runReview(p.id, { proposals: [{ kind: "conflict", ids: [a.id, b.id], reason: "x" }] });
  const [pr] = await ok<Any[]>("GET", `/review/proposals?project_id=${p.id}`);
  assert.equal(pr.entries[0].superseded_by, null);
  assert.equal(pr.entries[0].expired, false);
});

test("the sweep retires a conflict only when one of its memories is gone", async () => {
  const p = await freshProject();
  const a = await entry({ project_id: p.id, title: "port 5433", body: "x", entities: ["db"] });
  const b = await entry({ project_id: p.id, title: "port 5432", body: "y", entities: ["db"] });
  const [conf] = await runReview(p.id, { proposals: [{ kind: "conflict", ids: [a.id, b.id], reason: "ports" }] });
  await ok("PATCH", `/entries/${a.id}`, { body: "edited" });
  assert.deepEqual((await ok("POST", "/review/proposals/retire-blocked", { project_id: p.id })).retired, []);
  await ok("DELETE", `/entries/${b.id}`);
  assert.deepEqual((await ok("POST", "/review/proposals/retire-blocked", { project_id: p.id })).retired, [conf.id]);
});
