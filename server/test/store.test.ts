import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { call, db, entry, llmCalls, llmReply, llmReset, ok, project, runQueueOnce, turn } from "./helpers.ts";
import { createEntry, deleteEntry, getEntry, updateEntry } from "../src/store.ts";
import { applyMemoryOps } from "../src/worker.ts";

// Obviously fake credentials, built at runtime so no secret-looking literal sits in the repo.
const fakeOpenAi = () => "sk-" + "a".repeat(30);
const fakeGithub = () => "ghp_" + "b".repeat(30);
const fakeAssign = () => "password=" + "c".repeat(20);

const revisionsOf = (id: number) =>
  db.prepare(`SELECT * FROM revisions WHERE entry_id = ? ORDER BY id`).all(id) as Record<string, any>[];
const count = (sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(...args) as any).n);

beforeEach(() => llmReset());

// ------------------------------------------------------------------ G-002

test("G-002: llm/agent authors cannot create, change or delete standing instructions in the store", () => {
  for (const author of ["llm", "agent"] as const) {
    assert.throws(
      () => createEntry({ scope: "global", category: "standing", title: `standing by ${author}` }, { author }),
      (e: any) => e.status === 403,
    );
  }
  const s = createEntry({ scope: "global", category: "standing", title: "always answer in Korean", body: "rule" }, { author: "human" });
  for (const author of ["llm", "agent"] as const) {
    assert.throws(() => updateEntry(s.id, { body: "changed" }, { author }), (e: any) => e.status === 403);
    assert.throws(() => deleteEntry(s.id, { author }), (e: any) => e.status === 403);
  }
  // Promoting an ordinary memory to standing is also a standing write.
  const f = createEntry({ scope: "global", title: "plain fact for promotion" }, { author: "human" });
  assert.throws(() => updateEntry(f.id, { category: "standing" }, { author: "llm" }), (e: any) => e.status === 403);
  assert.equal(getEntry(f.id)!.category, "fact");
  const after = getEntry(s.id)!;
  assert.equal(after.body, "rule");
  assert.equal(after.deleted_at, null);
  assert.equal(revisionsOf(s.id).length, 1, "rejected writes leave no revisions");
});

test("G-002: humans can create, edit and delete standing via the API", async () => {
  const s = await entry({ category: "standing", title: "human standing rule", body: "v1" });
  assert.equal(s.category, "standing");
  assert.equal(s.source, "human");
  const u = await ok("PATCH", `/entries/${s.id}`, { body: "v2" });
  assert.equal(u.body, "v2");
  const d = await ok("DELETE", `/entries/${s.id}`);
  assert.ok(d.deleted_at);
});

