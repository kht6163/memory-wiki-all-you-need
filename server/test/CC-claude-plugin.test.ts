// The Claude Code mod (claude-code-plugin/, ADR-0041), run with a fake mods API
// against the mock memory server: G-070 (fail-soft: a dead server never holds a
// prompt or a session back, and a finished turn is never lost or sent twice),
// G-071 (each turn's own rows only: no recall block, no subagent turn, pi's tool
// names; queued prompts and compactions keep their turn), G-072 (the skills
// mirror never writes or removes a folder it did not write). Pure helpers are
// checked directly.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { normalizeRemote as piNormalize } from "../../pi-extension/project.ts";
import {
  MAX_TURN_MESSAGES,
  MIRROR_MARKER,
  chunkMessages,
  globalSkillsNote,
  isRetired,
  jsonBytes,
  lastPromptRow,
  locateTurn,
  normalizeRemote,
  originFromGitConfig,
  planMirror,
  projectFromRepo,
  projectSkillsNote,
  renderRetired,
  renderSkill,
  resolveSettings,
  rowKey,
  runStats,
  skillHint,
  toTurnMessages,
} from "../../claude-code-plugin/hooks/lib.ts";
import { assistant, callTool, complete, compose, prompt, sessionStart, startSession, submit, toolResult, turnStart, user, type FakeSession } from "./CC-harness.ts";
import { startMockServer, type MockServer } from "./X-ext-harness.ts";
import { call, ok, project as makeProject } from "./helpers.ts";

let srv: MockServer;
let s: FakeSession;
const SKILLS = "/home/test/.claude/skills";
const posts = (path: string) => srv.requests.filter((r) => r.method === "POST" && r.path.startsWith(path));
const turnTexts = () => posts("/api/turns").flatMap((p) => p.body.messages.map((m: { text: string }) => m.text));
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return cond();
};
const pendingKeys = () => [...s.store.keys()].filter((k) => k.startsWith("pending:"));
const flushNow = () => s.emit("command.run", { command: "memory-flush", args: "" });
const syncSkills = () => s.emit("command.run", { command: "skills-sync", args: "" });
const fakeKey = "sk-" + "a".repeat(32); // built here so the pre-commit secret grep does not match this file

before(async () => {
  srv = await startMockServer();
  srv.routes.set("/api/context", (req) => ({
    project: null,
    system: "<memory>MEMORY-BLOCK</memory>",
    recall: req.body?.prompt ? `<recall>about ${req.body.prompt}</recall>` : "",
    skillsVersion: "v1",
  }));
  srv.routes.set("/api/skills/sync", () => ({
    version: "v1",
    global: [{ name: "deploy-docs", description: "Deploy the docs site", body: "1. run it" }],
    project: { key: "github.com/foo/app", name: "app", skills: [{ name: "ship-it", description: "Ship this repo", body: "make ship" }] },
  }));
  srv.routes.set("/api/turns", () => ({ id: 1, status: "pending" }));
  srv.routes.set("/api/search", () => [{ id: 3, scope: "project", category: "fact", title: "Codename is HALIBUT", body: "" }]);
  s = startSession({
    env: { MEMORY_SERVER_URL: srv.url, MEMORY_SETTLE_DELAY_MS: "30", MEMORY_TIMEOUT_MS: "300" },
    // Claude Code reports the push URL; .git/config's url is what pi reads.
    repo: { root: "/work/app", remote: "git@github.com:me/app-fork.git" },
  });
  s.files.set("/work/app/.git/config", '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:Foo/App.git\n\tpushurl = git@github.com:me/app-fork.git\n');
  await sessionStart(s);
  await waitFor(() => s.files.has(`${SKILLS}/deploy-docs/SKILL.md`));
});
after(() => srv.close());

// ---------------------------------------------------------------- pure parts

