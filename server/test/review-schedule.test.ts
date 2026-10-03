// Scheduled memory review (REVIEW_EVERY_DAYS): the server only QUEUES reviews
// of scopes that changed since their last review; proposals still wait for a
// person (nothing is applied by itself).
//
// config.ts reads env at first import, so the period is set before any server
// module loads and everything is imported dynamically.
process.env.REVIEW_EVERY_DAYS = "7";

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const { call, db, entry, llmDefault, llmReset, ok, project, runQueueOnce } = await import("./helpers.ts");
const { config } = await import("../src/config.ts");
const { scheduleDueReviews } = await import("../src/review.ts");

type Any = any;

let pn = 0;
async function freshProject() {
  pn++;
  return project(`github.com/test/schedule-${pn}`, `schedule-${pn}`);
}
const mem = (pid: number, title: string) => entry({ scope: "project", project_id: pid, title, body: `${title} body` });

const OLD = "2020-01-01T00:00:00.000Z";
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
/** Make a scope look reviewed `days` ago, with every memory older than that review. */
function reviewedDaysAgo(pid: number, days: number) {
  db.prepare(`UPDATE review_jobs SET status = 'done', created_at = ? WHERE project_id = ?`).run(daysAgo(days), pid);
  db.prepare(`UPDATE entries SET updated_at = ? WHERE project_id = ?`).run(OLD, pid);
}
const jobsOf = (pid: number) => db.prepare(`SELECT * FROM review_jobs WHERE project_id = ? ORDER BY id`).all(pid) as Any[];
const scheduledFor = (pid: number) => scheduleDueReviews().filter((j) => j.project_id === pid);

beforeEach(() => {
  llmReset();
});

test("REVIEW_EVERY_DAYS: read from env, 0 turns scheduling off", async () => {
  assert.equal(config.review.everyDays, 7);
  const p = await freshProject();
  await mem(p.id, "off a");
  await mem(p.id, "off b");
  assert.deepEqual(scheduleDueReviews(new Date(), 0), []);
  assert.equal(jobsOf(p.id).length, 0);
  // Plain runQueueOnce() never schedules (tests stay deterministic).
  await runQueueOnce();
  assert.equal(jobsOf(p.id).length, 0);
});

test("no LLM configured: schedules nothing (the job would only end skipped and reset the period)", async () => {
  const p = await freshProject();
  await mem(p.id, "nollm a");
  await mem(p.id, "nollm b");
  const baseUrl = config.llm.baseUrl;
  config.llm.baseUrl = "";
  try {
    assert.deepEqual(scheduleDueReviews(), []);
    await runQueueOnce({ schedule: true });
    assert.equal(jobsOf(p.id).length, 0);
  } finally {
    config.llm.baseUrl = baseUrl;
  }
  // Once an LLM is configured the same scope is due.
  assert.equal(scheduledFor(p.id).length, 1);
});

test("never reviewed: queues a scheduled review per scope with >= 2 memories, skips smaller scopes", async () => {
  const p = await freshProject();
  const small = await freshProject();
  await mem(p.id, "first a");
  await mem(p.id, "first b");
  await mem(small.id, "lonely");
  await entry({ scope: "global", title: "schedule global a" });
  await entry({ scope: "user", title: "schedule user b" });

  const jobs = scheduleDueReviews();
  const mine = jobs.find((j) => j.project_id === p.id);
  assert.ok(mine, "project with two memories is queued");
  assert.equal(mine.status, "pending");
  assert.equal(mine.payload.scheduled, true);
  assert.equal(mine.payload.entries.length, 2);
  assert.ok(jobs.some((j) => j.project_id === null), "global + user scope is queued too");
  assert.equal(jobsOf(small.id).length, 0, "a single memory is not enough (the 400 is swallowed)");

  // The job list exposes the flag; a person's review does not carry it.
  const listed = (await ok<Any[]>("GET", `/review/jobs?project_id=${p.id}`))[0];
  assert.equal(listed.payload.scheduled, true);
  const other = await freshProject();
  await mem(other.id, "manual a");
  await mem(other.id, "manual b");
  const manual = await ok<Any>("POST", "/review", { project_id: other.id });
  assert.equal(manual.payload.scheduled, undefined);

  // Leave nothing pending for later tests.
  db.prepare(`UPDATE review_jobs SET status = 'done' WHERE status = 'pending'`).run();
});

