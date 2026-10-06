// Skills mirrored from the server to the PC (ADR-0039, G-068): one way only,
// global and project folders apart, read by pi's own skill loader without
// warnings, kept when the server is down, refreshed by /skills-sync.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { loadExtension, makeCtx, quietErrors, startMockServer, type FakeCtx, type FakePi, type MockServer } from "./X-ext-harness.ts";

const KEY = "github.com/test/skills-app";
let srv: MockServer;
let pi: FakePi;
let ctx: FakeCtx;
let cwd: string;
let agentDir: string;
let skillsMod: typeof import("../../pi-extension/skills.ts");

type Payload = { global: unknown[]; project: { key: string; name: string; skills: unknown[] } | null };
let payload: Payload;
const sk = (name: string, description = `Use for ${name}`, body = `## Steps\n1. do ${name}`) => ({ name, description, body, updated_at: "2026-10-06T00:00:00Z" });

const root = () => path.join(agentDir, "extensions", "memory-wiki-all-you-need", "skills");
const discover = () => pi.emit("resources_discover", { type: "resources_discover", cwd, reason: "startup" }, ctx) as Promise<{ skillPaths: string[] } | undefined>;
const loaded = (paths: string[]) => loadSkills({ cwd, agentDir, skillPaths: paths, includeDefaults: false });
const syncRequests = () => srv.requests.filter((r) => r.path.startsWith("/api/skills"));
const resetSyncedAt = () => void ((globalThis as { __memoryWikiSkillsSyncedAt?: number }).__memoryWikiSkillsSyncedAt = 0);

before(async () => {
  srv = await startMockServer();
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwayn-skills-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.MEMORY_SERVER_URL = srv.url;
  process.env.MEMORY_TIMEOUT_MS = "800";
  process.env.MEMORY_SETTLE_DELAY_MS = "60000";
  process.env.MEMORY_PROJECT = KEY;
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mwayn-skills-cwd-"));
  srv.routes.set("/api/skills/sync", () => payload);
  pi = await loadExtension();
  skillsMod = await import("../../pi-extension/skills.ts");
  ctx = makeCtx(cwd);
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
});