test("G-002: /agent/memory add with category standing is rejected 403", async () => {
  const r = await call("POST", "/agent/memory", { action: "add", target: "memory", content: "agent tries standing", category: "standing" });
  assert.equal(r.status, 403);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entries WHERE title = ?`, "agent tries standing"), 0);
});

test("G-002: /agent/memory cannot replace or remove a standing instruction", async () => {
  const s = await entry({ category: "standing", title: "zebra-standing-marker rule", body: "keep me" });
  const rep = await call("POST", "/agent/memory", { action: "replace", target: "memory", old_text: "zebra-standing-marker", content: "overwritten" });
  assert.ok(rep.status === 403 || rep.status === 404, `replace status ${rep.status}`);
  const rem = await call("POST", "/agent/memory", { action: "remove", target: "memory", old_text: "zebra-standing-marker" });
  assert.ok(rem.status === 403 || rem.status === 404, `remove status ${rem.status}`);
  const cur = getEntry(s.id)!;
  assert.equal(cur.title, "zebra-standing-marker rule");
  assert.equal(cur.body, "keep me");
  assert.equal(cur.deleted_at, null);
});

test("G-002: /agent/memory replace cannot promote a memory to standing", async () => {
  const f = await entry({ title: "okapi agent fact", body: "x" });
  const r = await call("POST", "/agent/memory", { action: "replace", target: "memory", old_text: "okapi agent fact", content: "okapi promoted", category: "standing" });
  assert.equal(r.status, 403);
  assert.equal(getEntry(f.id)!.category, "fact");
  assert.equal(getEntry(f.id)!.title, "okapi agent fact");
});

test("G-002: curation never shows standing to the LLM and cannot add, update or delete it", async () => {
  const s = await entry({ category: "standing", title: "narwhal standing directive", body: "narwhal rule body" });
  const other = await entry({ title: "narwhal ordinary fact", body: "narwhal fact body" });
  llmReply({
    ops: [
      { op: "update", id: s.id, title: "hijacked", body: "hijacked" },
      { op: "delete", id: s.id },
      { op: "add", scope: "global", category: "standing", title: "narwhal llm standing attempt", body: "x" },
    ],
  });
  const t = await turn([{ role: "user", text: "narwhal discussion about the narwhal rule and narwhal fact" }, { role: "assistant", text: "ok" }], null);
  await runQueueOnce();
  assert.equal(llmCalls.length, 1);
  assert.ok(!llmCalls[0].user.includes("narwhal standing directive"), "standing must not be a curation candidate");
  assert.ok(llmCalls[0].user.includes("narwhal ordinary fact"), "ordinary memory is a candidate (sanity)");
  const cur = getEntry(s.id)!;
  assert.equal(cur.title, "narwhal standing directive");
  assert.equal(cur.deleted_at, null);
  // An LLM "standing" add is never stored as standing.
  const added = db.prepare(`SELECT category, source FROM entries WHERE title = ?`).all("narwhal llm standing attempt") as any[];
  for (const a of added) assert.notEqual(a.category, "standing");
  assert.equal(count(`SELECT COUNT(*) AS n FROM entries WHERE category = 'standing' AND source != 'human'`), 0);
  const done = await ok("GET", `/turns/${t.id}`);
  assert.equal(done.status, "done");
  assert.ok(!done.result.applied.some((a: any) => a.entryId === s.id));
  assert.ok(other.id);
});

test("G-002: applyMemoryOps with a standing id allowed is still rejected by the store", () => {
  const s = createEntry({ scope: "global", category: "standing", title: "ibis standing", body: "b" }, { author: "human" });
  const { applied } = applyMemoryOps(
    [
      { op: "update", id: s.id, body: "changed by llm" },
      { op: "delete", id: s.id },
    ],
    null,
    new Set([s.id]),
    { author: "llm" },
    "test",
  );
  assert.deepEqual(applied, []);
  assert.equal(getEntry(s.id)!.body, "b");
  assert.equal(getEntry(s.id)!.deleted_at, null);
});

// ------------------------------------------------------------------ G-003

test("G-003: secrets are rejected 422 on create (title or body) and nothing is stored", async () => {
  const before = count(`SELECT COUNT(*) AS n FROM entries`);
  for (const body of [`key is ${fakeOpenAi()}`, `token ${fakeGithub()}`, fakeAssign()]) {
    const r = await call("POST", "/entries", { scope: "global", title: "secret-bearing memory", body });
    assert.equal(r.status, 422, body);
    assert.match(r.data.error, /secret/);
  }
  const t = await call("POST", "/entries", { scope: "global", title: `title ${fakeOpenAi()}` });
  assert.equal(t.status, 422);
  const a = await call("POST", "/agent/memory", { action: "add", target: "memory", content: `api_key=${fakeOpenAi()}` });
  assert.equal(a.status, 422);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entries`), before);
  assert.equal(count(`SELECT COUNT(*) AS n FROM revisions WHERE body LIKE ? OR title LIKE ?`, "%aaaaaaaaaaaaaaaaaaaa%", "%aaaaaaaaaaaaaaaaaaaa%"), 0);
});

test("G-003: secrets are rejected 422 on update and the entry stays unchanged", async () => {
  const e = await entry({ title: "clean memory", body: "clean body" });
  const r = await call("PATCH", `/entries/${e.id}`, { body: `now with ${fakeGithub()}` });
  assert.equal(r.status, 422);
  const r2 = await call("PATCH", `/entries/${e.id}`, { title: `t ${fakeAssign()}` });
  assert.equal(r2.status, 422);
  const cur = getEntry(e.id)!;
  assert.equal(cur.title, "clean memory");
  assert.equal(cur.body, "clean body");
  assert.equal(revisionsOf(e.id).length, 1);
});

