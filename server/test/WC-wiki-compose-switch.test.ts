// Turn-record compose can be switched off (ADR-0038). Off: no new or retried
// compose jobs, the worker leaves queued jobs waiting without spinning, and a
// running job goes back to the queue before its next chunk (G-067). Env wins
// over the web switch. Page writes by agents and people are not affected.
process.env.WIKI_COMPOSE_CHUNK_CHARS = "600";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";

const { call, db, llmCalls, llmDefault, llmReset, ok, project, runQueueOnce, turn } = await import("./helpers.ts");
const { config } = await import("../src/config.ts");
const settings = await import("../src/settings.ts");
const { claimDueJob, getJob, nextJobDueInMs, runningWikiJobs } = await import("../src/wiki.ts");
const { processWikiJob } = await import("../src/wiki-worker.ts");
const { describeError } = await import("../../web/src/errors.ts");

type Any = any;
const isCompose = (c: Any) => c.system.includes("You maintain a wiki");
const composeCalls = () => llmCalls.filter(isCompose).length;
const settingsFile = () => path.join(config.dataDir, "settings.json");
const setOn = (on: boolean) => ok<Any>("PUT", "/settings", { wikiCompose: on });

beforeEach(async () => {
  llmReset();
  config.wiki.composeEnv = undefined;
  settings.resetSettings();
  await setOn(true);
});

let seq = 0;
async function twoTurns() {
  seq++;
  const p = await project(`github.com/test/compose-switch-${seq}`, `compose-switch-${seq}`);
  llmDefault({ ops: [] }); // curation of the recorded turns
  const t1 = await turn([{ role: "user", text: "a".repeat(500) }], p);
  const t2 = await turn([{ role: "user", text: "b".repeat(500) }], p);
  await runQueueOnce();
  llmReset();
  return { p, ids: [t1.id, t2.id] };
}

test("ADR-0038: on by default; /settings, /health and /stats report it", async () => {
  fs.rmSync(settingsFile(), { force: true });
  settings.resetSettings();
  const s = await ok<Any>("GET", "/settings");
  assert.deepEqual(s.wikiCompose, { enabled: true, source: "default" });
  assert.equal((await ok<Any>("GET", "/health")).wikiCompose, true);
  assert.equal((await ok<Any>("GET", "/stats")).wikiCompose, true);
});

test("ADR-0038: switching off persists in settings.json and refuses compose and retry with 409", async () => {
  const { p, ids } = await twoTurns();
  const off = await setOn(false);
  assert.deepEqual(off.wikiCompose, { enabled: false, source: "file" });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(), "utf8")), { wikiCompose: false });
  settings.resetSettings(); // read back from the file, as after a restart
  assert.equal(settings.wikiComposeEnabled(), false);
  assert.equal((await ok<Any>("GET", "/stats")).wikiCompose, false);

  const r = await call("POST", "/wiki/compose", { project_id: p.id, turn_ids: ids });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "wiki compose is turned off");

  // A failed job cannot be retried while off.
  await setOn(true);
  llmDefault(new Error("llm down"));
  const job = await ok<Any>("POST", "/wiki/compose", { project_id: p.id, turn_ids: ids });
  await runQueueOnce();
  assert.equal(getJob(job.id)!.status, "error");
  await setOn(false);
  const rr = await call("POST", `/wiki/jobs/${job.id}/retry`);
  assert.equal(rr.status, 409);
  assert.equal(rr.data.error, "wiki compose is turned off");
});

test("G-067: a job queued before switching off waits — no claim, no due time (the worker does not spin), no LLM call — and runs once back on", async () => {
  const { p, ids } = await twoTurns();
  const job = await ok<Any>("POST", "/wiki/compose", { project_id: p.id, turn_ids: ids });
  await setOn(false);
  assert.equal(nextJobDueInMs(), null, "a due time of 0 would make startWorker loop without waiting");
  assert.equal(claimDueJob(), null);
  await runQueueOnce(); // returns: nothing claimable
  assert.equal(composeCalls(), 0);
  assert.equal(getJob(job.id)!.status, "pending");

  await setOn(true);
  assert.equal(nextJobDueInMs(), 0);
  llmDefault((c: Any) => (isCompose(c) ? { pages: [] } : { ops: [] }));
  await runQueueOnce();
  assert.equal(getJob(job.id)!.status, "done");
  assert.equal(composeCalls(), 2, "two chunks");
});

