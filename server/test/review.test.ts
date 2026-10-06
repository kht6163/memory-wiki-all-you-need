import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Entry } from "../src/db.ts";
import { addProposal, buildReviewBatches, versionOf } from "../src/review.ts";
import { updateEntry } from "../src/store.ts";
import { call, db, entry, llmCalls, llmDefault, llmReply, llmReset, ok, project, runQueueOnce } from "./helpers.ts";

// Memory review: POST /review → job → fake LLM proposals → apply / dismiss.
// Every test uses its own project so scopes and pending jobs never collide
// (all tests in this file share one DB).

let pn = 0;
async function freshProject() {
  pn++;
  return project(`github.com/test/review-${pn}`, `review-${pn}`);
}

async function mem(pid: number, title: string, extra: Record<string, unknown> = {}) {
  return entry({ scope: "project", project_id: pid, title, body: `${title} body`, ...extra });
}

const OLD = "2020-01-01T00:00:00.000Z";
/** Push updated_at into the past so a later edit always gets a different timestamp. */
function backdate(ids: number[], at = OLD) {
  for (const id of ids) db.prepare(`UPDATE entries SET updated_at = ? WHERE id = ?`).run(at, id);
}

const getEntry = async (id: number) => (await ok("GET", `/entries/${id}`)) as { entry: any; entities: any[]; links: any[] };

/** Enqueue a review of a project, answer its LLM call(s) with `reply`, run the queue. */
async function runReview(pid: number, ...replies: unknown[]) {
  const job = await ok("POST", "/review", { project_id: pid });
  llmReply(...replies);
  await runQueueOnce();
  const jobs = await ok<any[]>("GET", "/review/jobs?limit=100");
  const j = jobs.find((x) => x.id === job.id);
  const proposals = await ok<any[]>("GET", `/review/proposals?job_id=${job.id}`);
  return { job: j, proposals };
}

function newJobId(projectId: number | null = null): number {
  const r = db.prepare(`INSERT INTO review_jobs (project_id, status, payload) VALUES (?, 'done', '{"entries":[]}')`).run(projectId);
  return Number(r.lastInsertRowid);
}
/** What the LLM "saw": each memory's current version (latest revision id). */
const seen = (ids: number[]) => new Map(ids.map((id) => [id, versionOf(id)]));
const entryRow = (id: number): Entry => db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id) as unknown as Entry;

beforeEach(() => {
  llmReset();
});

test("POST /review: 404 unknown project, 400 with fewer than 2 memories", async () => {
  const p = await freshProject();
  let r = await call("POST", "/review", { project_id: p.id });
  assert.equal(r.status, 400, "empty project");
  await mem(p.id, "only one");
  r = await call("POST", "/review", { project_id: p.id });
  assert.equal(r.status, 400, "one memory");
  r = await call("POST", "/review", { project_id: 999_999 });
  assert.equal(r.status, 404);
  assert.equal(llmCalls.length, 0);
});

test("POST /review enqueues, 409 while one is running for the scope, then runs with the fake LLM", async () => {
  const p = await freshProject();
  const other = await freshProject();
  const a = await mem(p.id, "alpha");
  const b = await mem(p.id, "beta");
  await mem(other.id, "x1");
  await mem(other.id, "x2");

  const r1 = await call("POST", "/review", { project_id: p.id });
  assert.equal(r1.status, 201);
  assert.equal(r1.data.status, "pending");
  assert.deepEqual(r1.data.payload.entries, [a.id, b.id]);
  const r2 = await call("POST", "/review", { project_id: p.id });
  assert.equal(r2.status, 409, "second review of the same scope while pending");
  // A different scope is independent.
  const r3 = await call("POST", "/review", { project_id: other.id });
  assert.equal(r3.status, 201);

  const health = await ok("GET", "/health");
  assert.ok(health.reviewRunning >= 2);

  llmDefault({ proposals: [] });
  await runQueueOnce();
  assert.equal(llmCalls.length, 2, "one LLM call per job (single batch each)");
  const jobs = await ok<any[]>("GET", "/review/jobs?limit=100");
  for (const id of [r1.data.id, r3.data.id]) {
    const j = jobs.find((x) => x.id === id);
    assert.equal(j.status, "done");
    assert.equal(j.result.chunks, 1);
    assert.equal(j.result.proposals, 0);
  }
  // The p job's prompt carries exactly p's memories.
  const pCall = llmCalls.find((c) => c.user.includes('"title":"alpha"'))!;
  assert.ok(pCall.user.includes('"title":"beta"'));
  assert.ok(!pCall.user.includes('"title":"x1"'));

  // Finished → a new review of the same scope may start.
  const r4 = await call("POST", "/review", { project_id: p.id });
  assert.equal(r4.status, 201);
  await runQueueOnce();
});

test("standing memories are never reviewed nor proposable", async () => {
  const p = await freshProject();
  const s = await mem(p.id, "always answer in Korean", { category: "standing" });
  const a = await mem(p.id, "fact one");
  // standing + 1 normal = not enough to review
  assert.equal((await call("POST", "/review", { project_id: p.id })).status, 400);
  const b = await mem(p.id, "fact two");

  const { job, proposals } = await runReview(p.id, {
    proposals: [
      { kind: "delete", ids: [s.id], reason: "obsolete" },
      { kind: "merge", ids: [s.id, a.id], title: "merged", reason: "dup" },
      { kind: "update", ids: [s.id], title: "changed", reason: "x" },
    ],
  });
  assert.deepEqual(job.payload.entries, [a.id, b.id]);
  assert.equal(llmCalls.length, 1);
  assert.ok(!llmCalls[0].user.includes("always answer in Korean"), "standing memory never sent to the LLM");
  assert.equal(proposals.length, 0);
  assert.equal((await getEntry(s.id)).entry.title, "always answer in Korean");

  // Direct validation: even if a standing id were allowed, it is rejected.
  const jid = newJobId(p.id);
  assert.equal(addProposal(jid, { kind: "delete", ids: [s.id] }, seen([s.id])), null);
});