test("skips a scope whose review is still pending", async () => {
  const p = await freshProject();
  await mem(p.id, "pending a");
  await mem(p.id, "pending b");
  await ok("POST", "/review", { project_id: p.id });
  assert.equal(scheduledFor(p.id).length, 0);
  assert.equal(jobsOf(p.id).length, 1);
  db.prepare(`UPDATE review_jobs SET status = 'done' WHERE status = 'pending'`).run();
});

test("respects the period and needs a change since the last review", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "period a");
  await mem(p.id, "period b");
  await ok("POST", "/review", { project_id: p.id });

  // Reviewed 3 days ago, memory changed since: still inside the 7-day period.
  reviewedDaysAgo(p.id, 3);
  await ok("PATCH", `/entries/${a.id}`, { body: "changed inside the period" });
  assert.equal(scheduledFor(p.id).length, 0, "too soon");

  // Reviewed 10 days ago, nothing changed since: nothing to review.
  reviewedDaysAgo(p.id, 10);
  assert.equal(scheduledFor(p.id).length, 0, "no change since the last review");

  // A change after the last review makes it due.
  await ok("PATCH", `/entries/${a.id}`, { body: "changed after the review" });
  const jobs = scheduledFor(p.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.scheduled, true);
  // Right after queuing, it is pending: a second check adds nothing.
  assert.equal(scheduledFor(p.id).length, 0);
  db.prepare(`UPDATE review_jobs SET status = 'done' WHERE status = 'pending'`).run();

  // A deletion is a change too.
  reviewedDaysAgo(p.id, 10);
  await mem(p.id, "period c");
  reviewedDaysAgo(p.id, 10);
  await ok("DELETE", `/entries/${a.id}`);
  assert.equal(scheduledFor(p.id).length, 1);
  db.prepare(`UPDATE review_jobs SET status = 'done' WHERE status = 'pending'`).run();
});

test("runQueueOnce({ schedule: true }) queues and runs the review, but only proposes", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "propose a");
  await mem(p.id, "propose b");
  // Every scope that comes due gets the same answer; ids outside a batch are dropped by validation.
  llmDefault({ proposals: [{ kind: "delete", ids: [a.id], reason: "scheduled test" }] });

  await runQueueOnce({ schedule: true });

  const jobs = jobsOf(p.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "done");
  assert.equal(JSON.parse(jobs[0].payload).scheduled, true);
  const proposals = await ok<Any[]>("GET", `/review/proposals?job_id=${jobs[0].id}`);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, "pending", "waits for a person");
  const r = await call("GET", `/entries/${a.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.entry.deleted_at, null, "the memory is untouched");

  // Nothing changed since: another scheduled pass queues nothing for this scope.
  await runQueueOnce({ schedule: true });
  assert.equal(jobsOf(p.id).length, 1);
});

test("a scheduled review that failed or was skipped does not count as the last review; a cancelled one does", async () => {
  const p = await freshProject();
  await mem(p.id, "failed run a");
  await mem(p.id, "failed run b");
  for (const end of ["error", "skipped"] as const) {
    const [job] = scheduledFor(p.id);
    assert.ok(job, `queued before the ${end} run`);
    db.prepare(`UPDATE review_jobs SET status = ? WHERE id = ?`).run(end, job.id);
    // Nothing changed since, and the failed run is younger than the period: still due.
    assert.equal(scheduledFor(p.id).length, 1, `retried after ${end}`);
    db.prepare(`UPDATE review_jobs SET status = ? WHERE project_id = ? AND status = 'pending'`).run(end, p.id);
  }
  // A person cancelling it is a decision: no re-queue within the period.
  const [cancelled] = scheduledFor(p.id);
  db.prepare(`UPDATE review_jobs SET status = 'cancelled' WHERE id = ?`).run(cancelled.id);
  assert.equal(scheduledFor(p.id).length, 0, "cancelled counts as the last review");
});

test("a scheduled review that errors on the LLM is retried on the next check (run end to end)", async () => {
  const p = await freshProject();
  await mem(p.id, "llm down a");
  await mem(p.id, "llm down b");
  assert.equal(scheduledFor(p.id).length, 1);
  llmDefault(new Error("upstream down"));
  await runQueueOnce();
  assert.equal(jobsOf(p.id).at(-1).status, "error");
  const again = scheduledFor(p.id);
  assert.equal(again.length, 1);
  db.prepare(`UPDATE review_jobs SET status = 'done' WHERE id = ?`).run(again[0].id);
});