test("the project key is the one the pi extension computes for the same repository", () => {
  for (const url of ["git@github.com:Foo/Bar.git", "https://user@github.com/foo/bar", "ssh://git@host:2222/a/b.git", "https://gitlab.example.com/g/sub/repo.git/"]) {
    assert.equal(normalizeRemote(url), piNormalize(url), url);
  }
  assert.equal(originFromGitConfig('[remote "upstream"]\n\turl = x\n[remote "origin"]\n\turl = git@h:a/b.git\n\tpushurl = git@h:me/b.git\n'), "git@h:a/b.git");
  assert.equal(originFromGitConfig("[core]\n"), null);
  assert.deepEqual(projectFromRepo({ root: "/w/app", remote: "git@github.com:Foo/App.git" }, ""), { key: "github.com/foo/app", name: "app", remote: "git@github.com:Foo/App.git" });
  assert.equal(projectFromRepo({ root: "/w/notes", remote: null }, "")?.key, "local/notes");
  assert.equal(projectFromRepo(null, ""), null);
  assert.equal(projectFromRepo(null, "team/fixed")?.key, "team/fixed");
});

test("settings: env vars win over plugin options, options over defaults; bad numbers fall back", () => {
  const d = resolveSettings({}, {});
  assert.equal(d.server, "http://127.0.0.1:8765");
  assert.equal(d.timeoutMs, 1500);
  assert.equal(d.mirrorSkills, true);
  const o = resolveSettings({ server_url: "http://srv:8765/", skill_nudge: 0, mirror_skills: false }, { MEMORY_SKILL_NUDGE: "x" });
  assert.equal(o.server, "http://srv:8765");
  assert.equal(o.skillNudge, 8, "a non-number env value keeps the default, not the option");
  assert.equal(o.mirrorSkills, false);
  assert.equal(resolveSettings({ server_url: "http://a" }, { MEMORY_SERVER_URL: "http://b" }).server, "http://b");
  const text = resolveSettings({ timeout_ms: "2000" as never, mirror_skills: "false" as never }, {});
  assert.equal(text.timeoutMs, 2000, "an option saved as text still counts");
  assert.equal(text.mirrorSkills, false);
});

test("G-071: turn rows become pi-shaped messages: tool names without the mcp prefix, results paired, reminders dropped", () => {
  const msgs = toTurnMessages([
    user("deploy it <system-reminder>hook said hi</system-reminder>"),
    assistant("", [{ tool_use_id: "a", tool: "mcp__memory-wiki__memory_search", input: { query: "deploy" } }]),
    toolResult("a", "#1 [project/fact] make ship"),
    assistant(`done with key ${fakeKey}`),
  ]);
  assert.deepEqual(msgs[0], { role: "user", text: "deploy it" });
  assert.equal(msgs[1]?.toolCalls?.[0]?.name, "memory_search");
  assert.deepEqual(msgs[2], { role: "tool", name: "memory_search", isError: false, text: "#1 [project/fact] make ship" });
  assert.match(msgs[3]?.text ?? "", /\[REDACTED:key\]/);
});

test("G-071: a turn starts at its prompt, else after its anchor row, else at the recorded length below the window", () => {
  const rows = [user("old"), assistant("a"), user("new prompt"), assistant("b")];
  assert.equal(locateTurn(rows, { prompt: "new prompt", anchor: rowKey(rows[1]), length: 2 }), 2);
  assert.equal(locateTurn(rows, { prompt: "", anchor: rowKey(rows[1]), length: 2 }), 2, "a continuation: after the anchor");
  // The list moved (a compaction kept a summary + the tail): the anchor is found where it is now.
  assert.equal(locateTurn([user("summary"), assistant("a"), assistant("c")], { prompt: "", anchor: rowKey(assistant("a")), length: 9 }), 2);
  assert.equal(locateTurn([], { prompt: "", anchor: null, length: 0 }), 0);
  assert.equal(locateTurn(rows, { prompt: "gone", anchor: rowKey(user("gone too")), length: 99 }), null);
  assert.equal(locateTurn(rows, { prompt: "", anchor: null, length: -1 }), null, "turn.start could not read the transcript: unknown, not -1");
  assert.equal(lastPromptRow([user("a"), assistant("x"), toolResult("t", "r"), assistant("y")]), 0);
  const full = Array.from({ length: 4096 }, (_, i) => assistant(`r${i}`));
  assert.equal(locateTurn(full, { prompt: "", anchor: null, length: 4096 }), null, "a length at the window's edge means nothing");
});

