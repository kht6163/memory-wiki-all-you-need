// Project description as framing: the human-edited description is the first
// line of <project-memory> in the stable block (G-005 still holds) and frames the
// curation, review and wiki compose prompts. PATCH /projects/:id bounds and scans it.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

process.env.CONTEXT_BUDGET_CHARS = "400";

const { call, db, entry, llmCalls, llmReply, llmReset, ok, project, runQueueOnce, turn } = await import("./helpers.ts");

type Any = any;
let seq = 0;
async function proj() {
  seq++;
  return project(`github.com/test/desc-${seq}`, `desc-${seq}`);
}
const ctx = (p: { key: string; name: string }, prompt: string) => ok<Any>("POST", "/context", { project: { key: p.key, name: p.name }, prompt });
const describe = (id: number, description: string) => ok<Any>("PATCH", `/projects/${id}`, { description });
const projectSection = (system: string) => /<project-memory[^>]*>\n([\s\S]*?)\n<\/project-memory>/.exec(system)?.[1] ?? null;

beforeEach(() => llmReset());

test("PATCH /projects/:id trims the description, caps it at 500 (400) and rejects secrets (422)", async () => {
  const p = await proj();
  const r = await describe(p.id, "  billing service for the shop  ");
  assert.equal(r.description, "billing service for the shop");
  assert.equal(r.name, p.name, "name is kept when only the description changes");

  assert.equal((await call("PATCH", `/projects/${p.id}`, { description: "x".repeat(501) })).status, 400);
  assert.equal((await describe(p.id, "y".repeat(500))).description.length, 500);

  const bad = await call("PATCH", `/projects/${p.id}`, { description: "uses key sk-" + "abcdefghijklmnopqrstuvwxyz0123456789" });
  assert.equal(bad.status, 422);
  assert.equal((await ok<Any>("GET", `/projects/${p.id}`)).description, "y".repeat(500), "rejected edits change nothing");

  // A name-only patch keeps the description.
  await ok("PATCH", `/projects/${p.id}`, { name: "renamed" });
  assert.equal((await ok<Any>("GET", `/projects/${p.id}`)).description, "y".repeat(500));
});

test("the description is the first line of <project-memory>, even with no project memories", async () => {
  const p = await proj();
  assert.equal(projectSection((await ctx(p, "")).system), null, "no description, no memories → no section");

  await describe(p.id, "Payments gateway written in Go");
  let sys = (await ctx(p, "")).system;
  assert.equal(projectSection(sys), "About this project: Payments gateway written in Go");

  const m = await entry({ project_id: p.id, title: "retries use backoff" });
  sys = (await ctx(p, "")).system;
  const lines = projectSection(sys)!.split("\n");
  assert.equal(lines[0], "About this project: Payments gateway written in Go");
  assert.ok(lines[1].startsWith(`- [#${m.id}]`));

  // Clearing it removes the line.
  await describe(p.id, "");
  assert.ok(!(await ctx(p, "")).system.includes("About this project"));
});

test("G-005: with a description the system block is still identical across prompts", async () => {
  const p = await proj();
  await describe(p.id, "Inventory sync daemon");
  await entry({ project_id: p.id, title: "sync runs hourly" });
  const a = await ctx(p, "how often does sync run?");
  const b = await ctx(p, "something unrelated entirely");
  const c = await ctx(p, "");
  assert.ok(a.system.includes("About this project: Inventory sync daemon"));
  assert.equal(b.system, a.system);
  assert.equal(c.system, a.system);
});