test("G-003: a curation op carrying a secret is dropped, other ops still apply", async () => {
  llmReply({
    ops: [
      { op: "add", scope: "global", category: "fact", title: "heron leaked key", body: `use ${fakeOpenAi()}` },
      { op: "add", scope: "global", category: "fact", title: "heron clean fact", body: "fine" },
    ],
  });
  await turn([{ role: "user", text: "heron setup details please remember" }, { role: "assistant", text: "ok" }], null);
  await runQueueOnce();
  assert.equal(count(`SELECT COUNT(*) AS n FROM entries WHERE title = ?`, "heron leaked key"), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entries WHERE title = ?`, "heron clean fact"), 1);
});

test("G-003: secrets in turn messages and tool-call args are redacted before storage", async () => {
  const k1 = fakeOpenAi();
  const k2 = fakeGithub();
  const t = await turn(
    [
      { role: "user", text: `my key is ${k1} and ${fakeAssign()}` },
      { role: "assistant", text: "noted", toolCalls: [{ name: "bash", args: `export GH=${k2}` }] },
      { role: "tool", name: "bash", text: `echo ${k1}` },
    ],
    null,
    "s-redact",
  );
  const row = db.prepare(`SELECT payload, text FROM turns WHERE id = ?`).get(t.id) as { payload: string; text: string };
  for (const stored of [row.payload, row.text]) {
    assert.ok(!stored.includes(k1), "openai-like key leaked");
    assert.ok(!stored.includes(k2), "github-like token leaked");
    assert.ok(!stored.includes("c".repeat(20)), "assignment value leaked");
  }
  assert.match(row.text, /\[REDACTED/);
  assert.match(row.payload, /REDACTED:openai-key/);
  assert.match(row.payload, /REDACTED:github-token/);
  assert.match(row.text, /password=\[REDACTED\]/);
  // Drain so later tests see an empty queue (an LLM error here is fine; it only marks the turn).
  llmReply({ ops: [] });
  await runQueueOnce();
});

test("G-003: a secret-shaped tag is rejected 422 on create and nothing is stored", async () => {
  const k = fakeOpenAi();
  const before = count(`SELECT COUNT(*) AS n FROM entries`);
  const r = await call("POST", "/entries", { scope: "global", title: "tag-secret probe", tags: ["ok-tag", k] });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /secret/);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entries`), before);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entries WHERE title = ?`, "tag-secret probe"), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entries WHERE tags LIKE ?`, `%${k}%`), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM revisions WHERE tags LIKE ? OR title = ?`, `%${k}%`, "tag-secret probe"), 0);
});

test("G-003: a secret-shaped entity name is rejected 422 on create and nothing is stored", async () => {
  const before = count(`SELECT COUNT(*) AS n FROM entries`);
  for (const ent of [fakeGithub(), { name: fakeGithub(), type: "tool" }]) {
    const r = await call("POST", "/entries", { scope: "global", title: "entity-secret probe", entities: ["Redis", ent] });
    assert.equal(r.status, 422, JSON.stringify(ent));
    assert.match(r.data.error, /secret/);
  }
  const k = fakeGithub();
  assert.equal(count(`SELECT COUNT(*) AS n FROM entries`), before);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entries WHERE title = ?`, "entity-secret probe"), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entities WHERE name LIKE ?`, `%${k}%`), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM revisions WHERE entities LIKE ? OR title = ?`, `%${k}%`, "entity-secret probe"), 0);
});

test("G-003: PATCH with a secret-shaped tag or entity name is rejected 422 and the entry stays unchanged", async () => {
  const e = await entry({ title: "patch-secret probe", body: "clean", tags: ["keep"], entities: ["Redis"] });
  const revs = revisionsOf(e.id).length;
  const k1 = fakeOpenAi();
  const k2 = fakeGithub();
  const r1 = await call("PATCH", `/entries/${e.id}`, { tags: ["keep", k1] });
  assert.equal(r1.status, 422);
  assert.match(r1.data.error, /secret/);
  const r2 = await call("PATCH", `/entries/${e.id}`, { entities: ["Redis", k2] });
  assert.equal(r2.status, 422);
  assert.match(r2.data.error, /secret/);
  const r3 = await call("PATCH", `/entries/${e.id}`, { body: "changed body", entities: [{ name: k2 }] });
  assert.equal(r3.status, 422);
  const cur = getEntry(e.id)!;
  assert.equal(cur.body, "clean");
  assert.deepEqual(cur.tags, ["keep"]);
  const names = (db.prepare(`SELECT n.name FROM entry_entities ee JOIN entities n ON n.id = ee.entity_id WHERE ee.entry_id = ?`).all(e.id) as { name: string }[]).map((x) => x.name);
  assert.deepEqual(names, ["Redis"]);
  assert.equal(revisionsOf(e.id).length, revs);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entities WHERE name LIKE ?`, `%${k2}%`), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM revisions WHERE tags LIKE ? OR entities LIKE ?`, `%${k1}%`, `%${k2}%`), 0);
});

