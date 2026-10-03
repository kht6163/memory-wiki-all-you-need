// Turn provenance (entry_turns): which turns added, updated, re-stated or
// confirmed a memory, and the "confirm" op that records use without changing
// the memory (G-009 shown candidates only, G-005 stable block unmoved).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, entry, llmCalls, llmReply, llmReset, ok, project, runQueueOnce, turn } from "./helpers.ts";

type Any = any;
let seq = 0;
async function proj() {
  seq++;
  return project(`github.com/test/provenance-${seq}`, `provenance-${seq}`);
}

/** Ids in the EXISTING MEMORIES block of the curation prompt. */
function shownIds(user: string): number[] {
  const block = user.slice(user.indexOf("EXISTING MEMORIES"), user.indexOf("KNOWN ENTITIES"));
  return block
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => Number(JSON.parse(l).id));
}

const ctx = (p: { key: string; name: string }, prompt: string) => ok<Any>("POST", "/context", { project: { key: p.key, name: p.name }, prompt });
const rows = (turnId: number) =>
  db.prepare(`SELECT entry_id, kind FROM entry_turns WHERE turn_id = ? ORDER BY entry_id, kind`).all(turnId).map((r) => [Number(r.entry_id), String(r.kind)]);

beforeEach(() => llmReset());

test("curation records add, update and duplicate rows for the turn", async () => {
  const p = await proj();
  const kept = await entry({ project_id: p.id, title: "lint runs with biome", body: "npx biome check ." });
  const same = await entry({ project_id: p.id, title: "tests use node:test", body: "npm test at the root" });
  let shown: number[] = [];
  llmReply((c: { user: string }) => {
    shown = shownIds(c.user);
    return {
      ops: [
        { op: "add", scope: "project", category: "fact", title: "ci runs on github actions", body: "workflow ci.yml" },
        { op: "update", id: kept.id, body: "npx biome check . --write", reason: "flag" },
        { op: "add", scope: "project", category: "fact", title: "Tests use  node:test", body: "npm test at the root" },
      ],
    };
  });
  const t = await turn([{ role: "user", text: "lint with biome --write, tests node:test, ci on github actions" }, { role: "assistant", text: "ok" }], p);
  await runQueueOnce();
  const done = await ok<Any>("GET", `/turns/${t.id}`);
  assert.equal(done.status, "done");
  assert.ok(shown.includes(kept.id));
  const added = done.result.applied.find((a: Any) => a.op === "add");
  assert.ok(added);
  assert.deepEqual(done.result.skipped, [{ op: "add", title: "Tests use  node:test", reason: "duplicate", entryId: same.id }]);
  assert.deepEqual(rows(t.id), [
    [kept.id, "update"],
    [same.id, "duplicate"],
    [added.entryId, "add"],
  ].sort((a, b) => (a[0] as number) - (b[0] as number)));
});

test("confirm records provenance only for shown candidates and changes nothing else", async () => {
  const p = await proj();
  const other = await proj();
  const shownM = await entry({ project_id: p.id, title: "server port is 8765", body: "PORT env" });
  const hidden = await entry({ project_id: other.id, title: "zebra quokka unrelated note", body: "lorem" });
  const old = "2025-01-01T00:00:00.000Z";
  db.prepare(`UPDATE entries SET updated_at = ? WHERE id = ?`).run(old, shownM.id);
  const before = await ok<Any>("GET", `/entries/${shownM.id}`);
  const ctxBefore = await ok<Any>("POST", "/context", { project: { key: p.key, name: p.name }, prompt: "" });

  let shown: number[] = [];
  llmReply((c: { user: string }) => {
    shown = shownIds(c.user);
    return { ops: [{ op: "confirm", id: shownM.id }, { op: "confirm", id: shownM.id }, { op: "confirm", id: hidden.id }] };
  });
  const t = await turn([{ role: "user", text: "start the server on port 8765" }, { role: "assistant", text: "started on 8765" }], p);
  await runQueueOnce();
  const done = await ok<Any>("GET", `/turns/${t.id}`);
  assert.equal(done.status, "done");
  assert.ok(shown.includes(shownM.id) && !shown.includes(hidden.id));
  assert.deepEqual(done.result.applied, [{ op: "confirm", entryId: shownM.id, title: "server port is 8765" }]);
  assert.deepEqual(rows(t.id), [[shownM.id, "confirm"]], "non-candidate confirm is ignored");

  const after = await ok<Any>("GET", `/entries/${shownM.id}`);
  assert.equal(after.entry.updated_at, old, "confirm does not touch updated_at");
  assert.equal(after.revisions.length, before.revisions.length, "confirm writes no revision");
  assert.equal((await ok<Any>("GET", `/entries/${hidden.id}`)).provenance.count, 0);
  const ctxAfter = await ok<Any>("POST", "/context", { project: { key: p.key, name: p.name }, prompt: "" });
  assert.equal(ctxAfter.system, ctxBefore.system, "stable block unchanged (G-005)");
  assert.equal(llmCalls.length, 1, "still one curation call (G-019)");
});

