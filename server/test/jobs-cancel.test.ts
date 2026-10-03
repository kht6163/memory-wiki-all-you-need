// Cancelling compose / backfill / review jobs (G-025): a queued job never runs,
// a running one stops before its next chunk and drops the answer of the call in
// flight; what earlier chunks did stays, and retry resumes after them.
process.env.GRAPH_BACKFILL_CHUNK_CHARS = "300";
process.env.REVIEW_CHUNK_CHARS = "900";
process.env.WIKI_COMPOSE_CHUNK_CHARS = "600";

import assert from "node:assert/strict";
import { test } from "node:test";

const { call, db, entry, llmCalls, llmDefault, llmReply, llmReset, ok, project, runQueueOnce, turn } = await import("./helpers.ts");
const { cancelGraphJob } = await import("../src/graph.ts");
const { cancelReviewJob, retryReviewJob } = await import("../src/review.ts");
const { cancelJob, retryJob } = await import("../src/wiki.ts");

type Any = any;
const idsInPrompt = (user: string): number[] => [...user.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]));
const graphJob = async (id: number) => (await ok<Any[]>("GET", "/graph/jobs")).find((j) => j.id === id);
const reviewJob = async (id: number) => (await ok<Any[]>("GET", "/review/jobs?limit=100")).find((j) => j.id === id);
const wikiJob = async (id: number) => (await ok<Any[]>("GET", "/wiki/jobs")).find((j) => j.id === id);
const body = "x".repeat(200);

test("G-025: a queued backfill that is cancelled never calls the LLM", async () => {
  llmReset();
  const p = await project("github.com/test/cancel-queued", "cancel-queued");
  await entry({ project_id: p.id, title: "cq A" });
  const job = await ok<Any>("POST", "/graph/backfill", { project_id: p.id });
  const c = await ok<Any>("POST", `/graph/jobs/${job.id}/cancel`);
  assert.equal(c.status, "cancelled");
  await runQueueOnce();
  assert.equal(llmCalls.length, 0);
  assert.equal((await graphJob(job.id)).status, "cancelled");
  assert.equal((await call("POST", `/graph/jobs/${job.id}/cancel`)).status, 409, "already cancelled");
  assert.equal((await call("POST", `/graph/jobs/999999/cancel`)).status, 404);
});

test("G-025: backfill cancelled during an LLM call writes nothing from that call; retry resumes", async () => {
  llmReset();
  const p = await project("github.com/test/cancel-bf", "cancel-bf");
  const a = await entry({ project_id: p.id, title: "cb A", body });
  const b = await entry({ project_id: p.id, title: "cb B", body });
  let jobId = 0;
  llmReply(
    (c: Any) => ({ memories: idsInPrompt(c.user).map((id) => ({ id, entities: ["Heron First"] })) }),
    (c: Any) => {
      cancelGraphJob(jobId);
      return { memories: idsInPrompt(c.user).map((id) => ({ id, entities: ["Heron Second"] })) };
    },
  );
  const job = await ok<Any>("POST", "/graph/backfill", { project_id: p.id });
  jobId = job.id;
  await runQueueOnce();
  assert.equal(llmCalls.length, 2);
  const j = await graphJob(job.id);
  assert.equal(j.status, "cancelled");
  assert.equal(j.result.chunks, 1, "first chunk's progress is kept");
  const names = async (id: number) => (await ok<Any>("GET", `/entries/${id}`)).entities.map((e: Any) => e.name);
  assert.deepEqual(await names(a.id), ["Heron First"]);
  assert.deepEqual(await names(b.id), [], "the answer that arrived after cancel is dropped");

  llmReply((c: Any) => {
    assert.deepEqual(idsInPrompt(c.user), [b.id], "retry resumes after the finished chunk");
    return { memories: [{ id: b.id, entities: ["Heron Third"] }] };
  });
  assert.equal((await call("POST", `/graph/jobs/${job.id}/retry`)).status, 200);
  await runQueueOnce();
  assert.equal((await graphJob(job.id)).status, "done");
  assert.deepEqual(await names(b.id), ["Heron Third"]);
});