test("G-070: a turn is cut into chunks the server keeps whole (≤ 400 messages)", () => {
  const many = Array.from({ length: 950 }, (_, i) => ({ role: "assistant" as const, text: `m${i}` }));
  const chunks = chunkMessages(many);
  assert.deepEqual(chunks.map((c) => c.length), [400, 400, 150]);
  assert.equal(MAX_TURN_MESSAGES, 400);
  assert.deepEqual(chunkMessages([{ role: "user", text: "x".repeat(300) }, { role: "user", text: "y".repeat(300) }], 400, 400).map((c) => c.length), [1, 1]);
  assert.equal(jsonBytes("가"), 5, "sizes are UTF-8 bytes (the store's limit), not characters");
});

test("skill nudge: only after many calls with 2+ tools and no skill_manage", () => {
  const c = (name: string) => ({ name, args: "{}" });
  const many = [{ role: "assistant" as const, text: "", toolCalls: [...Array(7).fill(c("Bash")), c("Read")] }];
  assert.match(skillHint(runStats(many), 8) ?? "", /8 tool calls/);
  assert.equal(skillHint(runStats(many), 0), null, "0 = off");
  assert.equal(skillHint(runStats([{ ...many[0]!, toolCalls: Array(9).fill(c("Bash")) }]), 8), null, "one tool only");
  assert.equal(skillHint(runStats([{ ...many[0]!, toolCalls: [...many[0]!.toolCalls, c("skill_manage")] }]), 8), null);
});