test("the description counts against the project share of the budget", async () => {
  // 400 budget: user share (80, empty) carries into project (200) = 280.
  const p = await proj();
  const mem = await entry({ project_id: p.id, title: "cache layer note", body: ".".repeat(80) });
  assert.ok((await ctx(p, "")).system.includes(`[#${mem.id}]`), "fits without a description");
  await describe(p.id, `Edge cache ${".".repeat(240)}`);
  const sys = (await ctx(p, "")).system;
  assert.ok(sys.includes("About this project: Edge cache"));
  assert.ok(!sys.includes(`[#${mem.id}]`), "memory no longer fits next to the description");
  assert.match(projectSection(sys)!, /\(1 more not shown/);
});

test("curation prompt: CURRENT PROJECT carries the description, truncated to 300 chars", async () => {
  const p = await proj();
  await describe(p.id, `Mobile app backend ${"z".repeat(400)}`);
  llmReply({ ops: [], note: "nothing" });
  const t = await turn([{ role: "user", text: "we decided to deploy the backend with docker compose from now on" }, { role: "assistant", text: "noted, compose it is" }], p);
  await runQueueOnce();
  assert.equal((await ok<Any>("GET", `/turns/${t.id}`)).status, "done");
  assert.equal(llmCalls.length, 1);
  const line = llmCalls[0].user.split("\n").find((l) => l.startsWith("CURRENT PROJECT:"))!;
  assert.ok(line.startsWith(`CURRENT PROJECT: ${p.name} (${p.key}) — Mobile app backend z`));
  assert.ok(line.endsWith("…"));
  assert.equal(line.length, `CURRENT PROJECT: ${p.name} (${p.key}) — `.length + 300 + 1);

  // Without a description the line is unchanged.
  const q = await proj();
  llmReply({ ops: [], note: "nothing" });
  await turn([{ role: "user", text: "we decided to deploy the backend with docker compose from now on" }, { role: "assistant", text: "noted, compose it is" }], q);
  await runQueueOnce();
  assert.ok(llmCalls[1].user.split("\n").includes(`CURRENT PROJECT: ${q.name} (${q.key})`));
});

test("review prompt of a project review shows the project with its description", async () => {
  const p = await proj();
  await describe(p.id, "Search indexer");
  await entry({ project_id: p.id, title: "indexer uses bm25" });
  await entry({ project_id: p.id, title: "indexer batches by 100" });
  const job = await ok<Any>("POST", "/review", { project_id: p.id });
  llmReply({ proposals: [] });
  await runQueueOnce();
  const j = (await ok<Any[]>("GET", "/review/jobs?limit=100")).find((x) => x.id === job.id);
  assert.equal(j.status, "done");
  const review = llmCalls.find((c) => c.user.includes("MEMORIES:"))!;
  assert.ok(review.user.split("\n").includes(`PROJECT: ${p.name} (${p.key}) — Search indexer`));
});

test("wiki compose prompt header shows the project description", async () => {
  const p = await proj();
  await describe(p.id, "Static site generator");
  llmReply({ ops: [], note: "nothing" });
  const t = await turn([{ role: "user", text: "we render markdown with remark" }, { role: "assistant", text: "noted" }], p);
  await runQueueOnce();
  const job = await ok<Any>("POST", "/wiki/compose", { project_id: p.id, turn_ids: [t.id] });
  llmReply({ pages: [] });
  await runQueueOnce();
  const j = (await ok<Any[]>("GET", "/wiki/jobs")).find((x) => x.id === job.id);
  assert.ok(j, "compose job exists");
  const compose = llmCalls.find((c) => c.user.startsWith("WIKI: "))!;
  assert.ok(compose, "compose call was made");
  assert.equal(compose.user.split("\n")[0], `WIKI: project wiki: ${p.name} (${p.key}) — Static site generator`);
});

// Rows written before PATCH bounded/scanned the description (or straight to the DB)
// must still be capped and redacted wherever the description is read.
const rawDescribe = (id: number, description: string) => db.prepare(`UPDATE projects SET description = ? WHERE id = ?`).run(description, id);

test("legacy over-long description is capped at 500 chars in the stable block", async () => {
  const p = await proj();
  rawDescribe(p.id, `Legacy ${"q".repeat(5000)}`);
  const lead = projectSection((await ctx(p, "")).system)!.split("\n")[0];
  assert.equal(lead, `About this project: ${`Legacy ${"q".repeat(5000)}`.slice(0, 500)}`);
});

test("legacy description with a secret is redacted in the block and in the curation prompt", async () => {
  const p = await proj();
  const key = "sk-" + "abcdefghijklmnopqrstuvwxyz0123456789";
  rawDescribe(p.id, `Deploy bot, uses ${key} for the API`);
  const sys = (await ctx(p, "")).system;
  assert.ok(!sys.includes(key));
  assert.ok(sys.includes("About this project: Deploy bot, uses [REDACTED:openai-key] for the API"));

  llmReply({ ops: [], note: "nothing" });
  const t = await turn([{ role: "user", text: "we decided to deploy the backend with docker compose from now on" }, { role: "assistant", text: "noted, compose it is" }], p);
  await runQueueOnce();
  assert.equal((await ok<Any>("GET", `/turns/${t.id}`)).status, "done");
  const user = llmCalls.at(-1)!.user;
  assert.ok(!user.includes(key));
  assert.ok(user.split("\n").includes(`CURRENT PROJECT: ${p.name} (${p.key}) — Deploy bot, uses [REDACTED:openai-key] for the API`));
});
