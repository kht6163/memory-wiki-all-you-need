// valid_until fallback (re-measure 23): the LLM wrote "2026-10-07까지 머지하지 않는다" in the
// body but left valid_until empty about one turn in three. Turn curation now takes the date
// from a single absolute deadline in the body; explicit values, human/agent writes, past or
// ambiguous dates and condition-only deadlines are left alone. Plus the "related" prompt nudge.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, entry, llmCalls, llmReply, llmReset, ok, project, runQueueOnce, turn } from "./helpers.ts";
import { deadlineFromBody, localDate } from "../src/worker.ts";

type Any = any;
let seq = 0;
const proj = () => project(`github.com/test/w4-until-${++seq}`, `w4-until-${seq}`);
// Dates in the server's TIMEZONE (the turn date is local), so the tests hold under any TIMEZONE env.
const day = (offset: number) => localDate(new Date(Date.now() + offset * 86_400_000).toISOString());
const prevDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const revisionCount = (id: number) => Number((db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE entry_id = ?`).get(id) as Any).n);
const getEntry = async (id: number) => (await ok<Any>("GET", `/entries/${id}`)).entry;

beforeEach(() => llmReset());

/** Run one curated turn with the given ops; returns the turn result. */
async function curate(p: { key: string; name: string }, ops: Any[], createdAt?: string) {
  llmReply({ ops });
  const t = await turn([{ role: "user", text: "merge freeze and deploy notes for this week, please remember" }, { role: "assistant", text: "ok" }], p);
  if (createdAt) db.prepare("UPDATE turns SET created_at = ? WHERE id = ?").run(createdAt, t.id);
  await runQueueOnce();
  return (await ok<Any>("GET", `/turns/${t.id}`)).result;
}

test("G-054: a Korean 'YYYY-MM-DD까지' deadline in an add's body sets valid_until and is reported", async () => {
  const p = await proj();
  const d = day(4);
  const r = await curate(p, [
    { op: "add", scope: "project", title: "머지 동결", body: `${d}까지 main에 머지하지 않는다` },
    { op: "add", scope: "project", title: "릴리스 창", body: `릴리스는 ${d} 까지 연기` },
  ]);
  assert.equal(r.applied.length, 2);
  for (const a of r.applied) assert.equal((await getEntry(a.entryId)).valid_until, d);
  assert.deepEqual(
    r.inferred.map((x: Any) => [x.op, x.entryId, x.valid_until, x.from]),
    r.applied.map((a: Any) => ["add", a.entryId, d, "body"]),
  );
});

test("G-054: English until/through/till deadlines work for add, update and edit", async () => {
  const p = await proj();
  const d = day(6);
  const u = await entry({ project_id: p.id, title: "staging proxy workaround", body: "route staging through the old proxy" });
  const e = await entry({ project_id: p.id, title: "CI on self-hosted runner", body: "jobs run on the arm runner." });
  const r = await curate(p, [
    { op: "add", scope: "project", title: "feature flag on", body: `keep NEW_UI enabled till ${d}` },
    { op: "update", id: u.id, body: `route staging through the old proxy until ${d} (upstream fix pending)` },
    { op: "edit", id: e.id, old: "arm runner.", new: `arm runner through ${d}.` },
  ]);
  assert.equal(r.applied.length, 3);
  for (const a of r.applied) assert.equal((await getEntry(a.entryId)).valid_until, d, a.title);
  assert.deepEqual(r.inferred.map((x: Any) => x.op), ["add", "update", "edit"]);
});

test("G-054: a deadline before the TURN DATE is ignored, one on or after it applies", async () => {
  const p = await proj();
  // Turn recorded on 2026-03-04T10Z; its date is taken in the server's TIMEZONE. Curated later.
  const createdAt = "2026-03-04T10:00:00.000Z";
  const turnDay = localDate(createdAt);
  const r = await curate(
    p,
    [
      { op: "add", scope: "project", title: "old freeze", body: `${prevDay(turnDay)}까지 머지 금지` },
      { op: "add", scope: "project", title: "same-day freeze", body: `${turnDay}까지 머지 금지` },
    ],
    createdAt,
  );
  const [a, b] = await Promise.all(r.applied.map((x: Any) => getEntry(x.entryId)));
  assert.equal(a.valid_until, null, "past deadline is history, not a validity window");
  assert.equal(b.valid_until, turnDay);
  assert.deepEqual(r.inferred.map((x: Any) => x.entryId), [b.id]);
});

test("G-054: two different deadline dates, invalid dates and condition-only deadlines are left alone", async () => {
  const p = await proj();
  const r = await curate(p, [
    { op: "add", scope: "project", title: "two deadlines", body: `QA는 ${day(3)}까지, 배포 동결은 until ${day(9)}` },
    { op: "add", scope: "project", title: "condition only", body: "리허설 끝날 때까지 머지하지 않는다" },
    { op: "add", scope: "project", title: "bad date", body: "2099-02-30까지 유지" },
    { op: "add", scope: "project", title: "date without deadline", body: `${day(5)}에 배포 예정` },
    { op: "add", scope: "project", title: "repeated same deadline", body: `${day(7)}까지 동결. 동결은 ${day(7)} 까지.` },
  ]);
  const got = await Promise.all(r.applied.map((x: Any) => getEntry(x.entryId)));
  assert.deepEqual(
    got.map((e: Any) => e.valid_until),
    [null, null, null, null, day(7)],
  );
  assert.deepEqual(r.inferred.map((x: Any) => x.title), ["repeated same deadline"]);
});

test("G-054: an explicit valid_until (op or memory) is never overridden", async () => {
  const p = await proj();
  const has = await entry({ project_id: p.id, title: "freeze window", body: "no merges", valid_until: day(20) } as Any);
  const r = await curate(p, [
    { op: "add", scope: "project", title: "explicit wins", body: `${day(4)}까지 동결`, valid_until: day(10) },
    { op: "update", id: has.id, body: `no merges until ${day(4)}` },
    { op: "add", scope: "project", title: "no turn noise", body: "lasting fact" },
  ]);
  const ids = r.applied.map((x: Any) => x.entryId);
  assert.equal((await getEntry(ids[0])).valid_until, day(10));
  assert.equal((await getEntry(has.id)).valid_until, day(20), "the memory's own date stays");
  assert.equal(r.inferred, undefined, "nothing inferred → no field");
});

test("G-054: an edit never overrides the memory's own valid_until with a body date", async () => {
  const p = await proj();
  const has = await entry({ project_id: p.id, title: "deploy freeze", body: "no deploys on weekdays", valid_until: day(20) } as Any);
  const r = await curate(p, [{ op: "edit", id: has.id, old: "on weekdays", new: `on weekdays until ${day(4)}` }]);
  assert.equal(r.applied.length, 1);
  const e = await getEntry(has.id);
  assert.equal(e.body, `no deploys on weekdays until ${day(4)}`);
  assert.equal(e.valid_until, day(20), "the memory's own date stays");
  assert.equal(r.inferred, undefined);
});

test("G-054: an edit with a held update that names valid_until takes that value, in one revision", async () => {
  const p = await proj();
  const m = await entry({ project_id: p.id, title: "release branch", body: "cut from main" });
  const before = revisionCount(m.id);
  const r = await curate(p, [
    { op: "edit", id: m.id, old: "cut from main", new: `cut from main until ${day(4)}` },
    { op: "update", id: m.id, valid_until: day(12) },
  ]);
  assert.deepEqual(r.applied.map((a: Any) => [a.op, a.entryId]), [["update", m.id]]);
  assert.equal((await getEntry(m.id)).valid_until, day(12), "the explicit value wins over the body date");
  assert.equal(r.inferred, undefined);
  assert.equal(revisionCount(m.id) - before, 1);
});

test("G-054: when the held update is refused, the edit retried alone still does not infer a date", async () => {
  const p = await proj();
  const m = await entry({ project_id: p.id, title: "hotfix branch", body: "merge to main" });
  // The held update names valid_until but carries a secret-looking entity, so the joint write is
  // refused, the edit is retried alone and the update is refused again on its own.
  const r = await curate(p, [
    { op: "edit", id: m.id, old: "merge to main", new: `merge to main until ${day(4)}` },
    { op: "update", id: m.id, valid_until: day(12), entities: [{ name: "sk-" + "q".repeat(30), kind: "tool" }] },
  ]);
  const e = await getEntry(m.id);
  assert.equal(e.body, `merge to main until ${day(4)}`, "the edit still applies");
  assert.notEqual(e.valid_until, day(4), "the body date must not stand in for the LLM's explicit value");
  assert.equal(r.inferred, undefined);
});

test("G-054: human/agent writes and update ops without a body are not touched", async () => {
  const p = await proj();
  const human = await entry({ project_id: p.id, title: "human freeze", body: `${day(4)}까지 머지 금지` });
  assert.equal(human.valid_until ?? null, null);
  const agent = await ok<Any>("POST", "/entries", { scope: "project", project_id: p.id, title: "agent freeze", body: `until ${day(4)}`, author: "agent" });
  assert.equal((await getEntry(agent.id)).valid_until, null);
  // An entities-only update of a memory whose body already names a deadline does not read the body.
  const r = await curate(p, [{ op: "update", id: human.id, entities: [{ name: "main", kind: "tech" }] }]);
  assert.equal(r.applied.length, 1);
  assert.equal((await getEntry(human.id)).valid_until, null);
});

test("deadlineFromBody: phrase forms and boundaries", () => {
  assert.equal(deadlineFromBody("2026-10-07까지 머지하지 않는다", "2026-10-03"), "2026-10-07");
  assert.equal(deadlineFromBody("Until 2026-10-07 no merges", "2026-10-03"), "2026-10-07");
  assert.equal(deadlineFromBody("2026-10-01부터 2026-10-07까지", "2026-10-03"), "2026-10-07", "a start date is not a deadline");
  assert.equal(deadlineFromBody("v2026-10-07까지", "2026-10-03"), "2026-10-07");
  assert.equal(deadlineFromBody("12026-10-07까지", "2026-10-03"), undefined);
  assert.equal(deadlineFromBody("untilled 2026-10-07", "2026-10-03"), undefined);
  assert.equal(deadlineFromBody("2026-10-02까지", "2026-10-03"), undefined);
});

test("turn-curation: the prompt says a shared turn, project or deploy target is not enough for related", async () => {
  const p = await proj();
  llmReply({ ops: [] });
  await turn([{ role: "user", text: "DB 풀 크기는 20, CI 인증은 OIDC로 바꿨다" }], p);
  await runQueueOnce();
  const sys = llmCalls[0].system;
  assert.match(sys, /Topic split:[^\n]*never merely because they came from the same turn or project; sharing a deploy target is not enough either[^\n]*DB pool settings and CI auth are different systems/);
});