after(async () => {
  await srv.close();
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

beforeEach(() => {
  srv.mode = "ok";
  srv.requests.length = 0;
  resetSyncedAt();
  payload = { global: [sk("release-notes"), sk("deploy")], project: { key: KEY, name: "skills-app", skills: [sk("deploy", "Deploy this app", "## Project deploy")] } };
});

test("ADR-0039: on pi start the extension fetches GET /api/skills/sync?project=<key> and writes global and project folders apart", async () => {
  const r = await discover();
  assert.equal(syncRequests().length, 1);
  assert.equal(syncRequests()[0].method, "GET");
  assert.equal(new URL(syncRequests()[0].path, "http://x").searchParams.get("project"), KEY);
  const gDir = skillsMod.globalSkillsDir(root());
  const pDir = skillsMod.projectSkillsDir(root(), KEY);
  assert.deepEqual(fs.readdirSync(gDir).sort(), ["deploy", "release-notes"]);
  assert.deepEqual(fs.readdirSync(pDir), ["deploy"]);
  assert.ok(pDir.startsWith(path.join(root(), "project") + path.sep));
  // The project's "deploy" wins: the global one is not handed to pi.
  assert.deepEqual(r?.skillPaths, [path.join(pDir, "deploy", "SKILL.md"), path.join(gDir, "release-notes", "SKILL.md")]);
});

test("ADR-0039: pi's own loader reads the synced files with no warnings or name collisions", async () => {
  payload.global.push(sk("tricky", 'Has "quotes", a colon: and\n--- a fake fence\nover lines', "body\n---\nnot frontmatter"));
  const r = await discover();
  const res = loaded(r!.skillPaths);
  assert.deepEqual(res.diagnostics, []);
  const byName = new Map(res.skills.map((s) => [s.name, s]));
  assert.deepEqual([...byName.keys()].sort(), ["deploy", "release-notes", "tricky"]);
  assert.equal(byName.get("deploy")!.description, "Deploy this app");
  assert.equal(byName.get("tricky")!.description, 'Has "quotes", a colon: and --- a fake fence over lines');
  const text = fs.readFileSync(byName.get("tricky")!.filePath, "utf8");
  assert.match(text, /Local edits are overwritten on the next sync/);
  assert.match(text, /body\n---\nnot frontmatter/);
});

test("G-068: one way — a local edit is overwritten, a local addition is removed, and nothing is ever sent to the server", async () => {
  await discover();
  const gDir = skillsMod.globalSkillsDir(root());
  const file = path.join(gDir, "release-notes", "SKILL.md");
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, `${original}\nLOCAL EDIT`);
  fs.mkdirSync(path.join(gDir, "my-local"));
  fs.writeFileSync(path.join(gDir, "my-local", "SKILL.md"), "---\nname: my-local\ndescription: mine\n---\nx");
  resetSyncedAt();
  await discover();
  assert.equal(fs.readFileSync(file, "utf8"), original, "edit overwritten");
  assert.equal(fs.existsSync(path.join(gDir, "my-local")), false, "local addition removed");
  assert.ok(
    srv.requests.every((r) => r.method === "GET"),
    `only GETs: ${srv.requests.map((r) => `${r.method} ${r.path}`).join(", ")}`,
  );
  assert.ok(srv.requests.every((r) => r.body === undefined));
});

test("G-068: a skill deleted on the server disappears from the PC; an empty server list empties the folders", async () => {
  await discover();
  payload.global = [sk("deploy")];
  resetSyncedAt();
  let r = await discover();
  assert.deepEqual(fs.readdirSync(skillsMod.globalSkillsDir(root())), ["deploy"]);
  payload = { global: [], project: { key: KEY, name: "skills-app", skills: [] } };
  resetSyncedAt();
  r = await discover();
  assert.equal(r, undefined, "no skills → nothing handed to pi");
  assert.deepEqual(fs.readdirSync(skillsMod.globalSkillsDir(root())), []);
  assert.deepEqual(fs.readdirSync(skillsMod.projectSkillsDir(root(), KEY)), []);
});

test("G-068: server down, erroring or too old (404) → the last synced skills stay and are still handed to pi", async () => {
  const first = await discover();
  for (const mode of ["error500", "hang"] as const) {
    srv.mode = mode;
    resetSyncedAt();
    const t0 = Date.now();
    const { result: r, logged } = await quietErrors(discover);
    assert.deepEqual(r?.skillPaths, first?.skillPaths, mode);
    assert.ok(Date.now() - t0 < 3000, `${mode} bounded by the timeout`);
    assert.match(logged.join("\n"), /skills not synced, using the last copy/);
  }
  srv.mode = "ok";
  srv.routes.delete("/api/skills/sync"); // old server: the mock answers {} for unknown paths
  resetSyncedAt();
  const old = await quietErrors(discover);
  srv.routes.set("/api/skills/sync", () => payload);
  assert.deepEqual(old.result?.skillPaths, first?.skillPaths, "an answer without skill lists must not wipe the cache");
  await srv.stop();
  resetSyncedAt();
  const down = await quietErrors(discover);
  await srv.restart();
  assert.deepEqual(down.result?.skillPaths, first?.skillPaths, "connection refused");
});

test("ADR-0039: names pi would reject, and repeats, are never written", async () => {
  payload.global = [sk("Bad Name"), sk("-x"), sk("ok-one"), sk("ok-one", "second"), { name: "nodesc", description: " ", body: "b" }, sk("a".repeat(65))];
  const r = await discover();
  assert.deepEqual(fs.readdirSync(skillsMod.globalSkillsDir(root())), ["ok-one"]);
  assert.deepEqual(loaded(r!.skillPaths).diagnostics, []);
});

test("ADR-0039: /skills-sync syncs, reports counts and removals, reloads pi, and the reload does not fetch again", async () => {
  await discover();
  payload.global = [sk("release-notes"), sk("new-one")];
  ctx.notices.length = 0;
  ctx.reloads = 0;
  srv.requests.length = 0;
  await pi.commands.get("skills-sync")!.handler("", ctx);
  assert.equal(syncRequests().length, 1);
  assert.equal(ctx.reloads, 1);
  const msg = ctx.notices.at(-1)!.msg;
  assert.match(msg, /2 global · 1 for github\.com\/test\/skills-app/);
  assert.match(msg, /removed global:deploy/);
  // pi's reload fires resources_discover: served from disk, no second fetch.
  const r = await discover();
  assert.equal(syncRequests().length, 1);
  assert.ok(r?.skillPaths.some((p) => p.endsWith(path.join("new-one", "SKILL.md"))));
  // Disk already matches (e.g. another pi process synced it): still reload, this session may hold an older set.
  resetSyncedAt();
  await pi.commands.get("skills-sync")!.handler("", ctx);
  assert.equal(ctx.reloads, 2);
  assert.match(ctx.notices.at(-1)!.msg, /\(no change\)/);
});

test("ADR-0039: /skills-sync while pi is busy asks to wait and touches nothing (pi would skip the reload)", async () => {
  await discover();
  srv.requests.length = 0;
  ctx.reloads = 0;
  const busy = Object.assign(Object.create(ctx), { isIdle: () => false });
  await pi.commands.get("skills-sync")!.handler("", busy);
  assert.equal(syncRequests().length, 0);
  assert.equal(ctx.reloads, 0);
  assert.match(ctx.notices.at(-1)!.msg, /wait for the current response/);
});

test("ADR-0039: /skills-sync with the server down says so and keeps the skills", async () => {
  await discover();
  const before = fs.readdirSync(skillsMod.globalSkillsDir(root())).sort();
  srv.mode = "error500";
  ctx.reloads = 0;
  await pi.commands.get("skills-sync")!.handler("", ctx);
  assert.equal(ctx.notices.at(-1)!.level, "error");
  assert.match(ctx.notices.at(-1)!.msg, /last synced skills stay in use/);
  assert.equal(ctx.reloads, 0);
  assert.deepEqual(fs.readdirSync(skillsMod.globalSkillsDir(root())).sort(), before);
});

test("ADR-0039: project folders are per key and filesystem-safe; another project's skills are not handed to pi", () => {
  const a = skillsMod.projectSkillsDir("/r", "github.com/a/b");
  const b = skillsMod.projectSkillsDir("/r", "github.com_a/b");
  assert.notEqual(a, b, "keys that clean up alike stay apart");
  assert.match(path.basename(a), /^github\.com_a_b-[0-9a-f]{8}$/);
  assert.match(path.basename(skillsMod.projectSkillsDir("/r", "../..")), /^project-[0-9a-f]{8}$/);
  // Another project's folder on disk is ignored.
  const other = skillsMod.projectSkillsDir(root(), "github.com/test/other");
  fs.mkdirSync(path.join(other, "secret-proc"), { recursive: true });
  fs.writeFileSync(path.join(other, "secret-proc", "SKILL.md"), "---\nname: secret-proc\ndescription: x\n---\nx");
  assert.ok(skillsMod.skillPaths(root(), KEY).every((p) => !p.includes("secret-proc")));
});

// ------------------------------------------------- change notice, skill_manage, nudge

const startRun = (prompt = "go") => pi.emit("before_agent_start", { type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: {} }, ctx) as Promise<{ message?: { content: string } } | undefined>;
const settle = () => pi.emit("agent_settled", { type: "agent_settled" }, ctx);
const toolCalls = (names: string[]) => pi.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "working" }, ...names.map((name) => ({ type: "toolCall", name, arguments: {} }))] } }, ctx);
let serverVersion = "";
const skillNotices = () => ctx.notices.filter((n) => /skills changed/.test(n.msg));