test("batches group memories sharing an entity into the same LLM call", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "pg pool size", { entities: ["PostgreSQL"], category: "fact" });
  const b = await mem(p.id, "lint rule", { category: "convention" });
  const c = await mem(p.id, "pg version", { entities: ["PostgreSQL"], category: "decision" });
  const d = await mem(p.id, "redis ttl", { entities: ["Redis"], category: "fact" });
  const e = await mem(p.id, "redis eviction", { entities: ["Redis"], category: "insight" });
  const rows = [a, b, c, d, e].map((x) => entryRow(x.id));
  const fmt = () => "x".repeat(99); // 100 chars per memory with the newline

  // Budget fits one 2-memory group but not two.
  const small = buildReviewBatches(rows.map((r) => ({ ...r, id: Number(r.id) }) as Entry), fmt, 250).map((bt) => bt.map((x) => x.id).sort((m, n) => m - n));
  assert.equal(small.length, 3);
  assert.ok(small.some((bt) => JSON.stringify(bt) === JSON.stringify([a.id, c.id])), `PostgreSQL group together: ${JSON.stringify(small)}`);
  assert.ok(small.some((bt) => JSON.stringify(bt) === JSON.stringify([d.id, e.id])), `Redis group together: ${JSON.stringify(small)}`);
  assert.ok(small.some((bt) => JSON.stringify(bt) === JSON.stringify([b.id])));

  // End to end (default budget, one batch): entity groups come first, members adjacent.
  const { job } = await runReview(p.id, { proposals: [] });
  assert.equal(job.status, "done");
  assert.equal(llmCalls.length, 1);
  const order = [...llmCalls[0].user.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(order.length, 5);
  const ia = order.indexOf(a.id), ic = order.indexOf(c.id), id = order.indexOf(d.id), ie = order.indexOf(e.id);
  assert.equal(Math.abs(ia - ic), 1, "PostgreSQL memories adjacent");
  assert.equal(Math.abs(id - ie), 1, "Redis memories adjacent");
  assert.equal(order.indexOf(b.id), 4, "ungrouped memory last");
});

test("proposal validation: ids outside the batch are dropped", async () => {
  const p = await freshProject();
  const other = await freshProject();
  const a = await mem(p.id, "in batch a");
  const b = await mem(p.id, "in batch b");
  const x = await mem(other.id, "outside x");
  const { proposals } = await runReview(p.id, {
    proposals: [
      { kind: "delete", ids: [x.id], reason: "not shown" },
      { kind: "update", id: x.id, title: "hijack", reason: "not shown" },
      { kind: "merge", ids: [a.id, x.id], title: "cross", reason: "x is outside → only 1 id left" },
      { kind: "merge", ids: [a.id, b.id, x.id], title: "ab", body: "merged", reason: "x dropped, a+b kept" },
      { kind: "bogus", ids: [a.id] },
    ],
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, "merge");
  assert.deepEqual(proposals[0].entry_ids, [a.id, b.id]);
  assert.equal(proposals[0].status, "pending");
  assert.equal((await getEntry(x.id)).entry.title, "outside x");
});

test("proposal validation: merge across scopes or projects is rejected", async () => {
  const p1 = await freshProject();
  const p2 = await freshProject();
  const a = await mem(p1.id, "p1 memory");
  const b = await mem(p2.id, "p2 memory");
  const g = await entry({ scope: "global", title: "review global memory" });
  const u = await entry({ scope: "user", title: "review user memory" });
  const jid = newJobId(null);
  assert.equal(addProposal(jid, { kind: "merge", ids: [a.id, b.id], title: "t" }, seen([a.id, b.id])), null, "two projects");
  assert.equal(addProposal(jid, { kind: "merge", ids: [g.id, u.id], title: "t" }, seen([g.id, u.id])), null, "global + user");
  assert.equal(addProposal(jid, { kind: "merge", ids: [g.id, a.id], title: "t" }, seen([g.id, a.id])), null, "global + project");
  // A conflict across scopes is fine (nothing is merged).
  const c = addProposal(jid, { kind: "conflict", ids: [g.id, u.id], note: "contradict" }, seen([g.id, u.id]));
  assert.ok(c);
  assert.equal(c.data.note, "contradict");
  await ok("POST", `/review/proposals/${c.id}/dismiss`);
});

test("proposal validation: pinned memories (delete rejected, merge reorders, two pinned rejected)", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "plain a");
  const pin1 = await mem(p.id, "pinned one", { pinned: true });
  const pin2 = await mem(p.id, "pinned two", { pinned: true });
  const b = await mem(p.id, "plain b");
  const jid = newJobId(p.id);
  const all = seen([a.id, pin1.id, pin2.id, b.id]);

  assert.equal(addProposal(jid, { kind: "delete", ids: [pin1.id] }, all), null, "delete pinned");
  assert.equal(addProposal(jid, { kind: "merge", ids: [a.id, pin1.id, pin2.id], title: "t" }, all), null, "two pinned");

  const m = addProposal(jid, { kind: "merge", ids: [a.id, pin1.id, b.id], title: "merged", reason: "dup" }, all);
  assert.ok(m);
  assert.deepEqual(m.entry_ids, [pin1.id, a.id, b.id], "pinned memory moved first so it is the one kept");

  const ok1 = addProposal(jid, { kind: "merge", ids: [pin2.id, a.id], title: "t2" }, all);
  assert.ok(ok1, "pinned already first is fine");
  assert.deepEqual(ok1.entry_ids, [pin2.id, a.id]);

  const del = addProposal(jid, { kind: "delete", ids: [b.id] }, all);
  assert.ok(del, "delete unpinned allowed");
});

test("proposal validation: empty update, untitled merge, wrong arity rejected", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "va");
  const b = await mem(p.id, "vb");
  const jid = newJobId(p.id);
  const all = seen([a.id, b.id]);
  assert.equal(addProposal(jid, { kind: "update", ids: [a.id], reason: "no changes" }, all), null);
  assert.equal(addProposal(jid, { kind: "merge", ids: [a.id, b.id], body: "no title" }, all), null);
  assert.equal(addProposal(jid, { kind: "merge", ids: [a.id] , title: "t"}, all), null);
  assert.equal(addProposal(jid, { kind: "conflict", ids: [a.id] }, all), null);
  assert.equal(addProposal(jid, { kind: "update", ids: [a.id, b.id], title: "t" }, all), null);
  assert.equal(addProposal(jid, { kind: "delete", ids: [a.id, b.id] }, all), null);
  const u = addProposal(jid, { kind: "update", ids: [a.id], category: "convention" }, all);
  assert.ok(u, "a category-only update is a change");
});