// --------------------------------------------------------------- revisions

test("revisions are written on create, update, delete and restore with author", async () => {
  const e = await entry({ title: "rev v1", body: "b1", entities: ["Redis"] });
  await ok("PATCH", `/entries/${e.id}`, { title: "rev v2", body: "b2" });
  await ok("DELETE", `/entries/${e.id}`);
  await ok("POST", `/entries/${e.id}/restore`);
  const revs = revisionsOf(e.id);
  assert.deepEqual(revs.map((r) => r.action), ["create", "update", "delete", "restore"]);
  assert.ok(revs.every((r) => r.author === "human"));
  assert.equal(revs[0].title, "rev v1");
  assert.equal(revs[1].title, "rev v2");
  assert.deepEqual(JSON.parse(revs[0].entities), ["Redis"]);
  const detail = await ok("GET", `/entries/${e.id}`);
  assert.equal(detail.revisions.length, 4);
  assert.equal(detail.revisions[0].action, "restore", "newest first");
});

test("a no-op update writes no revision", async () => {
  const e = await entry({ title: "noop target", body: "same", entities: ["Nginx"] });
  await ok("PATCH", `/entries/${e.id}`, { title: "noop target", body: "same", entities: ["Nginx"] });
  assert.equal(revisionsOf(e.id).length, 1);
});

test("an entity-only change writes a revision snapshotting the new entities", async () => {
  const e = await entry({ title: "entity-only target", body: "b", entities: ["Docker"] });
  const u = await ok("PATCH", `/entries/${e.id}`, { entities: ["Docker", "Podman"] });
  assert.equal(u.title, "entity-only target");
  const revs = revisionsOf(e.id);
  assert.equal(revs.length, 2);
  assert.equal(revs[1].action, "update");
  assert.deepEqual(JSON.parse(revs[1].entities), ["Docker", "Podman"]);
  const detail = await ok("GET", `/entries/${e.id}`);
  assert.deepEqual(detail.entities.map((n: any) => n.name).sort(), ["Docker", "Podman"]);
});

test("revert restores title, body and the entity snapshot of that revision", async () => {
  const e = await entry({ title: "revert v1", body: "body v1", tags: ["one"], entities: ["Kafka", "ZooKeeper"] });
  const firstRev = revisionsOf(e.id)[0].id as number;
  await ok("PATCH", `/entries/${e.id}`, { title: "revert v2", body: "body v2", tags: ["two"], entities: ["RabbitMQ"] });
  const r = await ok("POST", `/entries/${e.id}/revert`, { revisionId: firstRev });
  assert.equal(r.title, "revert v1");
  assert.equal(r.body, "body v1");
  assert.deepEqual(r.tags, ["one"]);
  const detail = await ok("GET", `/entries/${e.id}`);
  assert.deepEqual(detail.entities.map((n: any) => n.name).sort(), ["Kafka", "ZooKeeper"]);
  const revs = revisionsOf(e.id);
  assert.equal(revs.at(-1)!.action, "update");
  assert.match(String(revs.at(-1)!.reason), new RegExp(`#${firstRev}`));
  // The orphaned entity from v2 is no longer attached.
  assert.ok(!detail.entities.some((n: any) => n.name === "RabbitMQ"));
});