test("GET /entries/:id returns provenance; deleting a turn removes its rows", async () => {
  const p = await proj();
  const m = await entry({ project_id: p.id, title: "deploy with docker compose", body: "compose up -d --build" });
  llmReply(() => ({ ops: [{ op: "confirm", id: m.id }] }));
  llmReply(() => ({ ops: [{ op: "update", id: m.id, body: "docker compose up -d --build", reason: "full command" }] }));
  const t1 = await turn([{ role: "user", text: "deploy with docker compose please" }, { role: "assistant", text: "deployed" }], p, "sess-a");
  const t2 = await turn([{ role: "user", text: "the deploy command is docker compose up -d --build" }, { role: "assistant", text: "noted" }], p, "sess-b");
  await runQueueOnce();
  assert.equal((await ok<Any>("GET", `/turns/${t1.id}`)).status, "done");
  assert.equal((await ok<Any>("GET", `/turns/${t2.id}`)).status, "done");

  const prov = (await ok<Any>("GET", `/entries/${m.id}`)).provenance;
  assert.equal(prov.count, 2);
  assert.equal(prov.recent.length, 2);
  assert.deepEqual(prov.recent.map((r: Any) => [r.turn_id, r.kind, r.session_id]), [
    [t2.id, "update", "sess-b"],
    [t1.id, "confirm", "sess-a"],
  ]);
  assert.equal(prov.last_at, prov.recent[0].created_at);

  await ok("DELETE", `/turns/${t2.id}`);
  const after = (await ok<Any>("GET", `/entries/${m.id}`)).provenance;
  assert.equal(after.count, 1);
  assert.deepEqual(after.recent.map((r: Any) => r.turn_id), [t1.id]);
  assert.deepEqual(rows(t2.id), []);
});

test("confirm is skipped for a memory deleted, updated or superseded earlier in the same batch", async () => {
  const p = await proj();
  const gone = await entry({ project_id: p.id, title: "cache lives in redis", body: "redis on 6379" });
  const retired = await entry({ project_id: p.id, title: "build uses webpack", body: "webpack.config.js" });
  const changed = await entry({ project_id: p.id, title: "node version is 22", body: "nvm use 22" });
  let shown: number[] = [];
  llmReply((c: { user: string }) => {
    shown = shownIds(c.user);
    return {
      ops: [
        { op: "delete", id: gone.id, reason: "redis removed" },
        { op: "confirm", id: gone.id },
        { op: "add", scope: "project", category: "fact", title: "build uses vite", body: "vite.config.ts", links: [{ to: retired.id, type: "supersedes" }] },
        { op: "confirm", id: retired.id },
        { op: "update", id: changed.id, body: "nvm use 24", reason: "upgraded" },
        { op: "confirm", id: changed.id },
      ],
    };
  });
  const t = await turn([{ role: "user", text: "redis cache removed; build uses vite not webpack; node version is 24 now" }, { role: "assistant", text: "ok" }], p);
  await runQueueOnce();
  const done = await ok<Any>("GET", `/turns/${t.id}`);
  assert.equal(done.status, "done");
  for (const id of [gone.id, retired.id, changed.id]) assert.ok(shown.includes(id), `#${id} shown`);
  assert.deepEqual(done.result.applied.map((a: Any) => a.op), ["delete", "add", "update"], "no confirm after delete/supersede/update");
  assert.equal(rows(t.id).filter(([, k]) => k === "confirm").length, 0);
});

test("review shows confirmed (confirm + duplicate + update turns) only for memories changed since tracking began", async () => {
  const p = await proj();
  // A confirm starts tracking (the backfill never writes confirm/duplicate rows).
  const seed = await entry({ project_id: p.id, title: "logs go to stdout", body: "pino to stdout" });
  llmReply(() => ({ ops: [{ op: "confirm", id: seed.id }] }));
  const t0 = await turn([{ role: "user", text: "where do logs go? stdout" }, { role: "assistant", text: "stdout" }], p);
  await runQueueOnce();
  assert.equal((await ok<Any>("GET", `/turns/${t0.id}`)).status, "done");

  const old = await entry({ project_id: p.id, title: "prefer tabs over spaces", body: "editorconfig tabs", category: "preference" });
  db.prepare(`UPDATE entries SET updated_at = ? WHERE id = ?`).run("2020-01-01T00:00:00.000Z", old.id);
  const fresh = await entry({ project_id: p.id, title: "api lives under /api", body: "hono router" });
  llmReply(() => ({ ops: [{ op: "add", scope: "project", category: "fact", title: "API lives under /api", body: "hono  router" }] }));
  const t1 = await turn([{ role: "user", text: "the api lives under /api with hono" }, { role: "assistant", text: "yes" }], p);
  await runQueueOnce();
  assert.equal((await ok<Any>("GET", `/turns/${t1.id}`)).status, "done");
  assert.deepEqual(rows(t1.id), [[fresh.id, "duplicate"]]);

  await ok("POST", "/review", { project_id: p.id });
  let lines = new Map<number, Any>();
  let system = "";
  llmReply((c: { system: string; user: string }) => {
    system = c.system;
    lines = new Map(c.user.split("\n").filter((l) => l.startsWith("{")).map((l) => [Number(JSON.parse(l).id), JSON.parse(l)]));
    return { proposals: [] };
  });
  await runQueueOnce();
  assert.ok(system.includes('"confirmed"'));
  assert.ok(lines.has(old.id) && lines.has(fresh.id), "both memories reviewed");
  assert.equal("confirmed" in lines.get(old.id), false, "untracked old memory: no misleading confirmed: 0");
  assert.equal(lines.get(fresh.id).confirmed, 1, "a re-statement (duplicate) counts");
});

