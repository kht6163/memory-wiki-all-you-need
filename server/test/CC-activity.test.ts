// Claude Code activity lines ($.ui.log: a dim transcript line, never sent to Claude): the
// memories recalled for a prompt are logged when its turn starts (under the prompt), and
// once the server has curated a sent turn, what it added, updated or deleted. Same rules as
// the pi extension's cards (ADR-0042): nothing when nothing was recalled or changed; an old
// server (no status route) stops after three failed polls; session.end stops watching.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { curationLine, recallLine } from "../../claude-code-plugin/hooks/lib.ts";
import { assistant, callTool, complete, prompt, sessionStart, startSession, type FakeSession } from "./CC-harness.ts";
import { startMockServer, waitFor, type MockServer } from "./X-ext-harness.ts";

let srv: MockServer;
let s: FakeSession;
let statusReplies: unknown[] = [];
let turnId = 41;
const flushNow = () => s.emit("command.run", { command: "memory-flush", args: "" });
const statusPolls = () => srv.requests.filter((r) => r.method === "GET" && /^\/api\/turns\/\d+\/status$/.test(r.path));
const activity = () => s.ui.logs.filter((l) => l.startsWith("🧠"));

before(async () => {
  srv = await startMockServer();
  srv.routes.set("/api/context", (req) =>
    req.body?.prompt
      ? { system: "S", recall: "<memory-recall>\n- [#3] Deploy is blue-green: x\n</memory-recall>", recalled: [3], recalledEntries: [{ id: 3, title: "Deploy is blue-green" }] }
      : { system: "S", recall: "" },
  );
  srv.routes.set("/api/skills/sync", () => ({ version: "v0", global: [], project: null }));
  srv.routes.set("/api/turns", () => ({ id: turnId, status: "pending" }));
  for (const id of [41, 42, 43]) srv.routes.set(`/api/turns/${id}/status`, () => statusReplies.shift() ?? { status: "pending" });
  s = startSession({ env: { MEMORY_SERVER_URL: srv.url, MEMORY_SETTLE_DELAY_MS: "60000", MEMORY_TIMEOUT_MS: "500" }, repo: { root: "/work/app", remote: "git@github.com:foo/app.git" } });
  await sessionStart(s);
});
after(async () => {
  await s.emit("session.end", { reason: "exit" });
  await srv.close();
});

test("lines: recall lists the memories; curation counts add/update/delete and leaves confirm out", () => {
  assert.equal(recallLine({ recall: "- [#3] A", recalledEntries: [{ id: 3, title: "A" }, { id: 5, title: "B" }] }), "🧠 memory_recall · 2 memories · #3 A, #5 B");
  assert.equal(recallLine({ recall: "- [#7] Old server title (decision): body" }), "🧠 memory_recall · 1 memory · #7 Old server title (decision)");
  assert.equal(recallLine({ recall: "" }), null);
  const done = { applied: [{ op: "add", entryId: 12, title: "VPN" }, { op: "confirm", entryId: 3, title: "x" }, { op: "update", entryId: 5, title: "CI" }] };
  assert.equal(curationLine("done", done), "🧠 memory_curate · 1 added · 1 updated — + #12 VPN, ~ #5 CI");
  assert.equal(curationLine("done", { applied: [{ op: "confirm", entryId: 3, title: "x" }] }), null);
  assert.equal(curationLine("error", done), null);
  assert.equal(curationLine("done", null), null);
});

test("a recalled prompt logs its line when the turn starts; the turn's curation result is logged once done", { timeout: 15_000 }, async () => {
  const entered = await prompt(s, "how do we deploy?");
  assert.match(entered.context.join("\n"), /Deploy is blue-green/, "Claude still gets the recall as context");
  assert.deepEqual(activity(), ["🧠 memory_recall · 1 memory · #3 Deploy is blue-green"]);
  s.rows.push(assistant("blue-green"));
  statusReplies = [{ status: "processing" }, { status: "done", result: { applied: [{ op: "add", entryId: 12, title: "Deploy needs VPN" }] } }];
  await complete(s);
  await flushNow();
  assert.ok(await waitFor(() => activity().length === 2, 10_000), `logs: ${JSON.stringify(s.ui.logs)}`);
  assert.equal(activity()[1], "🧠 memory_curate · 1 added — + #12 Deploy needs VPN");
  assert.equal(statusPolls().length, 2);
});

test("an old server answering the status poll with something else gives up after three polls", { timeout: 15_000 }, async () => {
  turnId = 43;
  srv.routes.set("/api/turns/43/status", () => ({})); // the web UI's index.html reads as {}
  const before = activity().length;
  await prompt(s, "");
  s.rows.push(assistant("ok"));
  await complete(s);
  await flushNow();
  assert.ok(await waitFor(() => statusPolls().filter((r) => r.path.includes("/43/")).length === 3, 12_000));
  await new Promise((r) => setTimeout(r, 3_500));
  assert.equal(statusPolls().filter((r) => r.path.includes("/43/")).length, 3);
  assert.equal(activity().length, before);
});

test("memory_review goes to POST /agent/review with the project and shows the server's text", async () => {
  srv.routes.set("/api/agent/review", (req) => ({ action: req.body.action, text: `server text for ${req.body.action} #${req.body.id}` }));
  const r = await callTool(s, "memory_review", { action: "resolve", id: 329, note: "checked .env on the host" });
  assert.equal(r.result, "server text for resolve #329");
  const sent = srv.requests.find((x) => x.path === "/api/agent/review")!;
  assert.deepEqual(sent.body, { action: "resolve", id: 329, note: "checked .env on the host", project: { key: "github.com/foo/app", name: "app", remote: "git@github.com:foo/app.git" } });
});