test("G-025: retry while the cancelled job is still in its LLM call is refused", async () => {
  llmReset();
  const p = await project("github.com/test/cancel-stopping", "cancel-stopping");
  await entry({ project_id: p.id, title: "cs A" });
  let jobId = 0;
  let retryStatus = 0;
  llmReply(() => {
    cancelGraphJob(jobId);
    try {
      const { retryGraphJob } = graphMod;
      retryGraphJob(jobId);
      retryStatus = 200;
    } catch (err) {
      retryStatus = (err as Any).status;
    }
    return { memories: [] };
  });
  const job = await ok<Any>("POST", "/graph/backfill", { project_id: p.id });
  jobId = job.id;
  await runQueueOnce();
  assert.equal(retryStatus, 409);
  assert.equal((await graphJob(job.id)).status, "cancelled");
  // Once the worker let go, retry works.
  assert.equal((await call("POST", `/graph/jobs/${job.id}/retry`)).status, 200);
  llmReply({ memories: [] });
  await runQueueOnce();
  assert.equal((await graphJob(job.id)).status, "done");
});
const graphMod = await import("../src/graph.ts");

test("G-025: review cancelled mid-batch keeps earlier proposals, drops the in-flight batch", async () => {
  llmReset();
  const p = await project("github.com/test/cancel-review", "cancel-review");
  const ids: number[] = [];
  for (const n of ["rv1", "rv2", "rv3", "rv4"]) ids.push((await entry({ project_id: p.id, title: n, body })).id);
  let jobId = 0;
  llmReply(
    (c: Any) => {
      const [x, y] = idsInPrompt(c.user);
      return { proposals: [{ kind: "conflict", ids: [x, y], note: "first", reason: "r" }] };
    },
    (c: Any) => {
      cancelReviewJob(jobId);
      const [x, y] = idsInPrompt(c.user);
      return { proposals: [{ kind: "conflict", ids: [x, y], note: "second", reason: "r" }] };
    },
  );
  const job = await ok<Any>("POST", "/review", { project_id: p.id });
  jobId = job.id;
  await runQueueOnce();
  const j = await reviewJob(job.id);
  assert.equal(j.status, "cancelled");
  const props = await ok<Any[]>(`GET`, `/review/proposals?job_id=${job.id}`);
  assert.deepEqual(props.map((x) => x.data.note), ["first"]);
  // A new review of the scope may start; then the cancelled one cannot be retried next to it.
  const other = await ok<Any>("POST", "/review", { project_id: p.id });
  assert.throws(() => retryReviewJob(job.id), /already running/);
  cancelReviewJob(other.id);
  assert.equal(retryReviewJob(job.id).status, "pending");
  llmDefault({ proposals: [] });
  await runQueueOnce();
  assert.equal((await reviewJob(job.id)).status, "done");
  assert.equal((await reviewJob(other.id)).status, "cancelled");
});

test("G-025: compose cancelled during its second chunk keeps the first chunk's pages only", async () => {
  llmReset();
  const isCompose = (c: Any) => c.system.includes("You maintain a wiki");
  let jobId = 0;
  let n = 0;
  llmDefault((c: Any) => {
    if (!isCompose(c)) return { ops: [] };
    n++;
    if (n === 2) cancelJob(jobId);
    return { pages: [{ action: "create", slug: `cancel-page-${n}`, title: `Cancel page ${n}`, body: `chunk ${n}` }] };
  });
  const p = await project("github.com/test/cancel-wiki", "cancel-wiki");
  const t1 = await turn([{ role: "user", text: "a".repeat(500) }], p);
  const t2 = await turn([{ role: "user", text: "b".repeat(500) }], p);
  await runQueueOnce();
  const job = await ok<Any>("POST", "/wiki/compose", { project_id: p.id, turn_ids: [t1.id, t2.id] });
  jobId = job.id;
  await runQueueOnce();
  assert.equal(n, 2);
  const j = await wikiJob(job.id);
  assert.equal(j.status, "cancelled");
  const slugs = (await ok<Any[]>("GET", `/wiki/pages?project_id=${p.id}`)).map((x) => x.slug);
  assert.ok(slugs.includes("cancel-page-1"));
  assert.ok(!slugs.includes("cancel-page-2"), "page from the cancelled call is not written");
  const composed = db.prepare(`SELECT turn_id FROM wiki_composed WHERE job_id = ? ORDER BY turn_id`).all(job.id).map((r: Any) => Number(r.turn_id));
  assert.deepEqual(composed, [t1.id], "only the finished chunk counts as composed");
  // Retry resumes with the second turn only.
  retryJob(job.id);
  await runQueueOnce();
  assert.equal((await wikiJob(job.id)).status, "done");
  assert.equal(n, 3);
  assert.equal((await call("POST", `/wiki/jobs/${job.id}/cancel`)).status, 409, "a finished job cannot be cancelled");
});