test("a duplicate add still applies its links (supersedes retires the old memory) and gives an entity-less duplicate its entities", async () => {
  const p = await proj();
  const old = await entry({ project_id: p.id, title: "DB engine", body: "uses MySQL 5.7" });
  const dup = await entry({ project_id: p.id, title: "DB engine now PostgreSQL", body: "migrated to PostgreSQL 16" });
  let shown: number[] = [];
  llmReply((c: { user: string }) => {
    shown = shownIds(c.user);
    return {
      ops: [
        {
          op: "add", scope: "project", title: "DB engine now PostgreSQL", body: "migrated to PostgreSQL 16",
          entities: [{ name: "PostgreSQL", kind: "tech" }], links: [{ to: old.id, type: "supersedes" }],
        },
      ],
    };
  });
  const t = await turn([{ role: "user", text: "we migrated the DB engine from MySQL to PostgreSQL 16" }, { role: "assistant", text: "noted" }], p);
  await runQueueOnce();
  const done = await ok<Any>("GET", `/turns/${t.id}`);
  assert.equal(done.status, "done", JSON.stringify(done.error ?? done.result));
  assert.ok(shown.includes(old.id), "old memory was a candidate");
  assert.deepEqual(done.result.applied, []);
  assert.deepEqual(done.result.skipped, [{ op: "add", title: "DB engine now PostgreSQL", reason: "duplicate", entryId: dup.id }]);
  const oldNow = await ok<Any>("GET", `/entries/${old.id}`);
  assert.equal(oldNow.entry.superseded_by, dup.id, "the supersedes link was applied from the duplicate");
  const dupNow = await ok<Any>("GET", `/entries/${dup.id}`);
  assert.deepEqual(dupNow.entities.map((e: Any) => e.name), ["PostgreSQL"]);
  const rev = db.prepare(`SELECT author, turn_id FROM revisions WHERE entry_id = ? ORDER BY id DESC LIMIT 1`).get(dup.id) as Any;
  assert.deepEqual([rev.author, Number(rev.turn_id)], ["llm", t.id], "entity attach is a revision by the llm for this turn");
  assert.ok(!(await ctx(p, "")).system.includes("MySQL 5.7"), "the stale fact is no longer injected");

  // A duplicate that already has entities keeps them.
  llmReply({ ops: [{ op: "add", scope: "project", title: "DB engine now PostgreSQL", body: "migrated to PostgreSQL 16", entities: ["Postgres Other"] }] });
  const t2 = await turn([{ role: "user", text: "again: the DB engine is PostgreSQL 16 now" }, { role: "assistant", text: "yes" }], p);
  await runQueueOnce();
  assert.equal((await ok<Any>("GET", `/turns/${t2.id}`)).status, "done");
  assert.deepEqual((await ok<Any>("GET", `/entries/${dup.id}`)).entities.map((e: Any) => e.name), ["PostgreSQL"]);
});

test("an add repeated within the same batch is skipped without a duplicate provenance row for its own turn", async () => {
  const p = await proj();
  llmReply({
    ops: [
      { op: "add", scope: "project", title: "Port", body: "server listens on 8765" },
      { op: "add", scope: "project", title: "port", body: "server  listens on 8765" },
    ],
  });
  const t = await turn([{ role: "user", text: "the server listens on port 8765" }, { role: "assistant", text: "ok" }], p);
  await runQueueOnce();
  const done = await ok<Any>("GET", `/turns/${t.id}`);
  assert.equal(done.status, "done");
  assert.equal(done.result.applied.length, 1);
  const id = done.result.applied[0].entryId;
  assert.deepEqual(done.result.skipped, [{ op: "add", title: "port", reason: "duplicate", entryId: id }]);
  assert.deepEqual(rows(t.id), [[id, "add"]]);
});
