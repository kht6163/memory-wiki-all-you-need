// v0.6.1 re-measure follow-ups: an edit adds entities instead of replacing the list
// (it may drop only those the replaced passage alone named), split memories of one
// turn link to each other by "ref", and the curation prompt rules for identifiers,
// topic splits and keywords.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, entry, llmCalls, llmReply, llmReset, ok, project, runQueueOnce, turn } from "./helpers.ts";

type Any = any;
let seq = 0;
async function freshProject() {
  seq++;
  return project(`github.com/test/w2-${seq}`, `w2-${seq}`);
}
const getEntry = async (id: number) => (await ok<Any>("GET", `/entries/${id}`)).entry;
const entityNames = async (id: number) => ((await ok<Any>("GET", `/entries/${id}`)).entities as Any[]).map((n) => n.name).sort();
const getTurn = (id: number) => ok<Any>("GET", `/turns/${id}`);
const revisionCount = (id: number) => Number((db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE entry_id = ?`).get(id) as Any).n);
const outLinks = (id: number) =>
  (db.prepare(`SELECT to_id, type FROM entry_links WHERE from_id = ? ORDER BY to_id`).all(id) as Any[]).map((r) => [Number(r.to_id), r.type]);

beforeEach(() => llmReset());

async function runTurn(p: Any, ops: Any[], text = "please update the gateway, queue, db and cache settings as discussed") {
  llmReply({ ops });
  const t = await turn([{ role: "user", text }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  return done;
}

test("G-049: a one-line edit keeps entities it does not touch, adds the given ones", async () => {
  const p = await freshProject();
  const m = await entry({
    project_id: p.id,
    title: "gateway setup",
    body: "- proxy: envoy 1.29.1\n- cache: redis-sentinel\n- port: 80",
    entities: [{ name: "Envoy", kind: "tool" }, { name: "Redis Sentinel", kind: "tool" }],
  });
  const before = revisionCount(m.id);
  // The LLM lists only part of the old list plus a new entity (re-measure 34: Redis Sentinel lost).
  await runTurn(p, [{ op: "edit", id: m.id, old: "- port: 80", new: "- port: 8080 (TLS)", entities: [{ name: "Envoy", kind: "tool" }, { name: "TLS", kind: "concept" }] }]);
  assert.equal((await getEntry(m.id)).body, "- proxy: envoy 1.29.1\n- cache: redis-sentinel\n- port: 8080 (TLS)");
  assert.deepEqual(await entityNames(m.id), ["Envoy", "Redis Sentinel", "TLS"]);
  assert.equal(revisionCount(m.id) - before, 1);
});

test("G-049: an entity only the replaced passage named is dropped; one still in the body stays", async () => {
  const p = await freshProject();
  const m = await entry({
    project_id: p.id,
    title: "queue workers",
    body: "- broker: RabbitMQ\n- monitor: RabbitMQ management UI\n- scheduler: cron",
    entities: [{ name: "RabbitMQ", kind: "tech" }, { name: "cron", kind: "tool" }],
  });
  // RabbitMQ is in "old" but still on another line → kept; cron is gone from the body → dropped.
  await runTurn(p, [{ op: "edit", id: m.id, old: "- broker: RabbitMQ\n- monitor: RabbitMQ management UI\n- scheduler: cron", new: "- broker: RabbitMQ\n- monitor: RabbitMQ management UI\n- scheduler: systemd timer", entities: [{ name: "systemd", kind: "tool" }] }]);
  assert.deepEqual(await entityNames(m.id), ["RabbitMQ", "systemd"]);
  const m2 = await entry({ project_id: p.id, title: "queue workers two", body: "- broker: RabbitMQ\n- scheduler: cron", entities: [{ name: "RabbitMQ", kind: "tech" }, { name: "cron", kind: "tool" }] });
  await runTurn(p, [{ op: "edit", id: m2.id, old: "- scheduler: cron", new: "- scheduler: systemd timer", entities: [] }]);
  assert.deepEqual(await entityNames(m2.id), ["RabbitMQ"], "an empty list on an edit drops only what the edit removed");
});

test("G-049: a side update folded into an edit follows the same keep rule", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "db conn", body: "- db: PostgreSQL 16\n- pool: pgbouncer\n- timeout: 5s", entities: [{ name: "PostgreSQL", kind: "tech" }, { name: "PgBouncer", kind: "tool" }] });
  const before = revisionCount(m.id);
  const done = await runTurn(p, [
    { op: "edit", id: m.id, old: "- timeout: 5s", new: "- timeout: 30s" },
    { op: "update", id: m.id, entities: [{ name: "PostgreSQL", kind: "tech" }] },
  ]);
  assert.deepEqual(done.result.applied.map((a: Any) => a.op), ["update"]);
  assert.deepEqual(await entityNames(m.id), ["PgBouncer", "PostgreSQL"]);
  assert.equal(revisionCount(m.id) - before, 1);
});

test("G-049: a full update still replaces the entity list", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "cache", body: "- memcached", entities: [{ name: "memcached", kind: "tech" }, { name: "LRU", kind: "concept" }] });
  await runTurn(p, [{ op: "update", id: m.id, body: "- Redis with LRU", entities: [{ name: "Redis", kind: "tech" }] }]);
  assert.deepEqual(await entityNames(m.id), ["Redis"]);
});

test("G-050: a later op links to an earlier add of the same response by its ref", async () => {
  const p = await freshProject();
  const existing = await entry({ project_id: p.id, title: "ingress overview", body: "nginx ingress" });
  const done = await runTurn(p, [
    { op: "add", ref: "a", scope: "project", category: "decision", title: "use envoy for the gateway", body: "envoy 1.29.1", entities: [{ name: "Envoy", kind: "tool" }] },
    { op: "add", ref: "b", scope: "project", category: "fact", title: "gateway listens on 8443", body: "port 8443", entities: [{ name: "Envoy", kind: "tool" }], links: [{ to: "a", type: "related" }, { to: "zz", type: "related" }, { to: "b", type: "related" }] },
    { op: "add", ref: "c", scope: "project", category: "fact", title: "gateway tls certs in /etc/envoy/certs", body: "certs path", entities: [{ name: "/etc/envoy/certs", kind: "file" }], links: [{ to: "b", type: "related" }, { to: existing.id, type: "related" }] },
    { op: "link", from: "a", to: existing.id, type: "related" },
  ]);
  const [a, b, c] = done.result.applied.map((x: Any) => x.entryId);
  assert.deepEqual(outLinks(b), [[a, "related"]], "ref resolves; unknown or self ref dropped");
  assert.deepEqual(outLinks(c), [[existing.id, "related"], [b, "related"]].sort((x: Any, y: Any) => x[0] - y[0]));
  assert.deepEqual(outLinks(a), [[existing.id, "related"]], "link op accepts a ref as from");
});

test("G-050: a ref on a duplicate add points at the stored copy; numeric refs never shadow ids", async () => {
  const p = await freshProject();
  const stored = await entry({ project_id: p.id, title: "merge freeze rule", body: "no merges on friday" });
  const shown = await entry({ project_id: p.id, title: "release train", body: "weekly" });
  const done = await runTurn(p, [
    { op: "add", ref: "a", scope: "project", title: "merge freeze rule", body: "no merges on friday" },
    { op: "add", ref: String(shown.id), scope: "project", title: "freeze exceptions", body: "hotfix only" },
    { op: "add", scope: "project", title: "freeze owner", body: "release manager", links: [{ to: "a", type: "related" }, { to: String(shown.id), type: "related" }] },
  ], "merge freeze rule and release train");
  assert.deepEqual(done.result.skipped.map((s: Any) => [s.reason, s.entryId]), [["duplicate", stored.id]]);
  const owner = done.result.applied.at(-1).entryId;
  assert.deepEqual(outLinks(owner), [[stored.id, "related"], [shown.id, "related"]]);
});

test("turn-curation: the prompt carries the v0.6.1 re-measure rules (identifiers, edit entities, topic split, keywords)", async () => {
  const p = await freshProject();
  llmReply({ ops: [] });
  await turn([{ role: "user", text: "게이트웨이는 envoy 1.29.1, 머지 동결은 금요일" }], p);
  await runQueueOnce();
  const sys = llmCalls[0].system;
  assert.match(sys, /"envoy 1\.29\.1" stays "envoy 1\.29\.1"[^\n]*canonical spelling \("Envoy"\) belongs in the entities list only/);
  assert.match(sys, /On update, entities REPLACE[^\n]*On edit, entities ADD to the list/);
  assert.doesNotMatch(sys, /On update and edit, entities REPLACE/);
  assert.match(sys, /Topic split:[^\n]*link them "related"[^\n]*"ref"/);
  assert.match(sys, /\{"op":"add","ref":"a",/);
  assert.match(sys, /keywords \(0-8\):[^\n]*never repeat a title\/body word[^\n]*"머지 동결" ↔ "merge freeze"[^\n]*abbreviations[^\n]*REQUIRED whenever/);
});

test("G-049: at the 12-entity cap an edit never cuts an untouched entity (kept ones go first)", async () => {
  const p = await freshProject();
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliett", "Kilo", "Lima"];
  const m = await entry({
    project_id: p.id,
    title: "cap gateway",
    body: `- stack: ${names.join(", ")}\n- port: 80`,
    entities: names.map((name) => ({ name, kind: "tool" })),
  });
  assert.deepEqual(await entityNames(m.id), [...names].sort());
  await runTurn(p, [{ op: "edit", id: m.id, old: "- port: 80", new: "- port: 8080 TLS", entities: [{ name: "TLS", kind: "concept" }] }]);
  // No room for the addition: the existing twelve all stay (Lima used to be cut).
  assert.deepEqual(await entityNames(m.id), [...names].sort());
});

test("G-049: below the cap an edit's addition still lands next to all kept entities", async () => {
  const p = await freshProject();
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliett", "Kilo"];
  const m = await entry({ project_id: p.id, title: "cap gateway 11", body: `- stack: ${names.join(", ")}\n- port: 80`, entities: names.map((name) => ({ name, kind: "tool" })) });
  await runTurn(p, [{ op: "edit", id: m.id, old: "- port: 80", new: "- port: 8080 TLS", entities: [{ name: "TLS", kind: "concept" }] }]);
  assert.deepEqual(await entityNames(m.id), [...names, "TLS"].sort());
});

test("G-049: an edit without entities still drops what only the removed passage named", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "queue workers three", body: "- broker: RabbitMQ\n- scheduler: cron", entities: [{ name: "RabbitMQ", kind: "tech" }, { name: "cron", kind: "tool" }] });
  await runTurn(p, [{ op: "edit", id: m.id, old: "- scheduler: cron", new: "- scheduler: systemd timer" }]);
  assert.equal((await getEntry(m.id)).body, "- broker: RabbitMQ\n- scheduler: systemd timer");
  assert.deepEqual(await entityNames(m.id), ["RabbitMQ"]);
  // Nothing removed and no entities given → the list is left alone.
  await runTurn(p, [{ op: "edit", id: m.id, old: "- broker: RabbitMQ", new: "- broker: RabbitMQ 3.13" }]);
  assert.deepEqual(await entityNames(m.id), ["RabbitMQ"]);
});

test("turn-curation: the id rule and the link op both allow a ref of an earlier add", async () => {
  const p = await freshProject();
  llmReply({ ops: [] });
  await turn([{ role: "user", text: "ref prompt check" }], p);
  await runQueueOnce();
  const sys = llmCalls[0].system;
  assert.match(sys, /Only reference ids from the EXISTING MEMORIES list \(or a "ref" of an earlier add in this response\)/);
  assert.match(sys, /\{"op":"link"\} relates two existing memories \(or a "ref" of an earlier add in this response\)/);
  assert.match(sys, /On edit, entities ADD to the list \(omit to add none\)[^\n]*dropped even without "entities"/);
});

test("G-049: an entity the title still names stays after an edit removes it from the body (same rule as review, G-046)", async () => {
  const p = await freshProject();
  const m = await entry({
    project_id: p.id,
    title: "Nginx front proxy",
    body: "- proxy: Nginx\n- port: 80",
    entities: [{ name: "Nginx", kind: "tool" }],
  });
  await runTurn(p, [{ op: "edit", id: m.id, old: "- proxy: Nginx", new: "- proxy: front tier" }]);
  assert.equal((await getEntry(m.id)).body, "- proxy: front tier\n- port: 80");
  assert.deepEqual(await entityNames(m.id), ["Nginx"], "the title still names it");
});