test("proposal validation: duplicate pending proposal for the same id set is rejected", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "da");
  const b = await mem(p.id, "db");
  const jid = newJobId(p.id);
  const all = seen([a.id, b.id]);
  const first = addProposal(jid, { kind: "merge", ids: [a.id, b.id], title: "m" }, all);
  assert.ok(first);
  assert.equal(addProposal(jid, { kind: "merge", ids: [b.id, a.id], title: "m2" }, all), null, "same set, other order");
  // A different kind on the same set is a different proposal.
  assert.ok(addProposal(jid, { kind: "conflict", ids: [a.id, b.id] }, all));
  // Through a second review run, the pending duplicate is not stored again.
  const { proposals } = await runReview(p.id, { proposals: [{ kind: "merge", ids: [a.id, b.id], title: "again" }] });
  assert.equal(proposals.length, 0);
});

test("apply merge: keeps the FIRST id, merged text, entity union, links moved, others soft-deleted", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "pool max 20", { entities: ["PostgreSQL"] });
  const b = await mem(p.id, "pool size twenty", { entities: ["PgBouncer"] });
  const c = await mem(p.id, "db pool", { entities: ["Docker"] });
  const z = await mem(p.id, "unrelated target");
  await ok("POST", `/entries/${b.id}/links`, { to: z.id, type: "depends_on" });
  await ok("POST", `/entries/${z.id}/links`, { to: c.id, type: "because" });

  // LLM lists c first → c is kept (no pinned involved).
  const { proposals } = await runReview(p.id, {
    proposals: [{ kind: "merge", ids: [c.id, a.id, b.id], title: "DB pool max 20", body: "PgBouncer pool max 20", category: "fact", reason: "same fact" }],
  });
  assert.equal(proposals.length, 1);
  const prop = proposals[0];
  assert.deepEqual(prop.entry_ids, [c.id, a.id, b.id]);
  assert.equal(prop.entries.length, 3);
  assert.ok(prop.entries.every((e: any) => e.changed === false));

  // Nothing changed before apply.
  for (const [x, title] of [[a, "pool max 20"], [b, "pool size twenty"], [c, "db pool"]] as const) {
    const cur = await getEntry(x.id);
    assert.equal(cur.entry.title, title);
    assert.equal(cur.entry.deleted_at, null);
  }
  assert.equal((await ok("GET", "/health")).reviewProposals >= 1, true);

  const applied = await ok("POST", `/review/proposals/${prop.id}/apply`);
  assert.equal(applied.status, "applied");
  assert.ok(applied.decided_at);

  const kept = await getEntry(c.id);
  assert.equal(kept.entry.deleted_at, null);
  assert.equal(kept.entry.title, "DB pool max 20");
  assert.equal(kept.entry.body, "PgBouncer pool max 20");
  const names = kept.entities.map((e: any) => e.name).sort();
  assert.deepEqual(names, ["Docker", "PgBouncer", "PostgreSQL"]);
  // b→z moved to c→z; z→c stays.
  const links = kept.links.map((l: any) => `${l.from_id}-${l.to_id}-${l.type}`).sort();
  assert.deepEqual(links, [`${c.id}-${z.id}-depends_on`, `${z.id}-${c.id}-because`].sort());
  for (const x of [a, b]) {
    const gone = await getEntry(x.id);
    assert.ok(gone.entry.deleted_at, `#${x.id} soft-deleted`);
  }
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_links WHERE from_id = ? OR to_id = ?`).get(b.id, b.id)!.n, 0);

  // Applying twice is refused.
  assert.equal((await call("POST", `/review/proposals/${prop.id}/apply`)).status, 409);
});

test("apply after a memory was edited or deleted → 409 and status stale", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "sa");
  const b = await mem(p.id, "sb");
  const c = await mem(p.id, "sc");
  backdate([a.id, b.id, c.id]);
  const { proposals } = await runReview(p.id, {
    proposals: [
      { kind: "merge", ids: [a.id, b.id], title: "ab", reason: "dup" },
      { kind: "delete", ids: [c.id], reason: "obsolete" },
    ],
  });
  assert.equal(proposals.length, 2);
  const merge = proposals.find((x) => x.kind === "merge")!;
  const del = proposals.find((x) => x.kind === "delete")!;

  await ok("PATCH", `/entries/${b.id}`, { body: "edited by a human" });
  const listed = await ok<any[]>("GET", `/review/proposals?job_id=${merge.job_id}`);
  assert.equal(listed.find((x) => x.id === merge.id).entries.find((e: any) => e.id === b.id).changed, true);

  const r = await call("POST", `/review/proposals/${merge.id}/apply`);
  assert.equal(r.status, 409);
  const after = await ok<any[]>("GET", `/review/proposals?status=stale`);
  assert.ok(after.some((x) => x.id === merge.id));
  assert.equal((await getEntry(a.id)).entry.deleted_at, null, "nothing merged");
  assert.equal((await getEntry(a.id)).entry.title, "sa");

  await ok("DELETE", `/entries/${c.id}`);
  assert.equal((await call("POST", `/review/proposals/${del.id}/apply`)).status, 409);
  assert.equal((await ok<any[]>("GET", `/review/proposals?job_id=${del.job_id}`)).find((x) => x.id === del.id).status, "stale");
});

test("apply update and delete; dismiss leaves memories untouched", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "ua");
  const b = await mem(p.id, "ub");
  const c = await mem(p.id, "uc");
  const { proposals } = await runReview(p.id, {
    proposals: [
      { kind: "update", ids: [a.id], title: "ua clarified", category: "convention", reason: "unclear" },
      { kind: "delete", ids: [b.id], reason: "transient" },
      { kind: "delete", ids: [c.id], reason: "maybe" },
    ],
  });
  assert.equal(proposals.length, 3);
  const upd = proposals.find((x) => x.kind === "update")!;
  const delB = proposals.find((x) => x.kind === "delete" && x.entry_ids[0] === b.id)!;
  const delC = proposals.find((x) => x.kind === "delete" && x.entry_ids[0] === c.id)!;

  await ok("POST", `/review/proposals/${upd.id}/apply`);
  const ua = (await getEntry(a.id)).entry;
  assert.equal(ua.title, "ua clarified");
  assert.equal(ua.category, "convention");
  assert.equal(ua.body, "ua body", "body untouched when not proposed");

  await ok("POST", `/review/proposals/${delB.id}/apply`);
  assert.ok((await getEntry(b.id)).entry.deleted_at);

  const d = await ok("POST", `/review/proposals/${delC.id}/dismiss`);
  assert.equal(d.status, "dismissed");
  assert.equal((await getEntry(c.id)).entry.deleted_at, null);
  assert.equal((await call("POST", `/review/proposals/${delC.id}/dismiss`)).status, 409);
  assert.equal((await call("POST", `/review/proposals/${delC.id}/apply`)).status, 409);
  assert.equal((await call("POST", `/review/proposals/999999/dismiss`)).status, 404);
  assert.equal((await call("POST", `/review/proposals/999999/apply`)).status, 404);
});

test("apply conflict marks it applied without changing any memory", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "port is 8080");
  const b = await mem(p.id, "port is 9090");
  const before = [entryRow(a.id), entryRow(b.id)].map((r) => JSON.stringify(r));
  const { proposals } = await runReview(p.id, { proposals: [{ kind: "conflict", ids: [a.id, b.id], note: "which port?", reason: "contradict" }] });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].data.note, "which port?");
  const r = await ok("POST", `/review/proposals/${proposals[0].id}/apply`);
  assert.equal(r.status, "applied");
  const after = [entryRow(a.id), entryRow(b.id)].map((r) => JSON.stringify(r));
  assert.deepEqual(after, before);
});

test("GET /review/proposals filters by project and status", async () => {
  const p1 = await freshProject();
  const p2 = await freshProject();
  const a = await mem(p1.id, "fa");
  const b = await mem(p1.id, "fb");
  await mem(p2.id, "fc");
  await mem(p2.id, "fd");
  await runReview(p1.id, { proposals: [{ kind: "delete", ids: [a.id] }] });
  const only1 = await ok<any[]>("GET", `/review/proposals?project_id=${p1.id}&status=pending`);
  assert.equal(only1.length, 1);
  assert.deepEqual(only1[0].entry_ids, [a.id]);
  const only2 = await ok<any[]>("GET", `/review/proposals?project_id=${p2.id}`);
  assert.equal(only2.length, 0);
  assert.ok(b.id);
});

test("LLM failure → job error; retry only for errored jobs, then it completes", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "ra");
  const b = await mem(p.id, "rb");
  const { job } = await runReview(p.id, new Error("boom"));
  assert.equal(job.status, "error");
  assert.match(job.error, /boom/);
  assert.equal((await call("GET", `/review/proposals?job_id=${job.id}`)).data.length, 0);
  // Retry puts it back in the queue.
  const r = await ok("POST", `/review/jobs/${job.id}/retry`);
  assert.equal(r.status, "pending");
  assert.equal(r.error, null);
  assert.equal((await call("POST", "/review", { project_id: p.id })).status, 409, "retried job counts as running");
  llmReply({ proposals: [{ kind: "merge", ids: [a.id, b.id], title: "rab" }] });
  await runQueueOnce();
  const jobs = await ok<any[]>("GET", "/review/jobs?limit=100");
  const done = jobs.find((x) => x.id === job.id);
  assert.equal(done.status, "done");
  assert.equal(done.result.proposals, 1);
  // Not an error anymore → retry refused.
  assert.equal((await call("POST", `/review/jobs/${job.id}/retry`)).status, 409);
  assert.equal((await call("POST", `/review/jobs/999999/retry`)).status, 404);
});

test("GET /review/stale lists memories not used and not updated for N days", async () => {
  const p = await freshProject();
  const oldNever = await mem(p.id, "old never used");
  const oldUsedRecently = await mem(p.id, "old used recently");
  const oldUsedLongAgo = await mem(p.id, "old used long ago");
  const recent = await mem(p.id, "recently updated");
  const oldPinned = await mem(p.id, "old pinned", { pinned: true });
  const oldStanding = await mem(p.id, "old standing rule", { category: "standing" });
  const oldDeleted = await mem(p.id, "old deleted");
  await ok("DELETE", `/entries/${oldDeleted.id}`);
  const day = 86_400_000;
  const ago = (d: number) => new Date(Date.now() - d * day).toISOString();
  backdate([oldNever.id, oldUsedRecently.id, oldUsedLongAgo.id, oldPinned.id, oldStanding.id, oldDeleted.id], ago(100));
  const usage = db.prepare(`INSERT OR REPLACE INTO entry_usage (entry_id, recalled, searched, last_used_at) VALUES (?, 1, 0, ?)`);
  usage.run(oldUsedRecently.id, ago(5));
  const longAgo = ago(80);
  usage.run(oldUsedLongAgo.id, longAgo);

  const stale = await ok<any[]>("GET", `/review/stale?project_id=${p.id}&days=30`);
  const ids = stale.map((e) => e.id).sort((m, n) => m - n);
  assert.deepEqual(ids, [oldNever.id, oldUsedLongAgo.id].sort((m, n) => m - n));
  const ula = stale.find((e) => e.id === oldUsedLongAgo.id);
  assert.equal(ula.last_used_at, longAgo);
  assert.equal(stale.find((e) => e.id === oldNever.id).last_used_at, null);

  // A longer window drops memories used within it.
  const stale90 = await ok<any[]>("GET", `/review/stale?project_id=${p.id}&days=90`);
  assert.deepEqual(stale90.map((e) => e.id), [oldNever.id]);
  assert.ok(recent.id);
});

// ------------------------------------------------- snapshot / staleness by version

test("a memory edited while the LLM is reading it: proposals touching it are dropped", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "edit-during a");
  const b = await mem(p.id, "edit-during b");
  const c = await mem(p.id, "edit-during c");
  const d = await mem(p.id, "edit-during d");
  const job = await ok("POST", "/review", { project_id: p.id });
  llmReply((callIn: { user: string }) => {
    // The prompt was built from the old text; a human edits a and (entity-only) c meanwhile.
    assert.ok(callIn.user.includes("edit-during a body"));
    updateEntry(a.id, { body: "changed during the call" }, { author: "human" });
    updateEntry(c.id, { entities: ["DuringCallEntity"] }, { author: "human" });
    return {
      proposals: [
        { kind: "update", ids: [a.id], title: "a rewritten", reason: "built on old text" },
        { kind: "merge", ids: [a.id, b.id], title: "ab", reason: "a changed" },
        { kind: "delete", ids: [c.id], reason: "entities changed" },
        { kind: "conflict", ids: [b.id, d.id], note: "untouched", reason: "kept" },
        { kind: "update", ids: [d.id], title: "d clarified", reason: "kept" },
      ],
    };
  });
  await runQueueOnce();
  assert.equal(llmCalls.length, 1);
  const j = (await ok<any[]>("GET", "/review/jobs?limit=100")).find((x) => x.id === job.id);
  assert.equal(j.status, "done");
  assert.equal(j.result.proposals, 2);
  const props = await ok<any[]>("GET", `/review/proposals?job_id=${job.id}`);
  assert.deepEqual(props.map((x) => `${x.kind}:${x.entry_ids.join(",")}`).sort(), [`conflict:${b.id},${d.id}`, `update:${d.id}`].sort());
  assert.equal((await getEntry(a.id)).entry.body, "changed during the call", "the human edit stands");
  // The kept proposals are applicable (their snapshot is current).
  const upd = props.find((x) => x.kind === "update");
  assert.ok(upd.entries.every((e: any) => e.changed === false));
  assert.equal((await ok("POST", `/review/proposals/${upd.id}/apply`)).status, "applied");
});

test("addProposal: a version different from the seen one is rejected; snap records the seen version", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "ver a");
  const b = await mem(p.id, "ver b");
  const jid = newJobId(p.id);
  const before = seen([a.id, b.id]);
  await ok("PATCH", `/entries/${b.id}`, { title: "ver b edited" });
  assert.equal(addProposal(jid, { kind: "merge", ids: [a.id, b.id], title: "t" }, before), null);
  const okP = addProposal(jid, { kind: "delete", ids: [a.id] }, before);
  assert.ok(okP);
  assert.deepEqual(okP.data.snap, { [String(a.id)]: versionOf(a.id) });
  assert.notEqual(versionOf(a.id), "", "a memory has at least one revision");
});

test("entity-only edit after a proposal → apply 409, proposal stale, listed as changed", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "eo a", { entities: ["Kafka"] });
  const b = await mem(p.id, "eo b", { entities: ["Kafka"] });
  const { proposals } = await runReview(p.id, { proposals: [{ kind: "merge", ids: [a.id, b.id], title: "kafka", reason: "dup" }] });
  assert.equal(proposals.length, 1);
  const prop = proposals[0];
  const updatedBefore = entryRow(b.id).updated_at;

  await ok("PATCH", `/entries/${b.id}`, { entities: ["Kafka", "Zookeeper"] });
  assert.deepEqual((await getEntry(b.id)).entities.map((e: any) => e.name).sort(), ["Kafka", "Zookeeper"]);
  const listed = (await ok<any[]>("GET", `/review/proposals?job_id=${prop.job_id}`)).find((x) => x.id === prop.id);
  assert.equal(listed.entries.find((e: any) => e.id === b.id).changed, true, `entity-only edit counts as a change (updated_at ${updatedBefore})`);
  assert.equal(listed.entries.find((e: any) => e.id === a.id).changed, false);

  const r = await call("POST", `/review/proposals/${prop.id}/apply`);
  assert.equal(r.status, 409);
  const after = (await ok<any[]>("GET", `/review/proposals?job_id=${prop.job_id}`)).find((x) => x.id === prop.id);
  assert.equal(after.status, "stale");
  assert.equal((await getEntry(a.id)).entry.deleted_at, null);
  assert.equal((await getEntry(b.id)).entry.deleted_at, null);
});

// ----------------------------------------------------------- field validation

test("categories: unknown or standing dropped; an update left with nothing is rejected", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "cat a", { category: "fact" });
  const b = await mem(p.id, "cat b", { category: "fact" });
  const jid = newJobId(p.id);
  const all = seen([a.id, b.id]);
  assert.equal(addProposal(jid, { kind: "update", ids: [a.id], category: "standing" }, all), null, "standing only → nothing left");
  assert.equal(addProposal(jid, { kind: "update", ids: [a.id], category: "bogus" }, all), null, "unknown only → nothing left");
  const u = addProposal(jid, { kind: "update", ids: [a.id], title: "cat a better", category: "bogus" }, all);
  assert.ok(u);
  assert.equal(u.data.title, "cat a better");
  assert.ok(!("category" in u.data), "unknown category dropped");
  const m = addProposal(jid, { kind: "merge", ids: [a.id, b.id], title: "cat ab", body: "merged", category: "standing" }, all);
  assert.ok(m);
  assert.ok(!("category" in m.data), "standing never proposed");

  await ok("POST", `/review/proposals/${m.id}/apply`);
  const kept = (await getEntry(a.id)).entry;
  assert.equal(kept.category, "fact", "category untouched");
  assert.equal(kept.title, "cat ab");

  // Through the LLM path too.
  const c = await mem(p.id, "cat c", { category: "fact" });
  const { proposals } = await runReview(p.id, {
    proposals: [
      { kind: "update", ids: [c.id], category: "standing", reason: "promote" },
      { kind: "update", ids: [c.id], title: "cat c fixed", category: "Convention!!", reason: "x" },
    ],
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].data.title, "cat c fixed");
  assert.equal(proposals[0].data.category, undefined);
});

test("empty strings count as absent fields", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "empty a");
  const b = await mem(p.id, "empty b");
  const jid = newJobId(p.id);
  const all = seen([a.id, b.id]);
  assert.equal(addProposal(jid, { kind: "update", ids: [a.id], title: "", body: "   ", category: "" }, all), null);
  assert.equal(addProposal(jid, { kind: "merge", ids: [a.id, b.id], title: "  ", body: "x" }, all), null, "blank merge title");
  const u = addProposal(jid, { kind: "update", ids: [a.id], title: "", body: "new body", category: "" }, all);
  assert.ok(u);
  assert.deepEqual(Object.keys(u.data).sort(), ["body", "snap"]);
  await ok("POST", `/review/proposals/${u.id}/apply`);
  const e = (await getEntry(a.id)).entry;
  assert.equal(e.title, "empty a", "empty title did not blank the memory");
  assert.equal(e.body, "new body");
  // Empty body on a merge → members' bodies are kept (see next test).
  const m = addProposal(jid, { kind: "merge", ids: [a.id, b.id], title: "ab", body: "" }, seen([a.id, b.id]));
  assert.ok(m);
  assert.equal(m.data.body, "new body\n\nempty b body");
});

test("merge without body keeps every member's distinct body", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "mb a", { body: "shared text" });
  const b = await mem(p.id, "mb b", { body: "shared text" });
  const c = await mem(p.id, "mb c", { body: "only in c" });
  const pin = await mem(p.id, "mb pinned", { body: "pinned text", pinned: true });
  const { proposals } = await runReview(p.id, {
    proposals: [
      { kind: "merge", ids: [a.id, b.id, c.id], title: "mb merged", reason: "dup" },
      { kind: "merge", ids: [c.id, pin.id], title: "mb pin merged", reason: "pinned moves first" },
    ],
  });
  assert.equal(proposals.length, 2);
  const m1 = proposals.find((x) => x.data.title === "mb merged");
  const m2 = proposals.find((x) => x.data.title === "mb pin merged");
  assert.equal(m1.data.body, "shared text\n\nonly in c");
  assert.deepEqual(m2.entry_ids, [pin.id, c.id]);
  // Order of the parts is not pinned down when the pinned memory is moved first; both must be there.
  assert.deepEqual(m2.data.body.split("\n\n").sort(), ["only in c", "pinned text"]);

  await ok("POST", `/review/proposals/${m1.id}/apply`);
  const kept = (await getEntry(a.id)).entry;
  assert.equal(kept.title, "mb merged");
  assert.equal(kept.body, "shared text\n\nonly in c");
  assert.ok((await getEntry(c.id)).entry.deleted_at);
});

// ----------------------------------------------------------------- dedupe

test("a dismissed proposal is not re-proposed while its memories are unchanged; it is after a change", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "dis a");
  const b = await mem(p.id, "dis b");
  const merge = { kind: "merge", ids: [a.id, b.id], title: "dis ab", reason: "dup" };

  const r1 = await runReview(p.id, { proposals: [merge] });
  assert.equal(r1.proposals.length, 1);
  await ok("POST", `/review/proposals/${r1.proposals[0].id}/dismiss`);

  // Same memories, same versions, same kind (any order) → not asked again.
  const r2 = await runReview(p.id, { proposals: [{ ...merge, ids: [b.id, a.id], title: "dis ab again" }] });
  assert.equal(r2.job.status, "done");
  assert.equal(r2.proposals.length, 0);
  assert.equal(r2.job.result.proposals, 0);
  // A different kind on the same set is still allowed.
  const r3 = await runReview(p.id, { proposals: [{ kind: "conflict", ids: [a.id, b.id], note: "?" }] });
  assert.equal(r3.proposals.length, 1);
  await ok("POST", `/review/proposals/${r3.proposals[0].id}/dismiss`);

  // A job of another scope cannot propose on this project's memories at all.
  const otherScope = newJobId(null);
  assert.equal(addProposal(otherScope, merge, seen([a.id, b.id])), null, "project memories are out of the global review's scope");

  // After a change to one member, the same proposal may come back.
  await ok("PATCH", `/entries/${b.id}`, { body: "dis b changed" });
  const r4 = await runReview(p.id, { proposals: [merge] });
  assert.equal(r4.proposals.length, 1);
  assert.deepEqual(r4.proposals[0].entry_ids, [a.id, b.id]);
});

// ---------------------------------------------------------- merge entities

test("apply merge: entity union ordered by frequency, so the 12 cap drops the rarest", async () => {
  const p = await freshProject();
  const singles = Array.from({ length: 12 }, (_, i) => `Single${String(i).padStart(2, "0")}`);
  const a = await mem(p.id, "ef a", { entities: singles });
  const b = await mem(p.id, "ef b", { entities: ["SharedEnt"] });
  const c = await mem(p.id, "ef c", { entities: ["SharedEnt"] });
  assert.equal((await getEntry(a.id)).entities.length, 12);
  const jid = newJobId(p.id);
  const m = addProposal(jid, { kind: "merge", ids: [a.id, b.id, c.id], title: "ef merged", body: "x" }, seen([a.id, b.id, c.id]));
  assert.ok(m);
  await ok("POST", `/review/proposals/${m.id}/apply`);
  const names = (await getEntry(a.id)).entities.map((e: any) => e.name);
  assert.equal(names.length, 12, "capped at 12");
  assert.ok(names.includes("SharedEnt"), `shared entity (2 members) survives the cap: ${names.join(",")}`);
  assert.equal(names.filter((n: string) => n.startsWith("Single")).length, 11, "one single-member entity dropped");
});

// ------------------------------------------------------------- scope / jobs

test("GET /review/scope counts reviewable memories and those without entities", async () => {
  const p = await freshProject();
  assert.deepEqual(await ok("GET", `/review/scope?project_id=${p.id}`), { entries: 0, unlinked: 0, staleDays: 60, maxEntries: 2000 });
  await mem(p.id, "scope linked", { entities: ["ScopeEnt"] });
  await mem(p.id, "scope plain 1");
  await mem(p.id, "scope plain 2");
  await mem(p.id, "scope standing", { category: "standing" });
  const del = await mem(p.id, "scope deleted");
  await ok("DELETE", `/entries/${del.id}`);
  assert.deepEqual(await ok("GET", `/review/scope?project_id=${p.id}`), { entries: 3, unlinked: 2, staleDays: 60, maxEntries: 2000 });

  // No project → global + user memories.
  const before = await ok("GET", "/review/scope");
  await entry({ scope: "global", title: "scope global plain" });
  await entry({ scope: "user", title: "scope user linked", entities: ["ScopeEnt"] });
  await mem(p.id, "scope project only");
  const after = await ok("GET", "/review/scope");
  assert.equal(after.entries - before.entries, 2);
  assert.equal(after.unlinked - before.unlinked, 1);
  assert.deepEqual(await ok("GET", "/review/scope?project_id=0"), after, "0 means the global scope");
});

test("GET /review/jobs?project_id= filters by scope", async () => {
  const p1 = await freshProject();
  const p2 = await freshProject();
  for (const pid of [p1.id, p2.id]) {
    await mem(pid, `jobs ${pid} a`);
    await mem(pid, `jobs ${pid} b`);
  }
  llmDefault({ proposals: [] });
  const j1 = await ok("POST", "/review", { project_id: p1.id });
  const j2 = await ok("POST", "/review", { project_id: p2.id });
  const g = newJobId(null);
  await runQueueOnce();

  const only1 = await ok<any[]>("GET", `/review/jobs?project_id=${p1.id}&limit=100`);
  assert.deepEqual(only1.map((x) => x.id), [j1.id]);
  assert.equal(only1[0].project_name, p1.name);
  const only2 = await ok<any[]>("GET", `/review/jobs?project_id=${p2.id}&limit=100`);
  assert.deepEqual(only2.map((x) => x.id), [j2.id]);
  const global = await ok<any[]>("GET", `/review/jobs?project_id=0&limit=100`);
  assert.ok(global.some((x) => x.id === g));
  assert.ok(global.every((x) => x.project_id === null), "global filter has no project jobs");
  const all = await ok<any[]>("GET", "/review/jobs?limit=100");
  for (const id of [j1.id, j2.id, g]) assert.ok(all.some((x) => x.id === id), "no filter → every scope");
  assert.deepEqual(await ok("GET", `/review/jobs?project_id=999999`), []);
});

test("GET /review/stale: a memory shown in the stable block recently is not stale", async () => {
  const p = await freshProject();
  const shownRecently = await mem(p.id, "shown recently");
  const shownLongAgo = await mem(p.id, "shown long ago");
  const usedOldShownNew = await mem(p.id, "used long ago, shown recently");
  const day = 86_400_000;
  const ago = (d: number) => new Date(Date.now() - d * day).toISOString();
  backdate([shownRecently.id, shownLongAgo.id, usedOldShownNew.id], ago(100));
  const usage = db.prepare(`INSERT OR REPLACE INTO entry_usage (entry_id, recalled, searched, last_used_at, shown_at) VALUES (?, ?, 0, ?, ?)`);
  usage.run(shownRecently.id, 0, null, ago(3));
  usage.run(shownLongAgo.id, 0, null, ago(80));
  usage.run(usedOldShownNew.id, 1, ago(90), ago(2));

  const stale = await ok<any[]>("GET", `/review/stale?project_id=${p.id}&days=30`);
  assert.deepEqual(stale.map((e) => e.id), [shownLongAgo.id]);
  const stale90 = await ok<any[]>("GET", `/review/stale?project_id=${p.id}&days=90`);
  assert.deepEqual(stale90.map((e) => e.id), []);
});

test("a pending proposal built on older versions is retired when the review proposes it again", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "retire a");
  const b = await mem(p.id, "retire b");
  const merge = { kind: "merge", ids: [a.id, b.id], title: "retire ab", body: "x", reason: "dup" };
  const r1 = await runReview(p.id, { proposals: [merge] });
  assert.equal(r1.proposals.length, 1);
  await ok("PATCH", `/entries/${a.id}`, { body: "retire a changed" });
  const r2 = await runReview(p.id, { proposals: [{ ...merge, title: "retire ab v2" }] });
  assert.equal(r2.proposals.length, 1, "the fresh proposal is kept");
  const old = await ok<any[]>("GET", `/review/proposals?project_id=${p.id}&status=stale`);
  assert.ok(old.some((x) => x.id === r1.proposals[0].id), "the outdated pending one is marked stale");
});

test("proposals the store would refuse are dropped up front; a refused apply retires the proposal", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "limit a");
  const b = await mem(p.id, "limit b");
  const job = newJobId(p.id);
  assert.equal(addProposal(job, { kind: "update", ids: [a.id], body: "z".repeat(20_001), reason: "too long" }, seen([a.id])), null);
  assert.equal(addProposal(job, { kind: "update", ids: [a.id], body: "key " + "sk-" + "q".repeat(30), reason: "secret" }, seen([a.id])), null);
  const okP = addProposal(job, { kind: "update", ids: [b.id], title: "limit b fixed", reason: "fine" }, seen([b.id]));
  assert.ok(okP);
});

test("a review skips memories that moved out of its scope before their batch ran", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "moved a");
  const b = await mem(p.id, "moved b");
  const job = newJobId(p.id);
  await ok("PATCH", `/entries/${a.id}`, { scope: "global", project_id: null });
  assert.equal(addProposal(job, { kind: "delete", ids: [a.id], reason: "moved" }, seen([a.id])), null);
  assert.ok(addProposal(job, { kind: "delete", ids: [b.id], reason: "still here" }, seen([b.id])));
});

test("a review never rewrites the body of a memory the LLM only saw truncated", async () => {
  const p = await freshProject();
  const long = await mem(p.id, "trunc long", { body: "head " + "x".repeat(5000) + " TAIL-KEEP" });
  const short = await mem(p.id, "trunc short", { body: "short body" });
  const r = await runReview(p.id, {
    proposals: [
      { kind: "update", ids: [long.id], body: "rewritten from the head only", reason: "shorter" },
      { kind: "update", ids: [long.id], title: "trunc long renamed", reason: "title only is fine" },
      { kind: "update", ids: [short.id], body: "short body fixed", reason: "fine" },
    ],
  });
  const kinds = r.proposals.map((x: any) => [x.entry_ids[0], x.data.body ?? null, x.data.title ?? null]);
  assert.ok(!kinds.some(([id, body]: any) => id === long.id && body), "no body rewrite for the truncated memory");
  assert.ok(kinds.some(([id, , title]: any) => id === long.id && title === "trunc long renamed"));
  assert.ok(kinds.some(([id, body]: any) => id === short.id && body === "short body fixed"));
  const sent = llmCalls.at(-1)!.user.split("\n").find((l) => l.includes(`"id":${long.id},`)) ?? "";
  assert.match(sent, /"body_truncated":true/);
  assert.ok(!sent.includes("TAIL-KEEP"), "the tail was not shown");
});

test("a member superseded after the proposal makes apply 409 and the proposal stale (both merge orders)", async () => {
  for (const order of ["kept", "deleted"] as const) {
    const p = await freshProject();
    const a = await mem(p.id, `sup ${order} a`);
    const b = await mem(p.id, `sup ${order} b`);
    const ids = order === "kept" ? [b.id, a.id] : [a.id, b.id];
    const prop = addProposal(newJobId(p.id), { kind: "merge", ids, title: "merged", reason: "dup" }, seen(ids));
    assert.ok(prop);
    // Curation retires A after the proposal ("switched to X").
    const c = await mem(p.id, `sup ${order} c`);
    await ok("POST", `/entries/${c.id}/links`, { to: a.id, type: "supersedes" });
    const r = await call("POST", `/review/proposals/${prop!.id}/apply`);
    assert.equal(r.status, 409, order);
    assert.equal((await ok<any[]>(`GET`, `/review/proposals?job_id=${prop!.job_id}`)).find((x) => x.id === prop!.id).status, "stale");
    for (const x of [a, b]) assert.equal((await getEntry(x.id)).entry.deleted_at, null, "nothing merged");
    assert.equal((await getEntry(b.id)).entry.superseded_by, null);
  }
});

test("addProposal rejects a proposal touching a superseded memory", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "already sup a");
  const d = await mem(p.id, "already sup d");
  const c = await mem(p.id, "already sup c");
  const s = seen([a.id, d.id]);
  await ok("POST", `/entries/${c.id}/links`, { to: a.id, type: "supersedes" });
  // The link writes no memory revision, so the version check alone would pass.
  assert.equal(versionOf(a.id), s.get(a.id));
  assert.equal(addProposal(newJobId(p.id), { kind: "merge", ids: [a.id, d.id], title: "ad" }, s), null);
  assert.equal(addProposal(newJobId(p.id), { kind: "delete", ids: [a.id] }, s), null);
  assert.ok(addProposal(newJobId(p.id), { kind: "delete", ids: [d.id] }, s));
});

test("a review skips memories superseded after it was queued", async () => {
  const p = await freshProject();
  const a = await mem(p.id, "queued sup alpha");
  const b = await mem(p.id, "queued sup bravo");
  const d = await mem(p.id, "queued sup delta");
  const job = await ok("POST", "/review", { project_id: p.id });
  const c = await mem(p.id, "queued sup charlie");
  await ok("POST", `/entries/${c.id}/links`, { to: a.id, type: "supersedes" });
  let user = "";
  llmReply((call: { user: string }) => {
    user = call.user;
    return { proposals: [{ kind: "merge", ids: [a.id, b.id], title: "ab" }, { kind: "merge", ids: [b.id, d.id], title: "bd" }] };
  });
  await runQueueOnce();
  const j = (await ok<any[]>("GET", "/review/jobs?limit=100")).find((x) => x.id === job.id);
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.ok(!user.includes("queued sup alpha"), "the superseded memory is not shown to the LLM");
  assert.ok(user.includes("queued sup bravo"));
  const props = await ok<any[]>("GET", `/review/proposals?job_id=${job.id}`);
  assert.deepEqual(props.map((x) => x.entry_ids), [[b.id, d.id]]);
});

test("apply merge drops supersedes links into a merged-away memory (retiring or unconfirmed) instead of moving them onto the kept one", async () => {
  const p = await freshProject();
  const keep = await mem(p.id, "drop sup keep");
  const other = await mem(p.id, "drop sup other");
  const c = await mem(p.id, "drop sup replacement");
  const info = await mem(p.id, "drop sup info");
  await ok("POST", `/entries/${c.id}/links`, { to: other.id, type: "supersedes" });
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', 'llm', 0)`).run(info.id, other.id);
  // The replacement is in the trash, so `other` is current again and can be proposed.
  await ok("DELETE", `/entries/${c.id}`);
  const prop = addProposal(newJobId(p.id), { kind: "merge", ids: [keep.id, other.id], title: "kept fact" }, seen([keep.id, other.id]));
  assert.ok(prop);
  assert.equal((await call("POST", `/review/proposals/${prop!.id}/apply`)).status, 200);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_links WHERE from_id = ? AND type = 'supersedes'`).get(c.id)!.n, 0, "retiring link dropped");
  const moved = db.prepare(`SELECT retires FROM entry_links WHERE from_id = ? AND to_id = ? AND type = 'supersedes'`).get(info.id, keep.id) as any;
  assert.equal(moved, undefined, "an unconfirmed (retires = 0) link is dropped too: confirming it would hide the merged memory (G-084)");
  // Restoring the replacement must not retire the merged memory.
  await ok("POST", `/entries/${c.id}/restore`);
  assert.equal((await getEntry(keep.id)).entry.superseded_by, null);
});

test("apply merge: moving a member's links is recorded in graph history and can be reverted", async () => {
  const p = await freshProject();
  const keep = await mem(p.id, "history keep");
  const gone = await mem(p.id, "history gone");
  const z = await mem(p.id, "history target");
  await ok("POST", `/entries/${gone.id}/links`, { to: z.id, type: "depends_on" });
  const { proposals } = await runReview(p.id, {
    proposals: [{ kind: "merge", ids: [keep.id, gone.id], title: "history merged", body: "merged", category: "fact", reason: "same" }],
  });
  await ok("POST", `/review/proposals/${proposals[0].id}/apply`);
  const revs = (await ok("GET", `/graph/revisions?entry_id=${keep.id}&limit=20`)) as any[];
  const moved = revs.find((r) => r.target === "link" && r.action === "add" && r.snapshot?.from_id === keep.id && r.snapshot?.to_id === z.id);
  assert.ok(moved, "the moved link is in the history");
  assert.equal(moved.author, "llm");
  assert.equal(moved.revertible, true);
});
