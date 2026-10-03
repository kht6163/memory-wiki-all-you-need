// Memory validity (G-026): superseded and expired memories are history — kept,
// searchable on request, shown with their state — but never injected. Plus
// search keywords, the exact-duplicate guard, session candidates and the
// curation policy that ride turn curation.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { call, db, entry, llmCalls, llmReply, llmReset, ok, project, runQueueOnce, turn } from "./helpers.ts";

type Any = any;
let seq = 0;
async function proj() {
  seq++;
  return project(`github.com/test/validity-${seq}`, `validity-${seq}`);
}
const ctx = (p: { key: string; name: string }, prompt: string) => ok<Any>("POST", "/context", { project: { key: p.key, name: p.name }, prompt });
const link = (from: number, to: number, type: string) => ok("POST", `/entries/${from}/links`, { to, type });
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const blockIds = (system: string) => [...system.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));

beforeEach(() => llmReset());

test("G-026: a superseded memory leaves the prompt block, stays listed with its state, and returns when the new one is deleted", async () => {
  const p = await proj();
  const oldM = await entry({ project_id: p.id, title: "builds use webpack", body: "webpack.config.js at root" });
  const newM = await entry({ project_id: p.id, title: "builds use vite", body: "since the migration" });
  assert.ok(blockIds((await ctx(p, "")).system).includes(oldM.id));
  await link(newM.id, oldM.id, "supersedes");

  const sys = (await ctx(p, "")).system;
  assert.ok(!blockIds(sys).includes(oldM.id), "superseded memory is not injected");
  assert.ok(blockIds(sys).includes(newM.id));
  const d = await ok<Any>("GET", `/entries/${oldM.id}`);
  assert.equal(d.entry.superseded_by, newM.id);
  assert.equal(d.entry.expired, false);
  const listed = (await ok<Any[]>("GET", `/entries?project_id=${p.id}`)).find((e) => e.id === oldM.id);
  assert.equal(listed.superseded_by, newM.id, "lists carry the state");

  // Default search hides history; inactive=1 shows it.
  assert.ok(!(await ok<Any[]>("GET", `/search?q=webpack&project_id=${p.id}`)).some((e) => e.id === oldM.id));
  const hist = (await ok<Any[]>("GET", `/search?q=webpack&project_id=${p.id}&inactive=1`)).find((e) => e.id === oldM.id);
  assert.equal(hist.superseded_by, newM.id);

  // The replacement is soft-deleted: the old memory is current again (G-017: edges of deleted memories are hidden).
  await ok("DELETE", `/entries/${newM.id}`);
  assert.ok(blockIds((await ctx(p, "")).system).includes(oldM.id));
  assert.equal((await ok<Any>("GET", `/entries/${oldM.id}`)).entry.superseded_by, null);
  // Removing the link also restores it.
  await ok("POST", `/entries/${newM.id}/restore`);
  assert.ok(!blockIds((await ctx(p, "")).system).includes(oldM.id));
  await ok("DELETE", `/entries/${newM.id}/links?to=${oldM.id}&type=supersedes`);
  assert.ok(blockIds((await ctx(p, "")).system).includes(oldM.id));
});

test("G-026: an expired memory (valid_until before today, UTC) is not injected or recalled; today still counts", async () => {
  const p = await proj();
  const past = await entry({ project_id: p.id, title: "freeze on main branch", body: "no merges", valid_until: day(-1) } as Any);
  const today = await entry({ project_id: p.id, title: "release freeze today", body: "last day", valid_until: day(0) } as Any);
  const sys = (await ctx(p, "")).system;
  assert.ok(!blockIds(sys).includes(past.id));
  assert.ok(blockIds(sys).includes(today.id));
  assert.equal((await ok<Any>("GET", `/entries/${past.id}`)).entry.expired, true);
  const r = await ctx(p, "is there a freeze on main?");
  assert.ok(!r.recalled.includes(past.id));
  // Extending the date makes it current again.
  await ok("PATCH", `/entries/${past.id}`, { valid_until: day(3) });
  assert.ok(blockIds((await ctx(p, "")).system).includes(past.id));
  await ok("PATCH", `/entries/${past.id}`, { valid_until: null });
  assert.equal((await ok<Any>("GET", `/entries/${past.id}`)).entry.valid_until, null);
});

