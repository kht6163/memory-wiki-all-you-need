// v0.6.2 re-measure follow-ups: a full update keeps entities it does not touch (G-049 rule
// on update too, with an explicit drop_entities), a malformed curation reply is read past
// trailing garbage or retried once, and the prompt rules for keywords and topic-split links.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { parseLooseJson, LlmJsonError } from "../src/llm.ts";
import { db, entry, llmCalls, llmReply, llmReset, ok, project, runQueueOnce, turn } from "./helpers.ts";

type Any = any;
let seq = 0;
async function freshProject() {
  seq++;
  return project(`github.com/test/w3-${seq}`, `w3-${seq}`);
}
const getEntry = async (id: number) => (await ok<Any>("GET", `/entries/${id}`)).entry;
const entityNames = async (id: number) => ((await ok<Any>("GET", `/entries/${id}`)).entities as Any[]).map((n) => n.name).sort();
const getTurn = (id: number) => ok<Any>("GET", `/turns/${id}`);
const revisionCount = (id: number) => Number((db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE entry_id = ?`).get(id) as Any).n);
const maxEntryId = () => Number((db.prepare(`SELECT IFNULL(MAX(id), 0) AS n FROM entries`).get() as Any).n);

beforeEach(() => llmReset());

async function runTurn(p: Any, ops: Any[], text = "please update the gateway, queue, db and cache settings as discussed") {
  llmReply({ ops });
  const t = await turn([{ role: "user", text }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  return done;
}

test("G-049: a full-body update keeps unrelated entities (re-measure 34: lost on update)", async () => {
  const p = await freshProject();
  const m = await entry({
    project_id: p.id,
    title: "gateway setup",
    body: "- proxy: envoy 1.29.1\n- cache: redis-sentinel\n- port: 80",
    entities: [{ name: "Envoy", kind: "tool" }, { name: "Redis Sentinel", kind: "tool" }, { name: "Prometheus", kind: "tool" }],
  });
  const before = revisionCount(m.id);
  await runTurn(p, [{ op: "update", id: m.id, body: "- proxy: envoy 1.29.1\n- cache: redis-sentinel\n- port: 8080 (TLS)", entities: [{ name: "Envoy", kind: "tool" }, { name: "TLS", kind: "concept" }] }]);
  assert.equal((await getEntry(m.id)).body, "- proxy: envoy 1.29.1\n- cache: redis-sentinel\n- port: 8080 (TLS)");
  assert.deepEqual(await entityNames(m.id), ["Envoy", "Prometheus", "Redis Sentinel", "TLS"]);
  assert.equal(revisionCount(m.id) - before, 1);
});

test("G-049: an update drops an entity the old title/body named and the new text no longer names", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "scheduler uses cron", body: "- scheduler: cron\n- db: PostgreSQL", entities: [{ name: "cron", kind: "tool" }, { name: "PostgreSQL", kind: "tech" }] });
  // No "entities" on the op: the drop still happens, nothing is added.
  await runTurn(p, [{ op: "update", id: m.id, title: "scheduler uses systemd timers", body: "- scheduler: systemd timer\n- db: PostgreSQL" }]);
  assert.deepEqual(await entityNames(m.id), ["PostgreSQL"]);
});

test("G-049: an entities-only update adds to a non-empty list", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "metrics", body: "scraped every 15s", entities: [{ name: "Prometheus", kind: "tool" }] });
  await runTurn(p, [{ op: "update", id: m.id, entities: [{ name: "Grafana", kind: "tool" }] }]);
  assert.deepEqual(await entityNames(m.id), ["Grafana", "Prometheus"]);
  assert.equal((await getEntry(m.id)).body, "scraped every 15s");
});

test("G-049: drop_entities removes listed current entities on purpose, ignores unknown names", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "ci runners", body: "runners on GitHub Actions", entities: [{ name: "GitHub Actions", kind: "tool" }, { name: "Jenkins", kind: "tool" }] });
  await runTurn(p, [{ op: "update", id: m.id, entities: [{ name: "Docker", kind: "tool" }], drop_entities: ["jenkins", "NotThere"] }], "we removed Jenkins and moved the runners to Docker");
  assert.deepEqual(await entityNames(m.id), ["Docker", "GitHub Actions"]);
});

test("G-047: a drop_entities-only update next to an edit folds into the edit (one revision)", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "ci config", body: "- runner: jenkins\n- timeout: 10m", entities: [{ name: "Jenkins", kind: "tool" }, { name: "Bazel", kind: "tool" }] });
  const before = revisionCount(m.id);
  const done = await runTurn(p, [
    { op: "edit", id: m.id, old: "- timeout: 10m", new: "- timeout: 20m" },
    { op: "update", id: m.id, drop_entities: ["Bazel"] },
  ], "raise the timeout to 20m; Bazel is gone from the build");
  assert.deepEqual(done.result.applied.map((a: Any) => a.op), ["update"]);
  assert.deepEqual(await entityNames(m.id), ["Jenkins"]);
  assert.equal(revisionCount(m.id) - before, 1);
});

test("G-047: drop_entities directly on an edit op drops the entity in the same revision", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "build config", body: "- runner: jenkins\n- timeout: 10m", entities: [{ name: "Jenkins", kind: "tool" }, { name: "Bazel", kind: "tool" }] });
  const before = revisionCount(m.id);
  const done = await runTurn(p, [{ op: "edit", id: m.id, old: "- timeout: 10m", new: "- timeout: 20m", drop_entities: ["Bazel"] }], "timeout 20m please, and we dropped Bazel");
  assert.deepEqual(done.result.applied.map((a: Any) => a.op), ["update"]);
  assert.equal((await getEntry(m.id)).body, "- runner: jenkins\n- timeout: 20m");
  assert.deepEqual(await entityNames(m.id), ["Jenkins"]);
  assert.equal(revisionCount(m.id) - before, 1);
});

test("G-049: at the 12-entity cap a full update keeps every untouched entity and cuts only additions", async () => {
  const p = await freshProject();
  const twelve = Array.from({ length: 12 }, (_, i) => ({ name: `Svc${String.fromCharCode(65 + i)}`, kind: "service" }));
  const m = await entry({ project_id: p.id, title: "service map", body: "twelve services behind the gateway", entities: twelve });
  assert.equal((await entityNames(m.id)).length, 12);
  await runTurn(p, [{ op: "update", id: m.id, body: "twelve services behind the gateway (all on TLS)", entities: [{ name: "TLS", kind: "concept" }, { name: "Vault", kind: "tool" }] }]);
  assert.equal((await getEntry(m.id)).body, "twelve services behind the gateway (all on TLS)");
  assert.deepEqual(await entityNames(m.id), twelve.map((n) => n.name).sort());
});

test("G-053: parseLooseJson takes the first complete object and ignores trailing garbage", () => {
  assert.deepEqual(parseLooseJson('{"ops":[{"op":"confirm","id":1}],"note":"x"}]}'), { ops: [{ op: "confirm", id: 1 }], note: "x" });
  assert.deepEqual(parseLooseJson('Here you go: {"ops":[],"note":"a } inside \\" a string {"} trailing prose }'), { ops: [], note: 'a } inside " a string {' });
  assert.deepEqual(parseLooseJson('note {not json} then {"ops":[]}'), { ops: [] });
  assert.deepEqual(parseLooseJson('```json\n{"ops":[]}]}\n```'), { ops: [] });
  // A broken object is never read as its nested op.
  assert.throws(() => parseLooseJson('{"ops":[{"op":"add","title":"x"}, oops]}'), LlmJsonError);
  // A stray "}" closes the reply early: the op after it is not the reply.
  assert.throws(() => parseLooseJson('{"ops":[{"op":"delete","id":1}}, {"op":"add","title":"x","body":"y"}]}'), LlmJsonError);
  assert.throws(() => parseLooseJson('{\n  "ops":[{"op":"delete","id":1}}, {"op":"add","title":"x"}]}'), LlmJsonError);
  assert.throws(() => parseLooseJson('{"ops":[{"op":"add","title":"x"}'), LlmJsonError, "truncated still fails");
  assert.throws(() => parseLooseJson("I am not JSON at all"), LlmJsonError);
});

test("G-053: a reply with an extra ]} after the object is applied with one call", async () => {
  const p = await freshProject();
  llmReply('{"ops":[{"op":"add","scope":"project","category":"fact","title":"grafana listens on 3000","body":"port 3000","entities":[{"name":"Grafana","kind":"tool"}]}],"note":"n"}]}');
  const t = await turn([{ role: "user", text: "remember grafana listens on port 3000" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.equal(done.result.applied.length, 1);
  assert.equal(llmCalls.length, 1);
});

test("G-053: an unreadable curation reply is retried once, then applied", async () => {
  const p = await freshProject();
  llmReply("Sorry, here are the ops: [oops", { ops: [{ op: "add", scope: "project", category: "fact", title: "loki retention 14 days", body: "14d", entities: [{ name: "Loki", kind: "tool" }] }] });
  const t = await turn([{ role: "user", text: "loki keeps logs for 14 days" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.equal(done.result.applied.length, 1);
  assert.equal(llmCalls.length, 2);
  assert.equal(llmCalls[1].system, llmCalls[0].system);
  assert.match(String((llmCalls[1].body.messages as Any[]).at(-1).content), /not valid JSON/);
});

test("G-053: a reply broken by a stray } is retried, not applied as its nested op", async () => {
  const p = await freshProject();
  const before = maxEntryId();
  llmReply(
    '{"ops":[{"op":"confirm","id":1}}, {"op":"add","scope":"project","category":"fact","title":"stray op","body":"y"}]}',
    { ops: [{ op: "add", scope: "project", category: "fact", title: "jaeger ui on 16686", body: "port 16686", entities: [{ name: "Jaeger", kind: "tool" }] }] },
  );
  const t = await turn([{ role: "user", text: "remember the jaeger ui is on port 16686" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.equal(llmCalls.length, 2);
  assert.deepEqual(done.result.applied.map((a: Any) => a.title), ["jaeger ui on 16686"]);
  assert.equal(maxEntryId(), before + 1);
});

test("G-053: two unreadable replies fail the turn after exactly one retry; HTTP errors are not retried", async () => {
  const p = await freshProject();
  const before = maxEntryId();
  llmReply("not json", "still not json", { ops: [] });
  const t = await turn([{ role: "user", text: "remember the port for tempo is 3200" }], p);
  await runQueueOnce();
  assert.equal((await getTurn(t.id)).status, "error");
  assert.equal(llmCalls.length, 2);
  assert.equal(maxEntryId(), before);

  llmReset();
  llmReply(new Error("boom"), { ops: [] });
  const t2 = await turn([{ role: "user", text: "remember the port for mimir is 9009" }], p);
  await runQueueOnce();
  assert.equal((await getTurn(t2.id)).status, "error");
  assert.equal(llmCalls.length, 1);
});

test("turn-curation: the prompt asks for translation keywords and links split memories only within one change or system", async () => {
  const p = await freshProject();
  llmReply({ ops: [] });
  await turn([{ role: "user", text: "머지 동결은 금요일, 게이트웨이는 envoy" }], p);
  await runQueueOnce();
  const sys = llmCalls[0].system;
  assert.match(sys, /keywords \(0-8\):[^\n]*always include the common English\/Korean counterpart of the key concept[^\n]*"머지 동결" ↔ "merge freeze"/);
  assert.match(sys, /Topic split:[^\n]*parts of the same change or the same system[^\n]*never merely because they came from the same turn or project/);
  assert.match(sys, /\{"op":"update","id":123,[^\n]*"drop_entities":\["\.\.\."\]/);
  assert.match(sys, /\{"op":"edit","id":123,[^\n]*"drop_entities":\["\.\.\."\]/);
  assert.match(sys, /put "entities"\/"drop_entities"\/"links"\/"valid_until" on the same edit op/);
});

test("G-049: drop_entities is ignored for an entity the turn never mentions (re-measure: the LLM tidied unrelated ones)", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "log paths", body: "- app: /var/log/app.log\n- error: /var/log/err.log", entities: [{ name: "Docker Compose", kind: "tool" }, { name: "/var/log/", kind: "file" }] });
  await runTurn(p, [{ op: "edit", id: m.id, old: "- error: /var/log/err.log", new: "- error: /var/log/app-error.log", drop_entities: ["Docker Compose"] }], "rename the error log to app-error.log");
  assert.deepEqual(await entityNames(m.id), ["/var/log/", "Docker Compose"], "the turn never named Docker Compose");
  await runTurn(p, [{ op: "update", id: m.id, drop_entities: ["Docker Compose"] }], "we stopped using docker-compose for this service");
  assert.deepEqual(await entityNames(m.id), ["/var/log/"], "named (as docker-compose) → dropped");
});