test("G-067: switched off between chunks, a running job goes back to the queue and resumes after the finished chunk", async () => {
  const { p, ids } = await twoTurns();
  let n = 0;
  llmDefault((c: Any) => {
    if (!isCompose(c)) return { ops: [] };
    n++;
    return { pages: [{ action: "create", slug: `switch-page-${n}`, title: `Switch page ${n}`, body: `chunk ${n}` }] };
  });
  const job = await ok<Any>("POST", "/wiki/compose", { project_id: p.id, turn_ids: ids });
  const claimed = claimDueJob()!;
  assert.equal(claimed.id, job.id);
  await processWikiJob(claimed, async () => {
    settings.setWikiCompose(false); // what the web switch does while chunk 1 is done
  });
  assert.equal(n, 1, "the second chunk is not sent");
  const paused = getJob(job.id)!;
  assert.equal(paused.status, "pending");
  assert.deepEqual((paused.result as Any).done, [ids[0]], "progress of the finished chunk is kept");
  assert.equal(runningWikiJobs.has(job.id), false);

  await setOn(true);
  await runQueueOnce();
  assert.equal(getJob(job.id)!.status, "done");
  assert.equal(n, 2, "only the remaining chunk ran");
  const composed = db.prepare(`SELECT turn_id FROM wiki_composed WHERE job_id = ? ORDER BY turn_id`).all(job.id).map((r: Any) => Number(r.turn_id));
  assert.deepEqual(composed, ids);
});

test("ADR-0038: WIKI_COMPOSE fixes the switch either way; PUT answers 409", async () => {
  const { p, ids } = await twoTurns();
  const job = await ok<Any>("POST", "/wiki/compose", { project_id: p.id, turn_ids: ids }); // waiting while env says off
  config.wiki.composeEnv = false;
  assert.deepEqual((await ok<Any>("GET", "/settings")).wikiCompose, { enabled: false, source: "env" });
  const r = await call("PUT", "/settings", { wikiCompose: true });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "this setting is fixed by WIKI_COMPOSE");
  assert.equal(claimDueJob(), null, "a pending job is not claimed");
  assert.equal(nextJobDueInMs(), null);
  assert.equal(getJob(job.id)!.status, "pending");

  // Env on wins over a file that says off.
  config.wiki.composeEnv = undefined;
  await setOn(false);
  config.wiki.composeEnv = true;
  assert.deepEqual((await ok<Any>("GET", "/settings")).wikiCompose, { enabled: true, source: "env" });
  assert.equal((await call("PUT", "/settings", { wikiCompose: false })).status, 409);
  llmDefault((c: Any) => (isCompose(c) ? { pages: [] } : { ops: [] }));
  await runQueueOnce();
  assert.equal(getJob(job.id)!.status, "done", "env on runs it although the file says off");
});

test("ADR-0038: PUT /settings validates its body", async () => {
  assert.equal((await call("PUT", "/settings", { wikiCompose: "off" })).data.error, "wikiCompose must be true or false");
  assert.equal((await call("PUT", "/settings", {})).data.error, "nothing to change");
  assert.equal((await call("PUT", "/settings", null)).status, 400);
  assert.equal((await call("PUT", "/settings", [])).status, 400);
});

test("ADR-0038: agent and person page writes still work while compose is off", async () => {
  await setOn(false);
  const p = await project("github.com/test/compose-off-writes", "compose-off-writes");
  const a = await call("POST", "/agent/wiki", { project: { key: p.key, name: p.name }, slug: "notes", body: "agent text" });
  assert.equal(a.status, 201);
  const h = await call("POST", "/wiki/pages", { project_id: p.id, title: "Person page", body: "hi" });
  assert.equal(h.status, 201);
});

test("G-048: the switch's messages are shown in Korean", () => {
  for (const m of ["wiki compose is turned off", "this setting is fixed by WIKI_COMPOSE", "nothing to change", "wikiCompose must be true or false"]) {
    const d = describeError(new Error(m));
    assert.equal(d.known, true, m);
    assert.match(d.text, /[가-힣]/);
  }
  assert.match(describeError(new Error("this setting is fixed by WIKI_COMPOSE")).text, /WIKI_COMPOSE/);
});

test("G-048: rules with a captured value put that value in the Korean text (not m[1] of a string)", () => {
  assert.equal(describeError(new Error("the tree would be too deep (max 8 levels)")).text, "페이지 트리가 너무 깊어집니다(최대 8단계)");
  assert.equal(describeError(new Error("too many moves (max 500)")).text, "한 번에 옮길 수 있는 페이지는 최대 500개입니다");
  assert.equal(describeError(new Error('parent page "adr-index" not found in this wiki')).text, '상위 페이지 "adr-index"를 이 위키에서 찾을 수 없습니다');
  assert.equal(describeError(new Error("this setting is fixed by WIKI_COMPOSE")).text, "서버 환경 변수 WIKI_COMPOSE로 정해져 있어 여기서 바꿀 수 없습니다");
});