test("revert of a soft-deleted entry restores it and applies the revision", async () => {
  const e = await entry({ title: "deleted revert v1", body: "a" });
  const firstRev = revisionsOf(e.id)[0].id as number;
  await ok("PATCH", `/entries/${e.id}`, { body: "b" });
  await ok("DELETE", `/entries/${e.id}`);
  const r = await ok("POST", `/entries/${e.id}/revert`, { revisionId: firstRev });
  assert.equal(r.deleted_at, null);
  assert.equal(r.body, "a");
  assert.deepEqual(revisionsOf(e.id).map((x) => x.action), ["create", "update", "delete", "restore", "update"]);
});

test("revert with a revision of another entry is 404", async () => {
  const a = await entry({ title: "revert owner a" });
  const b = await entry({ title: "revert owner b" });
  const revB = revisionsOf(b.id)[0].id as number;
  const r = await call("POST", `/entries/${a.id}/revert`, { revisionId: revB });
  assert.equal(r.status, 404);
  assert.equal(getEntry(a.id)!.title, "revert owner a");
});

// ------------------------------------------------- soft delete / restore / purge

test("soft delete hides from lists, restore brings it back, deleted entries can't be edited", async () => {
  const e = await entry({ title: "soft delete target" });
  await ok("DELETE", `/entries/${e.id}`);
  let live = await ok<any[]>("GET", "/entries");
  assert.ok(!live.some((x) => x.id === e.id));
  const trash = await ok<any[]>("GET", "/entries?deleted=1");
  assert.ok(trash.some((x) => x.id === e.id));
  assert.equal((await call("PATCH", `/entries/${e.id}`, { body: "x" })).status, 404);
  assert.equal((await call("DELETE", `/entries/${e.id}`)).status, 404, "double delete is 404");
  const r = await ok("POST", `/entries/${e.id}/restore`);
  assert.equal(r.deleted_at, null);
  live = await ok<any[]>("GET", "/entries");
  assert.ok(live.some((x) => x.id === e.id));
  // Restoring a live entry is a no-op (no extra revision).
  await ok("POST", `/entries/${e.id}/restore`);
  assert.equal(revisionsOf(e.id).filter((x) => x.action === "restore").length, 1);
});

test("purge only removes soft-deleted entries, with their revisions and orphan entities", async () => {
  const e = await entry({ title: "purge target", entities: ["PurgeOnlyEntityXyz"] });
  await ok("DELETE", `/entries/${e.id}/purge`);
  assert.ok(getEntry(e.id), "purge of a live entry does nothing");
  assert.equal(count(`SELECT COUNT(*) AS n FROM entities WHERE name = ?`, "PurgeOnlyEntityXyz"), 1);
  await ok("DELETE", `/entries/${e.id}`);
  await ok("DELETE", `/entries/${e.id}/purge`);
  assert.equal(getEntry(e.id), null);
  assert.equal(revisionsOf(e.id).length, 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entry_entities WHERE entry_id = ?`, e.id), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entities WHERE name = ?`, "PurgeOnlyEntityXyz"), 0);
  assert.equal((await call("GET", `/entries/${e.id}`)).status, 404);
});

// ---------------------------------------------------------- project delete

test("deleting a project cascades to its entries, revisions, turns, wiki pages and orphan entities", async () => {
  const p = await project("example.com/test/cascade", "cascade");
  const keep = await entry({ title: "global survives project delete", entities: ["SharedCascadeEntity"] });
  const e = await entry({ project_id: p.id, scope: "project", title: "project-only memory", entities: ["CascadeOnlyEntity", "SharedCascadeEntity"] });
  await ok("PATCH", `/entries/${e.id}`, { body: "edited" });
  const t = await turn([{ role: "user", text: "hi" }], p, "s-cascade");
  await runQueueOnce(); // trivial turn: skipped without an LLM call
  const page = await ok("POST", "/wiki/pages", { project_id: p.id, title: "Cascade Page", body: "text" });
  assert.equal(llmCalls.length, 0);

  await ok("DELETE", `/projects/${p.id}`);
  assert.equal((await call("GET", `/projects/${p.id}`)).status, 404);
  assert.equal(getEntry(e.id), null);
  assert.equal(revisionsOf(e.id).length, 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM turns WHERE id = ?`, t.id), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM wiki_pages WHERE id = ?`, page.id), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entities WHERE name = ?`, "CascadeOnlyEntity"), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM entities WHERE name = ?`, "SharedCascadeEntity"), 1);
  assert.ok(getEntry(keep.id));
});