test("ADR-0039: the server's skills changed → told once per version and in the status line; /skills-sync clears it", async () => {
  srv.routes.set("/api/context", () => ({ system: "S", recall: "", skillsVersion: serverVersion }));
  payload = { ...payload, version: "v1" } as Payload;
  serverVersion = "v1";
  await discover();
  ctx.notices.length = 0;
  await startRun();
  assert.equal(skillNotices().length, 0, "same version: nothing to say");
  serverVersion = "v2"; // someone saved a skill on the web
  await startRun();
  await startRun();
  assert.equal(skillNotices().length, 1, "once per version");
  assert.match(skillNotices()[0].msg, /run \/skills-sync/);
  assert.match(ctx.status.at(-1)!, /skills changed: \/skills-sync/);
  payload = { ...payload, version: "v2" } as Payload;
  await pi.commands.get("skills-sync")!.handler("", ctx);
  await discover(); // what pi's reload does
  await startRun();
  assert.doesNotMatch(ctx.status.at(-1)!, /skills changed/);
  assert.equal(skillNotices().length, 1);
  // An old server (no skillsVersion) never triggers it.
  srv.routes.set("/api/context", () => ({ system: "S", recall: "" }));
  await startRun();
  assert.equal(skillNotices().length, 1);
});

test("ADR-0039: skill_manage create posts to the server, mirrors it back, and is not reported as an outside change", async () => {
  const sent: any[] = [];
  srv.routes.set("/api/agent/skill", (req) => {
    sent.push(req.body);
    return { action: "create", skill: { scope: "project", name: "ship-it", description: "Ship it", author: "agent", updated_at: "2026-10-06T01:00:00Z" }, version: "v9", previous_version: "" };
  });
  srv.routes.set("/api/context", () => ({ system: "S", recall: "", skillsVersion: serverVersion }));
  await discover();
  payload.project!.skills.push(sk("ship-it", "Ship it"));
  (payload as any).version = "v9";
  serverVersion = "v9";
  ctx.notices.length = 0;
  srv.requests.length = 0;
  const tool = pi.tools.get("skill_manage")!;
  const r = await tool.execute(
    "t1",
    { action: "create", name: "ship-it", scope: "project", description: "Ship it", when_to_use: "When releasing", procedure_steps: ["test", "tag"], pitfalls: ["no force push"], verification_steps: ["CI green"] },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(sent[0].project.key, KEY);
  assert.equal(sent[0].scope, "project");
  assert.equal(sent[0].body, "## When to Use\nWhen releasing\n\n## Procedure\n1. test\n2. tag\n\n## Pitfalls\n- no force push\n\n## Verification\n1. CI green");
  assert.match(r.content[0].text, /created project:ship-it .* after \/skills-sync or in the next session/);
  assert.equal(syncRequests().length, 1, "mirrored back right away");
  assert.ok(fs.existsSync(path.join(skillsMod.projectSkillsDir(root(), KEY), "ship-it", "SKILL.md")));
  assert.match(ctx.notices.at(-1)!.msg, /skill saved: project:ship-it — run \/skills-sync/);
  await startRun();
  assert.equal(skillNotices().length, 0, "its own write is not an outside change");
  assert.match(ctx.status.at(-1)!, /skills changed: \/skills-sync/, "but the new skill still needs /skills-sync");
  // The agent then edits the skill it just made: still its own change, no notice.
  srv.routes.set("/api/agent/skill", () => ({ action: "update", skill: { scope: "project", name: "ship-it", description: "Ship it", author: "agent", updated_at: "2026-10-06T01:00:01Z" }, version: "v10", previous_version: "v9", changed: true }));
  (payload as any).version = "v10";
  serverVersion = "v10";
  await tool.execute("t1b", { action: "update", name: "ship-it", updated_at: "2026-10-06T01:00:00Z", body: "## better" }, undefined, undefined, ctx);
  await startRun();
  assert.equal(skillNotices().length, 0, "create then update: one change of its own");
  // No body at all: refused before any request.
  srv.requests.length = 0;
  const bad = await tool.execute("t2", { action: "create", name: "x", scope: "global", description: "d" }, undefined, undefined, ctx);
  assert.match(bad.content[0].text, /needs procedure_steps/);
  const noSteps = await tool.execute("t3", { action: "create", name: "x", scope: "global", description: "d", when_to_use: "w" }, undefined, undefined, ctx);
  assert.match(noSteps.content[0].text, /needs procedure_steps/);
  assert.equal(srv.requests.length, 0);
});

test("ADR-0039: skill_manage update — sends the body and updated_at, refuses partial sections, reports no-ops, hides only its own change", async () => {
  const sent: any[] = [];
  let reply: Record<string, unknown> = {};
  srv.routes.set("/api/agent/skill", (req) => (sent.push(req.body), reply));
  srv.routes.set("/api/context", () => ({ system: "S", recall: "", skillsVersion: serverVersion }));
  payload = { ...payload, version: "u1" } as Payload;
  serverVersion = "u1";
  await discover(); // this session loads u1
  const tool = pi.tools.get("skill_manage")!;
  const run = (p: Record<string, unknown>) => tool.execute("u", { action: "update", name: "deploy", ...p }, undefined, undefined, ctx).then((r: any) => r.content[0].text as string);
  // Partial structured sections would drop the rest of the body: refused, nothing sent.
  assert.match(await run({ updated_at: "T1", pitfalls: ["no force push"] }), /replaces the whole body.*Nothing was changed/);
  assert.match(await run({ updated_at: "T1" }), /needs a new body/);
  assert.equal(sent.length, 0);

  const skillT2 = { scope: "project", name: "deploy", description: "Deploy this app", author: "agent", updated_at: "T2" };
  reply = { action: "update", skill: skillT2, version: "u2", previous_version: "u1", changed: true };
  payload = { ...payload, version: "u2" } as Payload;
  serverVersion = "u2";
  ctx.notices.length = 0;
  srv.requests.length = 0;
  assert.match(await run({ updated_at: "T1", procedure_steps: ["a"] }), /^updated project:deploy \(updated_at T2\) .*The synced file is current\./);
  assert.equal(sent.at(-1).updated_at, "T1");
  assert.equal(sent.at(-1).body, "## Procedure\n1. a");
  assert.equal(syncRequests().length, 1);
  await startRun();
  assert.equal(skillNotices().length, 0, "a body edit is live: nothing to sync");
  assert.doesNotMatch(ctx.status.at(-1) ?? "", /skills changed/);

  // Someone else changed the skills too (previous_version is not what this session loaded): still reported.
  reply = { action: "update", skill: { ...skillT2, updated_at: "T3" }, version: "u4", previous_version: "u3", changed: true };
  payload = { ...payload, version: "u4" } as Payload;
  serverVersion = "u4";
  await run({ updated_at: "T2", body: "## new" });
  await startRun();
  assert.equal(skillNotices().length, 1, "the outside change is not hidden by this write");

  // Nothing changed on the server, and the mirror failing after a write.
  reply = { action: "update", skill: skillT2, version: "u4", previous_version: "u4", changed: false };
  assert.match(await run({ updated_at: "T2", body: "## same" }), /^no change: project:deploy/);
  reply = { action: "update", skill: { ...skillT2, updated_at: "T5" }, version: "u5", previous_version: "u4", changed: true };
  srv.routes.set("/api/skills/sync", () => ({})); // an answer without skill lists: the mirror refuses it
  const { result } = await quietErrors(() => run({ updated_at: "T2", body: "## later" }));
  srv.routes.set("/api/skills/sync", () => payload);
  assert.match(result, /The local copy refreshes on the next sync\./);
});

test("ADR-0039: skill_manage view and list show what the agent needs for an update (updated_at)", async () => {
  srv.routes.set("/api/agent/skill", (req) =>
    req.body.action === "list"
      ? { action: "list", skills: [{ scope: "global", name: "deploy", description: "Deploy", author: "human", updated_at: "T1" }] }
      : { action: "view", skill: { scope: "global", name: "deploy", description: "Deploy", body: "## Steps", author: "human", updated_at: "T1" } },
  );
  const tool = pi.tools.get("skill_manage")!;
  assert.equal((await tool.execute("a", { action: "list" }, undefined, undefined, ctx)).content[0].text, "global:deploy — Deploy (by human, updated_at T1)");
  assert.equal((await tool.execute("b", { action: "view", name: "deploy" }, undefined, undefined, ctx)).content[0].text, "global:deploy (by human, updated_at T1)\nDeploy\n\n## Steps");
});

test("ADR-0039: after a long, varied run with no skill_manage call, the next prompt carries a hidden skill hint (once)", async () => {
  srv.routes.set("/api/context", () => ({ system: "S", recall: "", skillsVersion: serverVersion }));
  await startRun();
  await toolCalls(["bash", "read", "edit", "bash"]);
  await toolCalls(["bash", "edit", "bash", "read"]);
  await settle();
  const next = await startRun("next");
  assert.match(next!.message!.content, /<skill-hint[^>]*>Your previous task took 8 tool calls \(bash, read, edit\)/);
  await settle();
  assert.equal(await startRun("again"), undefined, "only once");
  // Fewer calls, a single tool, or a run that already used skill_manage: no hint.
  for (const run of [["bash", "read"], Array(9).fill("bash"), [...Array(8).fill("bash"), "skill_manage"]]) {
    await toolCalls(run);
    await settle();
    assert.equal(await startRun(), undefined, run.join(","));
  }
  // skillNudge 0 turns it off.
  await pi.commands.get("memory-config")!.handler("skillNudge 0", ctx);
  await toolCalls([...Array(5).fill("bash"), ...Array(5).fill("read")]);
  await settle();
  assert.equal(await startRun(), undefined);
  await pi.commands.get("memory-config")!.handler("unset skillNudge", ctx);
});

test("ADR-0040: skill_manage — a candidate or a proposed edit is reported as waiting for approval, and nothing is mirrored", async () => {
  const tool = pi.tools.get("skill_manage")!;
  let reply: Record<string, unknown> = {};
  srv.routes.set("/api/agent/skill", () => reply);
  const base = { scope: "global", name: "g-proc", description: "G", author: "agent", updated_at: "T1" };
  reply = { action: "create", skill: { ...base, status: "candidate", locked: false, pending_edit: null }, version: "w1", previous_version: "w1" };
  ctx.notices.length = 0;
  srv.requests.length = 0;
  const c = (await tool.execute("c", { action: "create", name: "g-proc", scope: "global", description: "G", procedure_steps: ["a"] }, undefined, undefined, ctx)).content[0].text;
  assert.match(c, /as a candidate: it waits for a person to approve it .* Do not create it again\./);
  assert.equal(syncRequests().length, 0, "nothing new for this PC");
  assert.match(ctx.notices.at(-1)!.msg, /waiting for approval: global:g-proc/);
  reply = { action: "update", skill: { ...base, status: "active", pending_edit: { description: "G", body: "## new", at: "T2" } }, version: "w1", previous_version: "w1", changed: true, proposed: true };
  const u = (await tool.execute("u", { action: "update", name: "g-proc", updated_at: "T1", body: "## new" }, undefined, undefined, ctx)).content[0].text;
  assert.match(u, /^proposed an edit to global:g-proc: .*the current version stays in use/);
  assert.equal(syncRequests().length, 0);
  reply = { action: "view", skill: { ...base, body: "## old", status: "active", locked: true, pending_edit: { description: "G", body: "## new", at: "T2" } } };
  const v = (await tool.execute("v", { action: "view", name: "g-proc" }, undefined, undefined, ctx)).content[0].text;
  assert.match(v, /; locked, edit waiting for approval\)/);
  assert.match(v, /--- edit waiting for approval ---\nG\n\n## new$/);
  reply = { action: "list", skills: [{ ...base, status: "candidate", locked: false, pending_edit: false }] };
  assert.match((await tool.execute("l", { action: "list" }, undefined, undefined, ctx)).content[0].text, /; candidate: waiting for approval\)$/);
});