test("valid_until must be a real calendar date", async () => {
  for (const bad of ["2026-02-30", "tomorrow", "2026-1-5", "2026-10-02T00:00:00Z"]) {
    assert.equal((await call("POST", "/entries", { scope: "global", title: `bad date ${bad}`, valid_until: bad })).status, 400, bad);
  }
});

test("keywords make a memory findable by other words but are never injected", async () => {
  const p = await proj();
  const e = await entry({ project_id: p.id, title: "DB는 포스트그레스 16", body: "도커로 띄움", keywords: ["PostgreSQL", "postgres", "Postgres", "pg"] } as Any);
  assert.deepEqual((await ok<Any>("GET", `/entries/${e.id}`)).entry.keywords, ["PostgreSQL", "postgres", "pg"], "deduplicated case-insensitively");
  const hits = await ok<Any[]>("GET", `/search?q=${encodeURIComponent("postgresql settings")}&project_id=${p.id}`);
  assert.equal(hits[0]?.id, e.id, "found through a keyword (FTS)");
  const short = await ok<Any[]>("GET", `/search?q=pg&project_id=${p.id}`);
  assert.ok(short.some((h) => h.id === e.id), "short keyword found through LIKE");
  const sys = (await ctx(p, "")).system;
  assert.ok(sys.includes("포스트그레스"));
  assert.ok(!/PostgreSQL/.test(sys), "keywords are not part of the injected text");
  // Secrets in keywords are rejected like in tags.
  assert.equal((await call("PATCH", `/entries/${e.id}`, { keywords: ["sk-" + "abcdefghijklmnopqrstuvwxyz123456"] })).status, 422);
  // A long secret is caught before keywords are cut to 60 characters.
  const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.${"x".repeat(43)}`;
  assert.equal((await call("PATCH", `/entries/${e.id}`, { keywords: [jwt] })).status, 422);
});

test("revert restores keywords and valid_until from a revision", async () => {
  const e = await entry({ title: "revert kw", keywords: ["alpha"], valid_until: day(10) } as Any);
  const revs = (await ok<Any>("GET", `/entries/${e.id}`)).revisions;
  await ok("PATCH", `/entries/${e.id}`, { keywords: ["beta"], valid_until: null });
  await ok("POST", `/entries/${e.id}/revert`, { revisionId: revs[0].id });
  const after = (await ok<Any>("GET", `/entries/${e.id}`)).entry;
  assert.deepEqual(after.keywords, ["alpha"]);
  assert.equal(after.valid_until, day(10));
});

test("curation: add with keywords and valid_until; a malformed date is dropped, not the op", async () => {
  const p = await proj();
  llmReply({
    ops: [
      { op: "add", scope: "project", title: "temp proxy workaround", body: "until upstream fix", keywords: ["프록시 우회"], valid_until: day(30) },
      { op: "add", scope: "project", title: "nightly runs at 2am", body: "cron", valid_until: "next week" },
    ],
  });
  const t = await turn([{ role: "user", text: "we use a temp proxy workaround until the upstream fix ships; nightly runs at 2am" }, { role: "assistant", text: "ok" }], p);
  await runQueueOnce();
  const r = await ok<Any>("GET", `/turns/${t.id}`);
  assert.equal(r.result.applied.length, 2);
  const [a, b] = await Promise.all(r.result.applied.map((x: Any) => ok<Any>("GET", `/entries/${x.entryId}`)));
  assert.deepEqual(a.entry.keywords, ["프록시 우회"]);
  assert.equal(a.entry.valid_until, day(30));
  assert.equal(b.entry.valid_until, null);
});

test("curation: an add identical to a live memory in the same scope is skipped and reported", async () => {
  const p = await proj();
  const existing = await entry({ project_id: p.id, title: "Tests run with node --test", body: "npm test   runs   them" });
  const before = Number((db.prepare("SELECT COUNT(*) AS n FROM entries").get() as Any).n);
  llmReply({
    ops: [
      { op: "add", scope: "project", title: "tests run with node --test", body: "npm test runs them" },
      { op: "add", scope: "global", title: "Tests run with node --test", body: "npm test runs them" },
    ],
  });
  const t = await turn([{ role: "user", text: "how do tests run here? node --test via npm test" }, { role: "assistant", text: "yes" }], p);
  await runQueueOnce();
  const r = await ok<Any>("GET", `/turns/${t.id}`);
  assert.deepEqual(r.result.skipped, [{ op: "add", title: "tests run with node --test", reason: "duplicate", entryId: existing.id }]);
  assert.equal(r.result.applied.length, 1, "same text in another scope is not a duplicate");
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM entries").get() as Any).n), before + 1);

  // Title spacing / non-ASCII case differences are still duplicates.
  const ko = await entry({ project_id: p.id, title: "Ünïcode  배포  규칙", body: "본문" });
  llmReply({ ops: [{ op: "add", scope: "project", title: "ünïcode 배포 규칙", body: "본문" }] });
  const t2 = await turn([{ role: "user", text: "유니코드 배포 규칙을 다시 한 번 정리하면 이렇습니다" }, { role: "assistant", text: "ok" }], p);
  await runQueueOnce();
  assert.equal((await ok<Any>("GET", `/turns/${t2.id}`)).result.skipped?.[0]?.entryId, ko.id);
});

test("curation: re-adding a fact whose only copy is expired creates a new current memory", async () => {
  const p = await proj();
  const old = await entry({ project_id: p.id, title: "code freeze", body: "no merges to main", valid_until: day(-3) } as Any);
  llmReply({ ops: [{ op: "add", scope: "project", title: "code freeze", body: "no merges to main", valid_until: day(5) }] });
  const t = await turn([{ role: "user", text: "code freeze again until next week: no merges to main" }, { role: "assistant", text: "ok" }], p);
  await runQueueOnce();
  const r = await ok<Any>("GET", `/turns/${t.id}`);
  assert.equal(r.result.skipped, undefined);
  assert.equal(r.result.applied.length, 1);
  assert.notEqual(r.result.applied[0].entryId, old.id);
  assert.ok(blockIds((await ctx(p, "")).system).includes(r.result.applied[0].entryId));
});

test("curation: memories written by earlier turns of the same session are candidates", async () => {
  const p = await proj();
  let firstId = 0;
  llmReply({ ops: [{ op: "add", scope: "project", title: "zanzibar cache warmup", body: "warm on boot" }] });
  await turn([{ role: "user", text: "the zanzibar cache must be warmed on boot" }, { role: "assistant", text: "noted" }], p, "sess-recent");
  await runQueueOnce();
  firstId = Number((db.prepare("SELECT MAX(id) AS m FROM entries").get() as Any).m);
  // Push it out of the "latest 15 project memories" list and away from keyword search.
  for (let i = 0; i < 16; i++) await entry({ project_id: p.id, title: `filler ${i}` });
  llmReply((c: Any) => {
    assert.match(c.user, new RegExp(`"id":${firstId},`), "the session's earlier memory is shown");
    return { ops: [] };
  });
  const t2 = await turn([{ role: "user", text: "completely different wording here" }, { role: "assistant", text: "ok" }], p, "sess-recent");
  await runQueueOnce();
  assert.equal(llmCalls.length, 2);
  // Assertions inside the fake LLM throw into the worker: the turn would be "error".
  assert.equal((await ok<Any>("GET", `/turns/${t2.id}`)).status, "done");
});

test("curation policy: human-only text reaches the curation prompt; global first, then the project", async () => {
  const p = await proj();
  assert.deepEqual(await ok("GET", "/policy"), { project_id: null, text: "", updated_at: null });
  await ok("PUT", "/policy", { text: "Always record port numbers." });
  await ok("PUT", "/policy", { project_id: p.id, text: "Do not remember test fixture names." });
  assert.equal((await ok<Any>("GET", `/policy?project_id=${p.id}`)).text, "Do not remember test fixture names.");
  assert.equal((await call("PUT", "/policy", { text: "token sk-" + "abcdefghijklmnopqrstuvwxyz123456" })).status, 422);
  assert.equal((await call("PUT", "/policy", { project_id: 999999, text: "x" })).status, 404);
  llmReply((c: Any) => {
    const i = c.user.indexOf("POLICY");
    assert.ok(i > 0, "policy block present");
    const block = c.user.slice(i);
    assert.ok(block.indexOf("Always record port numbers.") < block.indexOf("Do not remember test fixture names."));
    return { ops: [] };
  });
  const t = await turn([{ role: "user", text: "the api listens on 8080 now" }, { role: "assistant", text: "ok" }], p);
  await runQueueOnce();
  assert.equal(llmCalls.length, 1);
  assert.equal((await ok<Any>("GET", `/turns/${t.id}`)).status, "done");
  // Clearing removes it; deleting the project removes its policy row.
  await ok("PUT", "/policy", { text: "" });
  assert.equal((await ok<Any>("GET", "/policy")).text, "");
  await ok("DELETE", `/projects/${p.id}`);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM curation_policies WHERE project_id = ?").get(p.id) as Any).n), 0);
});

test("G-026: a memory only retires one it is visible with; cycles are refused", async () => {
  const p1 = await proj();
  const p2 = await proj();
  const g = await entry({ title: "globally use pnpm" });
  const inP1 = await entry({ project_id: p1.id, title: "p1 uses pnpm workspaces" });
  const inP2 = await entry({ project_id: p2.id, title: "p2 uses yarn" });
  // Project memory over a global one, or over another project's: refused.
  assert.equal((await call("POST", `/entries/${inP2.id}/links`, { to: g.id, type: "supersedes" })).status, 400);
  assert.equal((await call("POST", `/entries/${inP2.id}/links`, { to: inP1.id, type: "supersedes" })).status, 400);
  // Global over project is fine (the global one is visible there).
  await link(g.id, inP1.id, "supersedes");
  assert.ok(!blockIds((await ctx(p1, "")).system).includes(inP1.id));
  // Cycle: g cannot be superseded back by what it retired, directly or through a chain.
  const g2 = await entry({ title: "globally use bun" });
  await link(g2.id, g.id, "supersedes");
  assert.equal((await call("POST", `/entries/${g.id}/links`, { to: g2.id, type: "supersedes" })).status, 409);
  const g3 = await entry({ title: "globally use deno" });
  await link(g3.id, g2.id, "supersedes");
  assert.equal((await call("POST", `/entries/${g.id}/links`, { to: g3.id, type: "supersedes" })).status, 409);
  await ok("DELETE", `/entries/${g3.id}/links?to=${g2.id}&type=supersedes`);

  // Links written before these checks (or by hand) do not retire anything they should not.
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author) VALUES (?, ?, 'supersedes', 'llm')`).run(inP2.id, g2.id);
  assert.ok(blockIds((await ctx(p1, "")).system).includes(g2.id), "cross-project link does not hide a global memory");
  assert.equal((await ok<Any>("GET", `/entries/${g2.id}`)).entry.superseded_by, null);
  const a = await entry({ project_id: p2.id, title: "cycle a" });
  const b = await entry({ project_id: p2.id, title: "cycle b" });
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author) VALUES (?, ?, 'supersedes', 'llm'), (?, ?, 'supersedes', 'llm')`).run(a.id, b.id, b.id, a.id);
  const ids = blockIds((await ctx(p2, "")).system);
  assert.ok(ids.includes(a.id) && ids.includes(b.id), "a two-way cycle retires neither");
});

test("review scope summary, stale list and review input leave superseded memories out; entity pages show state", async () => {
  const p = await proj();
  const oldM = await entry({ project_id: p.id, title: "lint with eslint", entities: ["Linter Thing"] });
  const newM = await entry({ project_id: p.id, title: "lint with biome", entities: ["Linter Thing"] });
  await link(newM.id, oldM.id, "supersedes");
  db.prepare("UPDATE entries SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id IN (?, ?)").run(oldM.id, newM.id);
  assert.equal((await ok<Any>("GET", `/review/scope?project_id=${p.id}`)).entries, 1);
  const stale = await ok<Any[]>("GET", `/review/stale?project_id=${p.id}`);
  assert.deepEqual(stale.map((e) => e.id), [newM.id]);
  assert.equal((await call("POST", "/review", { project_id: p.id })).status, 400, "one current memory is not enough to review");
  const ent = (await ok<Any>("GET", `/entries/${oldM.id}`)).entities[0];
  const page = await ok<Any>("GET", `/entities/${ent.id}`);
  assert.equal(page.memories.find((m: Any) => m.id === oldM.id).superseded_by, newM.id);
});

test("G-026: a supersedes link made before v0.6 (retires = 0) keeps its target; making it again retires it", async () => {
  const p = await proj();
  const oldM = await entry({ project_id: p.id, title: "deploys go through jenkins" });
  const newM = await entry({ project_id: p.id, title: "deploys go through github actions" });
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', 'llm', 0)`).run(newM.id, oldM.id);
  assert.ok(blockIds((await ctx(p, "")).system).includes(oldM.id), "legacy link is informational");
  await link(newM.id, oldM.id, "supersedes");
  assert.ok(!blockIds((await ctx(p, "")).system).includes(oldM.id));
});
