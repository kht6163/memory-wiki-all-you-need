// Curation "edit" op carrying entities/links (one revision per memory per turn),
// folding an entities/links-only update into an edit of the same memory, and the
// v0.6.1 curation prompt rules measured against the real LLM (e2e 21~34).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { applyMemoryOps } from "../src/worker.ts";
import { db, entry, llmCalls, llmReply, llmReset, ok, project, runQueueOnce, turn } from "./helpers.ts";

type Any = any;
let seq = 0;
async function freshProject() {
  seq++;
  return project(`github.com/test/w-edit-${seq}`, `w-edit-${seq}`);
}
const getEntry = async (id: number) => (await ok<Any>("GET", `/entries/${id}`)).entry;
const entityNames = async (id: number) => ((await ok<Any>("GET", `/entries/${id}`)).entities as Any[]).map((n) => n.name).sort();
const getTurn = (id: number) => ok<Any>("GET", `/turns/${id}`);
const revisionCount = (id: number) => Number((db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE entry_id = ?`).get(id) as Any).n);
const outLinks = (id: number) =>
  (db.prepare(`SELECT to_id, type FROM entry_links WHERE from_id = ? ORDER BY to_id`).all(id) as Any[]).map((r) => [Number(r.to_id), r.type]);

beforeEach(() => llmReset());

test("G-047: an edit with entities and links writes body + entities in one revision, then the links", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "cache settings", body: "- backend: memcached\n- ttl: 60s", entities: [{ name: "memcached", kind: "tech" }] });
  const other = await entry({ project_id: p.id, title: "cache failover", body: "uses redis-sentinel" });
  const before = revisionCount(m.id);
  llmReply({
    ops: [
      {
        op: "edit", id: m.id, old: "- backend: memcached", new: "- backend: Redis",
        entities: [{ name: "Redis", kind: "tech" }], links: [{ to: other.id, type: "related" }], reason: "switched",
      },
    ],
  });
  const t = await turn([{ role: "user", text: "cache settings: the backend is Redis now, see cache failover" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.applied.map((a: Any) => [a.op, a.entryId]), [["update", m.id]]);
  assert.equal((await getEntry(m.id)).body, "- backend: Redis\n- ttl: 60s");
  assert.deepEqual(await entityNames(m.id), ["Redis"]);
  assert.equal(revisionCount(m.id) - before, 1, "one revision for body + entities");
  assert.deepEqual(outLinks(m.id), [[other.id, "related"]]);
});

test("G-047: a skipped edit (not found / not unique) applies none of its entities or links", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "lint rules", body: "rule A on\nrule B on", entities: [{ name: "ESLint", kind: "tool" }] });
  const other = await entry({ project_id: p.id, title: "lint ci job", body: "runs on push" });
  const before = revisionCount(m.id);
  llmReply({
    ops: [
      { op: "edit", id: m.id, old: "rule C on", new: "x", entities: [{ name: "Biome", kind: "tool" }], links: [{ to: other.id, type: "related" }] },
      { op: "edit", id: m.id, old: " on", new: " off", entities: [{ name: "Prettier", kind: "tool" }], links: [{ to: other.id, type: "because" }] },
    ],
  });
  const t = await turn([{ role: "user", text: "lint rules and the lint ci job" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.applied, []);
  assert.deepEqual(done.result.skipped.map((s: Any) => s.reason), ["edit_not_found", "edit_not_unique"]);
  assert.equal((await getEntry(m.id)).body, "rule A on\nrule B on");
  assert.deepEqual(await entityNames(m.id), ["ESLint"]);
  assert.deepEqual(outLinks(m.id), []);
  assert.equal(revisionCount(m.id), before, "no revision");
});

test("G-047: an entities-only update next to an edit of the same memory is folded into one revision", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "db settings", body: "- engine: MySQL 8\n- pool: 10", entities: [{ name: "MySQL", kind: "tech" }] });
  const other = await entry({ project_id: p.id, title: "db migration plan", body: "move off mysql" });
  const before = revisionCount(m.id);
  llmReply({
    ops: [
      // The update comes first: folding must not depend on order.
      { op: "update", id: m.id, entities: [{ name: "PostgreSQL", kind: "tech" }], links: [{ to: other.id, type: "because" }] },
      { op: "edit", id: m.id, old: "- engine: MySQL 8", new: "- engine: PostgreSQL 16", reason: "migrated" },
    ],
  });
  const t = await turn([{ role: "user", text: "db settings: we moved to postgres, see db migration plan" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.applied.map((a: Any) => [a.op, a.entryId]), [["update", m.id]], "one applied change, not two");
  assert.equal((await getEntry(m.id)).body, "- engine: PostgreSQL 16\n- pool: 10");
  assert.deepEqual(await entityNames(m.id), ["PostgreSQL"]);
  assert.equal(revisionCount(m.id) - before, 1, "one revision per memory per turn");
  assert.deepEqual(outLinks(m.id), [[other.id, "because"]]);
});

test("G-047: when the edit is skipped, the folded entities-only update still applies on its own", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "queue settings", body: "- broker: rabbitmq" });
  const before = revisionCount(m.id);
  llmReply({
    ops: [
      { op: "edit", id: m.id, old: "- broker: kafka", new: "x", entities: [{ name: "Kafka", kind: "tech" }] },
      { op: "update", id: m.id, entities: [{ name: "RabbitMQ", kind: "tech" }] },
    ],
  });
  const t = await turn([{ role: "user", text: "queue settings use rabbitmq" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.skipped.map((s: Any) => s.reason), ["edit_not_found"]);
  assert.equal((await getEntry(m.id)).body, "- broker: rabbitmq");
  assert.deepEqual(await entityNames(m.id), ["RabbitMQ"], "the update's entities, never the skipped edit's");
  assert.equal(revisionCount(m.id) - before, 1);
});

test("G-047: an update that also changes title/body is not folded (it stays its own op)", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "build cmd", body: "npm run build" });
  const before = revisionCount(m.id);
  llmReply({
    ops: [
      { op: "edit", id: m.id, old: "npm run build", new: "pnpm build" },
      { op: "update", id: m.id, title: "build command", entities: [{ name: "pnpm", kind: "tool" }] },
    ],
  });
  const t = await turn([{ role: "user", text: "build cmd is pnpm build now" }], p);
  await runQueueOnce();
  assert.equal((await getTurn(t.id)).status, "done");
  const e = await getEntry(m.id);
  assert.equal(e.title, "build command");
  assert.equal(e.body, "pnpm build");
  assert.deepEqual(await entityNames(m.id), ["pnpm"]);
  assert.equal(revisionCount(m.id) - before, 2, "a real second change keeps its own revision");
});

test("turn-curation: the curation prompt carries the v0.6.1 rules", async () => {
  const p = await freshProject();
  llmReply({ ops: [] });
  await turn([{ role: "user", text: "이 프로젝트 DB는 포스트그레스 쓰기로 했어" }], p);
  await runQueueOnce();
  assert.equal(llmCalls.length, 1);
  const sys = llmCalls[0].system;
  assert.match(sys, /keywords \(0-8\):[^\n]*REQUIRED whenever/, "keywords conditionally required");
  assert.match(sys, /the body MUST keep that resolved date/, "event dates kept");
  assert.match(sys, /valid_until \(YYYY-MM-DD\): for facts that are true only until a known date[^\n]*deadline/, "deadlines go to valid_until");
  assert.match(sys, /"redis-sentinel" stays "redis-sentinel"/, "identifiers copied as written");
  assert.match(sys, /merge only facts about the SAME subject whose title still fits/, "no grab-bag memories");
  assert.match(sys, /one-off work that merely applies an existing memory[^\n]*confirm of the rule/, "applying a rule is a confirm, not a new convention");
  assert.match(sys, /\{"op":"edit","id":123,[^\n]*"entities":\[[^\n]*"links":\[/, "edit op carries entities/links in the output format");
});

const turnKinds = (entryId: number, turnId: number) =>
  (db.prepare(`SELECT kind FROM entry_turns WHERE entry_id = ? AND turn_id = ? ORDER BY kind`).all(entryId, turnId) as Any[]).map((r) => r.kind);

test("G-047: a confirm after a held update of the same memory is skipped (G-032 order kept)", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "deploy target", body: "- host: blue\n- port: 80" });
  llmReply({
    ops: [
      { op: "update", id: m.id, entities: [{ name: "nginx", kind: "tool" }] },
      { op: "confirm", id: m.id },
      { op: "edit", id: m.id, old: "- port: 80", new: "- port: 8080" },
    ],
  });
  const t = await turn([{ role: "user", text: "deploy target port is 8080" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.applied.map((a: Any) => a.op), ["update"], "no confirm next to the change");
  assert.deepEqual(turnKinds(m.id, t.id), ["update"]);
});

test("G-047: a confirm before the held update still counts (nothing touched it yet)", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "deploy region", body: "- region: eu\n- zone: a" });
  llmReply({
    ops: [
      { op: "confirm", id: m.id },
      { op: "update", id: m.id, entities: [{ name: "AWS", kind: "service" }] },
      { op: "edit", id: m.id, old: "- zone: a", new: "- zone: b" },
    ],
  });
  const t = await turn([{ role: "user", text: "deploy region zone b" }], p);
  await runQueueOnce();
  assert.deepEqual((await getTurn(t.id)).result.applied.map((a: Any) => a.op), ["confirm", "update"]);
});

test("G-047: a held update whose entities are refused does not take the edit down", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "api client", body: "- timeout: 5s\n- retries: 2", entities: [{ name: "axios", kind: "tool" }] });
  const before = revisionCount(m.id);
  llmReply({
    ops: [
      { op: "edit", id: m.id, old: "- timeout: 5s", new: "- timeout: 10s" },
      { op: "update", id: m.id, entities: [{ name: "sk-" + "q".repeat(30), kind: "tool" }] },
    ],
  });
  const t = await turn([{ role: "user", text: "api client timeout 10s" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.applied.map((a: Any) => [a.op, a.entryId]), [["update", m.id]]);
  assert.equal((await getEntry(m.id)).body, "- timeout: 10s\n- retries: 2", "the edit still applies");
  assert.deepEqual(await entityNames(m.id), ["axios"], "the refused entities are not written");
  assert.equal(revisionCount(m.id) - before, 1);
});

test("G-047: held updates go to the first edit that succeeds, not the first edit", async () => {
  const p = await freshProject();
  const m = await entry({ project_id: p.id, title: "worker pool", body: "- size: 4\n- queue: fifo" });
  const before = revisionCount(m.id);
  llmReply({
    ops: [
      { op: "edit", id: m.id, old: "- size: 9", new: "x" },
      { op: "edit", id: m.id, old: "- size: 4", new: "- size: 8" },
      { op: "update", id: m.id, entities: [{ name: "piscina", kind: "tool" }] },
    ],
  });
  const t = await turn([{ role: "user", text: "worker pool size 8" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.skipped.map((s: Any) => s.reason), ["edit_not_found"]);
  assert.equal((await getEntry(m.id)).body, "- size: 8\n- queue: fifo");
  assert.deepEqual(await entityNames(m.id), ["piscina"]);
  assert.equal(revisionCount(m.id) - before, 1, "one revision even though the first edit missed");
});

test("G-047: valid_until rides on the edit (or a held update) in the same revision", async () => {
  const p = await freshProject();
  const a = await entry({ project_id: p.id, title: "release freeze", body: "- scope: api\n- owner: kim" });
  const b = await entry({ project_id: p.id, title: "branch freeze", body: "- scope: main\n- owner: lee" });
  const beforeA = revisionCount(a.id);
  const beforeB = revisionCount(b.id);
  llmReply({
    ops: [
      { op: "edit", id: a.id, old: "- scope: api", new: "- scope: api (until 2026-10-14)", valid_until: "2026-10-14" },
      { op: "edit", id: b.id, old: "- scope: main", new: "- scope: main (until 2026-10-21)" },
      { op: "update", id: b.id, valid_until: "2026-10-21" },
    ],
  });
  const t = await turn([{ role: "user", text: "freeze until next wednesday" }], p);
  await runQueueOnce();
  assert.equal((await getTurn(t.id)).status, "done");
  assert.equal((await getEntry(a.id)).valid_until, "2026-10-14");
  assert.equal((await getEntry(b.id)).valid_until, "2026-10-21");
  assert.equal(revisionCount(a.id) - beforeA, 1);
  assert.equal(revisionCount(b.id) - beforeB, 1);
});

test("G-047: the later op in the response wins the entity list, either order, one revision", async () => {
  const p = await freshProject();
  const m1 = await entry({ project_id: p.id, title: "orm one", body: "- orm: none" });
  const m2 = await entry({ project_id: p.id, title: "orm two", body: "- orm: none" });
  const b1 = revisionCount(m1.id);
  const b2 = revisionCount(m2.id);
  llmReply({
    ops: [
      { op: "edit", id: m1.id, old: "- orm: none", new: "- orm: prisma", entities: [{ name: "Prisma", kind: "tool" }] },
      { op: "update", id: m1.id, entities: [{ name: "Drizzle", kind: "tool" }] },
      { op: "update", id: m2.id, entities: [{ name: "Drizzle", kind: "tool" }] },
      { op: "edit", id: m2.id, old: "- orm: none", new: "- orm: prisma", entities: [{ name: "Prisma", kind: "tool" }] },
    ],
  });
  const t = await turn([{ role: "user", text: "orm one and orm two" }], p);
  await runQueueOnce();
  assert.equal((await getTurn(t.id)).status, "done");
  assert.deepEqual(await entityNames(m1.id), ["Drizzle"], "[edit A, update B] → B");
  assert.deepEqual(await entityNames(m2.id), ["Prisma"], "[update B, edit A] → A");
  assert.equal(revisionCount(m1.id) - b1, 1);
  assert.equal(revisionCount(m2.id) - b2, 1);
});

test("G-047: an edit of a standing instruction drops its own and the held update's entities/links", async () => {
  const p = await freshProject();
  const s = await entry({ project_id: p.id, category: "standing", title: "always answer in Korean", body: "- answer in Korean", entities: [{ name: "Korean", kind: "concept" }] });
  const other = await entry({ project_id: p.id, title: "docs language", body: "docs are Korean" });
  const before = revisionCount(s.id);
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
  try {
    const r = applyMemoryOps(
      [
        { op: "edit", id: s.id, old: "- answer in Korean", new: "- answer in English", entities: [{ name: "English", kind: "concept" }], links: [{ to: other.id, type: "related" }] },
        { op: "update", id: s.id, entities: [{ name: "Japanese", kind: "concept" }], links: [{ to: other.id, type: "because" }] },
      ],
      null,
      new Set([s.id, other.id]),
      { author: "llm", turnId: null, origin: "turn" } as Any,
      "test",
    );
    assert.deepEqual(r.applied, []);
  } finally {
    console.warn = orig;
  }
  assert.deepEqual(warnings.filter((w) => w.includes("op rejected")), [], "skipped by the worker, not refused by the store");
  assert.equal((await getEntry(s.id)).body, "- answer in Korean");
  assert.deepEqual(await entityNames(s.id), ["Korean"]);
  assert.deepEqual(outLinks(s.id), []);
  assert.equal(revisionCount(s.id), before);
});