test("G-072: the mirror plan writes only absent or marked folders and removes only marked ones it owns", () => {
  const url = "http://srv";
  const a = { name: "a", description: "A", body: "x" };
  const b = { name: "b", description: "B", body: "y" };
  const c = { name: "c", description: "C", body: "z" };
  const current = new Map<string, string | null>([
    ["a", renderSkill(a, url)], // unchanged
    ["b", "---\nname: b\n---\nmy own skill"], // someone else's
    ["c", null], // a folder without a readable SKILL.md: someone else's
    ["old", renderSkill({ name: "old", description: "O", body: "z" }, url)], // ours, gone from the server
    ["edited", "---\nname: edited\n---\nthe user rewrote it, marker gone"], // ours once, marker removed
  ]);
  const plan = planMirror([a, b, c, { name: "new", description: "N", body: "n" }], ["a", "old", "edited"], current, url);
  assert.deepEqual(plan.write.map((w) => w.name), ["new"]);
  assert.deepEqual(plan.conflicts, ["b", "c"]);
  assert.deepEqual(plan.remove, ["old"]);
  assert.deepEqual(plan.owned, ["a", "new"]);
  assert.ok(renderSkill(a, url).includes(MIRROR_MARKER));
  assert.ok(isRetired(renderRetired("old", url)) && !isRetired(renderSkill(a, url)));
  assert.match(renderRetired("old", url), /disable-model-invocation: true/);
  assert.match(projectSkillsNote({ key: "k", name: "n", skills: [{ name: "a", description: "Proj A", body: "" }] }, ["a"]), /- a: Proj A \(use this one/);
  assert.equal(projectSkillsNote(null, []), "");
  assert.match(globalSkillsNote([a]), /<global-skills>[\s\S]*- a: A/);
  assert.match(globalSkillsNote([a], ["a"]), /- a: A \(a local skill of the same name is not this one\)/);
});

// ------------------------------------------------------------ the mod itself

test("session start: 11 tools and the commands, the project from origin's url (not the push URL), global skills mirrored", async () => {
  assert.equal(s.tools.size, 11);
  for (const c of ["memory-wiki", "memory-pin", "wiki-compose", "skills-sync", "memory-flush"]) assert.ok(s.commands.has(c), c);
  assert.ok(!s.commands.has("memory"), "/memory is Claude Code's own command");
  const ctx = posts("/api/context")[0];
  assert.deepEqual(ctx?.body.project, { key: "github.com/foo/app", name: "app", remote: "git@github.com:Foo/App.git" });
  assert.match(s.files.get(`${SKILLS}/deploy-docs/SKILL.md`) ?? "", /^---\nname: deploy-docs\ndescription: "Deploy the docs site"/);
  assert.ok(![...s.files.keys()].some((k) => k.includes("ship-it")), "project skills are not installed");
});

test("the memory block and this project's skills go into the system prompt as a session section", async () => {
  const r = await compose(s);
  assert.equal(r.sections[0].id, "intro");
  const mine = r.sections.find((x: { id: string }) => x.id === "memory-wiki");
  assert.equal(mine?.scope, "session");
  assert.match(mine?.text, /MEMORY-BLOCK/);
  assert.match(mine?.text, /<project-skills>[\s\S]*- ship-it: Ship this repo/);
  assert.match(String(s.store.get("notes") && JSON.stringify(s.store.get("notes"))), /ship-it/, "kept for the next session's first prompt");
});

test("a prompt carries its recall as context only Claude reads", async () => {
  const r = await submit(s, "how do I deploy");
  assert.equal(r.text, "how do I deploy");
  assert.deepEqual(r.context, ["<recall>about how do I deploy</recall>"]);
});

test("G-071: the turn is sent once, with its own rows only, tool names as pi has them, agent claude-code, a batch id", async () => {
  srv.requests.length = 0;
  s.rows = [user("earlier prompt"), assistant("earlier answer")];
  await prompt(s, "deploy please");
  s.rows.push(
    assistant("", [{ tool_use_id: "t1", tool: "mcp__memory-wiki__memory_search", input: { query: "deploy" } }]),
    toolResult("t1", "#1 make ship"),
    assistant("Run make ship."),
  );
  await complete(s, { agentId: "sub-1" }); // a subagent's turn is not a turn
  await complete(s);
  assert.ok(await waitFor(() => posts("/api/turns").length === 1));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(posts("/api/turns").length, 1, "sent once");
  const body = posts("/api/turns")[0]!.body;
  assert.equal(body.agent, "claude-code");
  assert.equal(body.sessionId, "sess-cc");
  assert.equal(body.client, "test-host");
  assert.match(body.batchId, /^\d{14}-\d{4}$/);
  assert.deepEqual(body.messages.map((m: { text: string }) => m.text), ["deploy please", "", "#1 make ship", "Run make ship."]);
  assert.equal(body.messages[1].toolCalls[0].name, "memory_search");
  assert.ok(!JSON.stringify(body).includes("<recall>"), "the recall context never comes back as the turn");
  assert.ok(await waitFor(() => pendingKeys().length === 0), "sent chunks leave the store");
  // The server takes this body as a turn, keeps the agent, and a resend is the same turn.
  const t1 = await ok<{ id: number }>("POST", "/turns", body);
  const t2 = await ok<{ id: number }>("POST", "/turns", body);
  assert.equal(t2.id, t1.id, "same session + batch id = the turn already queued");
  const turns = await ok<{ id: number; agent: string | null }[]>("GET", "/turns");
  assert.equal(turns.find((x) => x.id === t1.id)?.agent, "claude-code");
  assert.notEqual((await ok<{ id: number }>("POST", "/turns", { ...body, batchId: "other" })).id, t1.id);
});

test("G-071: a prompt typed during a turn runs as its own turn and is recorded (no prompt.submit of its own when it starts)", async () => {
  srv.requests.length = 0;
  await prompt(s, "first task");
  await submit(s, "second task"); // typed mid-turn: Claude Code queues it
  s.rows.push(assistant("first done"));
  await complete(s);
  await turnStart(s, "second task"); // the queued prompt's turn starts
  s.rows.push(user("second task"), assistant("second done"));
  await complete(s);
  assert.ok(await waitFor(() => turnTexts().includes("second done")));
  assert.deepEqual(turnTexts(), ["first task", "first done", "second task", "second done"], "both turns, merged while unsent");
});

test("G-071: another loop's turn.start inside a turn (a subagent, should it raise one) does not move the main turn's start", async () => {
  srv.requests.length = 0;
  await prompt(s, "main task");
  s.rows.push(assistant("", [{ tool_use_id: "ag1", tool: "Agent", input: { prompt: "look around" } }]));
  await s.emit("turn.start", { text: "look around", turnId: "sub-turn" }, (e) => ({ turnId: e.turnId }));
  await s.emit("turn.complete", { answer: "", durationMs: 1, isAborted: false, turnId: "sub-turn", reason: "answer", agentId: "sub-1" });
  s.rows.push(toolResult("ag1", "found it"), assistant("main done"));
  await complete(s);
  assert.ok(await waitFor(() => turnTexts().includes("main done")));
  assert.deepEqual(turnTexts(), ["main task", "", "found it", "main done"]);
});

test("G-071: a compaction in the middle of a turn keeps what the turn had and what came after", async () => {
  srv.requests.length = 0;
  await prompt(s, "long task");
  s.rows.push(assistant("step 1"), assistant("step 2"));
  const kept = [user("<summary of everything>"), assistant("step 2")];
  const r = await s.emit("session.compact", { trigger: "auto", messages: structuredClone(s.rows) }, () => ({ messages: kept }));
  assert.deepEqual(r.messages, kept);
  s.rows = [...kept, assistant("step 3")];
  await complete(s);
  assert.ok(await waitFor(() => turnTexts().includes("step 3")));
  assert.deepEqual(turnTexts(), ["long task", "step 1", "step 2", "step 3"]);
});

test("G-070: a turn over 400 messages goes as several turns the server keeps whole", async () => {
  srv.requests.length = 0;
  await prompt(s, "huge");
  for (let i = 0; i < 450; i++) s.rows.push(assistant(`r${i}`));
  await complete(s);
  assert.ok(await waitFor(() => turnTexts().includes("r449")));
  assert.ok(posts("/api/turns").every((p) => p.body.messages.length <= 400));
  assert.equal(turnTexts().length, 451);
});

test("G-070: a dead server never holds a prompt back; the turn is kept and sent once the server is back", async () => {
  srv.requests.length = 0;
  srv.mode = "hang";
  const t0 = Date.now();
  const r = await submit(s, "while down");
  assert.ok(Date.now() - t0 < 2000, `prompt waited ${Date.now() - t0} ms`);
  assert.equal(r.text, "while down");
  assert.equal(r.context, undefined);
  assert.ok(s.ui.status.some((x) => x?.startsWith("memory offline")));
  srv.mode = "ok";
  await srv.stop(); // connection refused from here on
  await turnStart(s, "while down");
  s.rows.push(user("while down"), assistant("answered anyway"));
  await complete(s);
  assert.ok(await waitFor(() => s.ui.logs.some((l) => l.startsWith("turn not sent yet"))));
  assert.equal(pendingKeys().length, 1, "kept in the store");
  assert.equal((s.store.get(pendingKeys()[0]!) as { tried?: boolean }).tried, true, "a tried chunk takes no more turns (its id keeps its meaning)");
  await srv.restart();
  assert.equal((await flushNow()).text, "Turns sent for curation.");
  assert.ok(turnTexts().includes("while down"));
  assert.equal(pendingKeys().length, 0);
});

test("G-070: a turn the server refuses for good (4xx) is dropped with a notice instead of blocking later turns", async () => {
  srv.requests.length = 0;
  srv.mode = "error500";
  await prompt(s, "five hundred");
  s.rows.push(assistant("kept"));
  await complete(s);
  assert.ok(await waitFor(() => posts("/api/turns").length >= 1));
  assert.equal(pendingKeys().length, 1, "a 5xx is transient: kept");
  srv.routes.set("/api/turns", () => ({ __status: 413, error: "request entity too large" }));
  await prompt(s, "after the refusal");
  s.rows.push(assistant("still goes"));
  srv.mode = "ok";
  await complete(s);
  assert.ok(await waitFor(() => s.ui.toasts.some((t) => t.includes("refused a turn"))));
  assert.ok(await waitFor(() => pendingKeys().length === 0), "the refused chunk does not stay and block the queue");
  srv.routes.set("/api/turns", () => ({ id: 1, status: "pending" }));
});

test("G-070: a turn that ends while earlier chunks are being sent goes to a new chunk, never into one already taken", async () => {
  srv.requests.length = 0;
  let release: () => void = () => {};
  const slow = new Promise<void>((r) => (release = r));
  srv.routes.set("/api/turns", async () => {
    await slow;
    return { id: 1, status: "pending" };
  });
  await prompt(s, "turn one");
  s.rows.push(assistant("one done"));
  await complete(s);
  assert.ok(await waitFor(() => posts("/api/turns").length === 1), "the first chunk is on its way");
  await prompt(s, "turn two");
  s.rows.push(assistant("two done"));
  await complete(s); // ends while chunk one is in flight
  release();
  assert.ok(await waitFor(() => turnTexts().includes("two done")));
  assert.ok(await waitFor(() => pendingKeys().length === 0));
  assert.deepEqual(turnTexts(), ["turn one", "one done", "turn two", "two done"]);
  srv.routes.set("/api/turns", () => ({ id: 1, status: "pending" }));
});

test("G-071: a turn whose start was never marked (plugin reloaded mid-turn) is recorded from the last prompt", async () => {
  srv.requests.length = 0;
  s.rows.push(user("started before the reload"), assistant("finished after it"));
  await complete(s); // no turn.start for this turn
  assert.ok(await waitFor(() => turnTexts().includes("finished after it")));
  assert.equal(turnTexts()[0], "started before the reload");
});

test("skill hint: given to the next prompt, dropped when a prompt was typed during the turn", async () => {
  const busy = Array.from({ length: 9 }, (_, i) => ({ tool_use_id: `b${i}`, tool: i % 2 ? "Bash" : "Read", input: {} }));
  await prompt(s, "busy task");
  s.rows.push(assistant("", busy));
  await complete(s);
  assert.match((await submit(s, "next")).context?.join("") ?? "", /<skill-hint/);
  await turnStart(s, "next");
  s.rows.push(user("next"), assistant("ok"));
  await complete(s);
  await prompt(s, "busy again");
  await submit(s, "typed while busy");
  s.rows.push(assistant("", busy));
  await complete(s);
  assert.doesNotMatch((await submit(s, "after")).context?.join("") ?? "", /<skill-hint/, "the hint would land on the wrong prompt");
});

test("tools call the server and answer in pi's words; a server error is an answer, not a throw", async () => {
  const r = await callTool(s, "memory_search", { query: "codename" });
  assert.equal(r.result, "#3 [project/fact] Codename is HALIBUT");
  const q = new URL(srv.requests.filter((x) => x.path.startsWith("/api/search")).at(-1)!.path, "http://x").searchParams;
  assert.equal(q.get("q"), "codename");
  assert.equal(q.get("project"), "github.com/foo/app");
  assert.equal(q.get("via"), "agent");
  assert.equal((await callTool(s, "memory_graph", {})).result, "Give an entity name or a memory id.");
  srv.mode = "error500";
  const err = await callTool(s, "wiki_read", { slug: "x" });
  srv.mode = "ok";
  assert.equal(err.result, "memory server error: boom");
});

test("G-072: a resync leaves a user's folder alone (with or without SKILL.md) and removes only this mod's dropped skill", async () => {
  s.files.set(`${SKILLS}/mine-by-hand/SKILL.md`, "---\nname: mine-by-hand\n---\nmine");
  s.files.set(`${SKILLS}/draft/notes.md`, "a draft without SKILL.md yet");
  s.files.set(`${SKILLS}/deploy-docs/extra.sh`, "echo the user added this");
  srv.routes.set("/api/skills/sync", () => ({
    version: "v2",
    global: [
      { name: "mine-by-hand", description: "Server one", body: "server" },
      { name: "draft", description: "Server draft", body: "server" },
    ],
    project: null,
  }));
  const r = await syncSkills();
  assert.match(r.text, /not installed, a folder of that name is not from the server: mine-by-hand, draft/);
  assert.equal(s.files.get(`${SKILLS}/mine-by-hand/SKILL.md`), "---\nname: mine-by-hand\n---\nmine");
  assert.ok(!s.files.has(`${SKILLS}/draft/SKILL.md`), "never takes over a folder without SKILL.md");
  assert.ok(!s.files.has(`${SKILLS}/deploy-docs/SKILL.md`), "the dropped skill's SKILL.md is gone");
  assert.equal(s.files.get(`${SKILLS}/deploy-docs/extra.sh`), "echo the user added this", "a file the user put there stays");
  assert.ok(!s.processes.some((p) => p[0] === "rm" && p.includes("-rf")), "never rm -rf");
  const sec = (await compose(s)).sections.find((x: { id: string }) => x.id === "memory-wiki");
  assert.match(sec.text, /<global-skills>[\s\S]*- mine-by-hand: Server one \(a local skill of the same name is not this one\)/, "a server skill not installed is still listed");
});

test("G-072: where processes cannot run, a dropped skill is turned off with a marked stub; mirroring off removes this mod's skills and lists them", async () => {
  srv.routes.set("/api/skills/sync", () => ({ version: "v3", global: [{ name: "keep-me", description: "Keep", body: "k" }], project: null }));
  await syncSkills();
  assert.ok(s.files.has(`${SKILLS}/keep-me/SKILL.md`));
  srv.routes.set("/api/skills/sync", () => ({ version: "v4", global: [], project: null }));
  s.noProcess = true;
  const r = await syncSkills();
  s.noProcess = false;
  assert.match(r.text, /turned off keep-me/);
  assert.ok(isRetired(s.files.get(`${SKILLS}/keep-me/SKILL.md`)));
  s.noProcess = true;
  s.files.set(`${SKILLS}/keep-me/SKILL.md`, s.files.get(`${SKILLS}/keep-me/SKILL.md`)! + "\n<!-- touched -->");
  const again = await syncSkills();
  s.noProcess = false;
  assert.doesNotMatch(again.text, /turned off/, "an existing stub is not reported again");
  assert.match(s.files.get(`${SKILLS}/keep-me/SKILL.md`)!, /touched/, "nor rewritten");
  await syncSkills(); // processes work again: the stub is ours, so it goes
  assert.ok(!s.files.has(`${SKILLS}/keep-me/SKILL.md`));

  const off = startSession({ env: { MEMORY_SERVER_URL: srv.url, MEMORY_MIRROR_SKILLS: "0", MEMORY_TIMEOUT_MS: "300" }, sessionId: "sess-off" });
  off.files.set(`${SKILLS}/old-mirror/SKILL.md`, renderSkill({ name: "old-mirror", description: "Old", body: "o" }, srv.url));
  off.store.set("mirror", { root: SKILLS, owned: ["old-mirror"] });
  srv.routes.set("/api/skills/sync", () => ({ version: "v5", global: [{ name: "g1", description: "Global one", body: "g" }], project: null }));
  await sessionStart(off);
  const text = (await off.emit("command.run", { command: "skills-sync", args: "" })).text;
  assert.match(text, /installing is off/);
  assert.ok(!off.files.has(`${SKILLS}/old-mirror/SKILL.md`), "its own earlier mirror is removed");
  assert.ok(!off.files.has(`${SKILLS}/g1/SKILL.md`));
  const sec = (await compose(off)).sections.find((x: { id: string }) => x.id === "memory-wiki");
  assert.match(sec.text, /<global-skills>[\s\S]*- g1: Global one/);
});

test("server: an unknown agent value or a malformed batch id is not kept", async () => {
  await makeProject();
  const r = await call("POST", "/turns", { sessionId: "x", agent: "Bad Agent!", batchId: "has space", messages: [{ role: "user", text: "hi" }] });
  assert.equal(r.status, 202);
  const t = await ok<{ payload: { agent?: string; batch?: string } }>("GET", `/turns/${(r.data as { id: number }).id}`);
  assert.equal(t.payload.agent, undefined);
  assert.equal(t.payload.batch, undefined);
});
