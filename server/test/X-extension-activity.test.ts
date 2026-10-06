// Activity cards (showActivity): memories recalled for a prompt show under it as a
// visible "memory-recall" message with the entries in `details` (the model gets the
// same `content` as before), and a sent turn is polled on GET /turns/:id/status until
// curated; when it added, updated or deleted memories, a "memory-curate" entry is
// appended (rendered, never sent to the model). Fail-soft: a dead server, an old server
// without the route, a closed session or showActivity=false never add a card or throw.
//
// The watcher's setTimeout runs on node:test's fake clock; fetch to the mock server is
// real, so waits poll with setImmediate on the real clock.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, mock, test } from "node:test";
import {
  beforeAgentStartEvent,
  loadExtension,
  makeCtx,
  plainTheme,
  renderText,
  startMockServer,
  userMsg,
  assistantMsg,
  type FakeCtx,
  type FakePi,
  type MockServer,
} from "./X-ext-harness.ts";
// The extension reads MEMORY_SERVER_URL once at import: imported only in before(),
// after the env points at the mock (G-073).
let cardLines: typeof import("../../pi-extension/index.ts").cardLines;
let curationCard: typeof import("../../pi-extension/index.ts").curationCard;
let recallCard: typeof import("../../pi-extension/index.ts").recallCard;

let srv: MockServer;
let pi: FakePi;
let ctx: FakeCtx;
let agentDir: string;
let statusReplies: unknown[] = [];
let nextTurnId = 7;

const clock = mock.timers;
const nextLoop = () => new Promise<void>((r) => setImmediate(r));
async function realWaitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await nextLoop();
  return cond();
}
async function realWait(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) await nextLoop();
}
const statusPolls = () => srv.requests.filter((r) => r.method === "GET" && /^\/api\/turns\/\d+\/status$/.test(r.path));
const prompt = (p: string) => pi.emit("before_agent_start", beforeAgentStartEvent(p), ctx) as Promise<any>;

/** A finished run in the buffer, sent at once with /memory-flush (the watcher starts there). */
async function sendTurn() {
  await pi.emit("message_end", userMsg("deploy the app"), ctx);
  await pi.emit("message_end", assistantMsg("done"), ctx);
  await pi.commands.get("memory-flush")!.handler("", ctx);
}

/**
 * Advance the fake clock until the next poll goes out, then let its reply be handled.
 * Ticks in a loop: the previous reply may still be on its way, and the next timer only
 * exists once the extension has handled it (no fixed real-time sleep to race).
 */
async function poll() {
  const n = statusPolls().length;
  const end = Date.now() + 3000;
  while (statusPolls().length === n && Date.now() < end) {
    clock.tick(3_000);
    await realWait(5);
  }
  assert.ok(statusPolls().length > n, "a status poll was sent");
  await realWait(30); // the reply is handled (card appended or next timer set) before the caller checks
}

before(async () => {
  srv = await startMockServer();
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwayn-activity-"));
  process.env.PI_CODING_AGENT_DIR = agentDir; // /memory-config writes here, not to the real settings
  process.env.MEMORY_SERVER_URL = srv.url;
  process.env.MEMORY_TIMEOUT_MS = "1000";
  process.env.MEMORY_PROJECT = "github.com/test/demo";
  delete process.env.MEMORY_SHOW_ACTIVITY;
  srv.routes.set("/api/context", () => ({
    system: "SYS",
    recall: "<memory-recall>\n- [#3] Deploy uses blue-green: two pools\n- [#5] CI cache key\n</memory-recall>",
    recalled: [3, 5],
    recalledEntries: [
      { id: 3, title: "Deploy uses blue-green" },
      { id: 5, title: "CI cache key" },
    ],
  }));
  srv.routes.set("/api/turns", () => ({ id: nextTurnId, status: "pending" }));
  for (const id of [7, 8, 9, 10, 11]) srv.routes.set(`/api/turns/${id}/status`, () => statusReplies.shift() ?? { status: "pending" });
  pi = await loadExtension();
  ({ cardLines, curationCard, recallCard } = await import("../../pi-extension/index.ts"));
  clock.enable({ apis: ["setTimeout"] });
  ctx = makeCtx(agentDir, "sess-activity");
  await pi.emit("session_start", { type: "session_start" }, ctx);
});

beforeEach(() => {
  srv.requests.length = 0;
  pi.entries.length = 0;
  statusReplies = [];
});

after(async () => {
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  clock.reset();
  await srv.close();
  fs.rmSync(agentDir, { recursive: true, force: true });
});

test("recalled memories: the recall message is shown, with the entries only in details", async () => {
  const r = await prompt("how do we deploy?");
  assert.equal(r.message.customType, "memory-recall");
  assert.equal(r.message.display, true);
  assert.match(r.message.content, /Deploy uses blue-green/); // what the model gets is unchanged
  assert.deepEqual(r.message.details, {
    entries: [
      { id: 3, title: "Deploy uses blue-green" },
      { id: 5, title: "CI cache key" },
    ],
  });
  const render = pi.messageRenderers.get("memory-recall")!;
  const collapsed = renderText(render(r.message, { expanded: false }, plainTheme));
  assert.match(collapsed, /memory_recall 2 memories · Deploy uses blue-green, CI cache key/);
  assert.doesNotMatch(collapsed, /#3/);
  const expanded = renderText(render(r.message, { expanded: true }, plainTheme));
  assert.match(expanded, /#3 Deploy uses blue-green\n#5 CI cache key/);
});

test("nothing recalled: no card (a skill hint alone stays a hidden message)", async () => {
  srv.routes.set("/api/context", () => ({ system: "SYS", recall: "", recalled: [], recalledEntries: [] }));
  try {
    assert.equal(await prompt("hello"), undefined);
  } finally {
    srv.routes.set("/api/context", () => ({ system: "SYS", recall: "- [#1] A", recalledEntries: [{ id: 1, title: "A" }] }));
  }
});

test("an older server without recalledEntries: titles come from the recall lines", () => {
  assert.deepEqual(recallCard({ recall: "<memory-recall>\n- [#3] Deploy uses blue-green (decision): two pools\n- [#5] CI\n</memory-recall>", recalled: [3, 5] }), {
    entries: [
      { id: 3, title: "Deploy uses blue-green (decision)" },
      { id: 5, title: "CI" },
    ],
  });
  assert.equal(recallCard({ recall: "" }), null);
  assert.equal(recallCard({ recall: "free text without entry lines" }), null);
  // A malformed reply never throws.
  assert.deepEqual(recallCard({ recall: "- [#2] B", recalledEntries: [null, { id: "x" }, 7] }), { entries: [{ id: 2, title: "B" }] });
});

test("curation: the sent turn is polled until done, then one card with add/update/delete (confirm left out)", async () => {
  nextTurnId = 7;
  statusReplies = [
    { status: "pending" },
    { status: "processing" },
    {
      status: "done",
      result: {
        applied: [
          { op: "add", entryId: 12, title: "Deploy needs VPN" },
          { op: "confirm", entryId: 3, title: "Deploy uses blue-green" },
          { op: "update", entryId: 5, title: "CI cache key" },
        ],
        // Only duplicates are reported; a refused edit is in skipped too.
        skipped: [{ op: "add", title: "dup", reason: "duplicate" }, { op: "edit", title: "x", reason: "old text not found" }],
      },
    },
  ];
  await sendTurn();
  assert.equal(statusPolls().length, 0, "the first poll waits for its timer");
  await poll();
  await poll();
  assert.equal(pi.entries.length, 0);
  await poll();
  assert.equal(pi.entries.length, 1);
  const { customType, data } = pi.entries[0];
  assert.equal(customType, "memory-curate");
  assert.deepEqual(data, {
    turnId: 7,
    applied: [
      { op: "add", entryId: 12, title: "Deploy needs VPN" },
      { op: "update", entryId: 5, title: "CI cache key" },
    ],
    skipped: 1,
  });
  const render = pi.entryRenderers.get("memory-curate")!;
  assert.match(renderText(render({ customType, data }, { expanded: false }, plainTheme)), /memory_curate 1 added · 1 updated/);
  const expanded = renderText(render({ customType, data }, { expanded: true }, plainTheme));
  assert.match(expanded, /\+ #12 Deploy needs VPN\n~ #5 CI cache key\n\(1 skipped as duplicates\)\nturn #7/);
  // Done: no more polls.
  clock.tick(60_000);
  await realWait(50);
  assert.equal(statusPolls().length, 3);
});

test("curation that changed nothing (confirm only, skipped, error) adds no card and stops polling", async () => {
  for (const reply of [
    { status: "done", result: { applied: [{ op: "confirm", entryId: 3, title: "x" }] } },
    { status: "skipped", result: null },
    { status: "error", error: "llm down", result: null },
  ]) {
    srv.requests.length = 0;
    statusReplies = [reply];
    await sendTurn();
    await poll();
    clock.tick(60_000);
    await realWait(50);
    assert.equal(statusPolls().length, 1, `one poll for ${reply.status}`);
  }
  assert.equal(pi.entries.length, 0);
});

test("three failed polls in a row (old server without the route, server down) give up quietly", async () => {
  nextTurnId = 99; // an old server: no status route (404)
  srv.routes.set("/api/turns/99/status", () => ({ __status: 404, error: "not found" }));
  await sendTurn();
  await poll();
  await poll();
  await poll();
  clock.tick(60_000);
  await realWait(50);
  assert.equal(statusPolls().length, 3);
  assert.equal(pi.entries.length, 0);
  nextTurnId = 7;
});

test("a reply without a known status (an old server's index.html is {} to the extension) counts as a failure", async () => {
  nextTurnId = 100; // no route: the mock answers 200 {}
  await sendTurn();
  await poll();
  await poll();
  await poll();
  clock.tick(60_000);
  await realWait(50);
  assert.equal(statusPolls().length, 3);
  assert.equal(pi.entries.length, 0);
  nextTurnId = 7;
});

test("a send still in flight when the session shuts down starts no watcher", async () => {
  let release!: () => void;
  srv.routes.set("/api/turns", () => new Promise((r) => (release = () => r({ id: 9, status: "pending" }))));
  try {
    await pi.emit("message_end", userMsg("slow"), ctx);
    await pi.emit("message_end", assistantMsg("ok"), ctx);
    const sending = pi.commands.get("memory-flush")!.handler("", ctx);
    assert.ok(await realWaitFor(() => srv.requests.some((r) => r.method === "POST" && r.path === "/api/turns")));
    await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
    release();
    await sending;
    statusReplies = [{ status: "done", result: { applied: [{ op: "add", entryId: 1, title: "A" }] } }];
    clock.tick(60_000);
    await realWait(50);
    assert.equal(statusPolls().length, 0);
    assert.equal(pi.entries.length, 0);
  } finally {
    srv.routes.set("/api/turns", () => ({ id: nextTurnId, status: "pending" }));
    await pi.emit("session_start", { type: "session_start" }, ctx);
  }
});

test("a new session or shutdown drops the old session's watcher; the shutdown send is not watched", async () => {
  nextTurnId = 8;
  await sendTurn();
  await pi.emit("session_start", { type: "session_start" }, ctx); // /new, /resume, fork
  statusReplies = [{ status: "done", result: { applied: [{ op: "add", entryId: 1, title: "A" }] } }];
  clock.tick(60_000);
  await realWait(50);
  assert.equal(statusPolls().length, 0);
  assert.equal(pi.entries.length, 0);

  await pi.emit("message_end", userMsg("bye"), ctx);
  await pi.emit("message_end", assistantMsg("ok"), ctx);
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  assert.ok(await realWaitFor(() => srv.requests.some((r) => r.method === "POST" && r.path === "/api/turns")));
  clock.tick(60_000);
  await realWait(50);
  assert.equal(statusPolls().length, 0);
  await pi.emit("session_start", { type: "session_start" }, ctx);
  nextTurnId = 7;
});

test("no UI (print mode): no recall card and no polling", async () => {
  const headless = makeCtx(agentDir, "sess-headless");
  headless.hasUI = false;
  await pi.emit("session_start", { type: "session_start" }, headless);
  try {
    const r = (await pi.emit("before_agent_start", beforeAgentStartEvent("deploy?"), headless)) as any;
    assert.equal(r.message.display, false);
    assert.equal(r.message.details, undefined);
    await pi.emit("message_end", userMsg("x"), headless);
    await pi.emit("message_end", assistantMsg("y"), headless);
    await pi.commands.get("memory-flush")!.handler("", headless);
    clock.tick(60_000);
    await realWait(50);
    assert.equal(statusPolls().length, 0);
  } finally {
    await pi.emit("session_start", { type: "session_start" }, ctx);
  }
});

test("showActivity false (/memory-config): hidden recall, no polling; true turns both back on", async () => {
  await pi.commands.get("memory-config")!.handler("showActivity false", ctx);
  assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "extensions", "memory-wiki-all-you-need.json"), "utf8")).showActivity, false);
  const r = await prompt("deploy?");
  assert.equal(r.message.display, false);
  await sendTurn();
  clock.tick(60_000);
  await realWait(50);
  assert.equal(statusPolls().length, 0);

  await pi.commands.get("memory-config")!.handler("showActivity true", ctx);
  assert.equal((await prompt("deploy?")).message.display, true);
  assert.match(ctx.notices.at(-1)!.msg, /showActivity = true/);
});

test("renderers are defensive: an old or malformed entry renders nothing instead of throwing", () => {
  assert.equal(cardLines("curate", null, true), null);
  assert.equal(cardLines("curate", { applied: [] }, true), null);
  assert.equal(cardLines("recall", { entries: "x" }, false), null);
  assert.equal(pi.entryRenderers.get("memory-curate")!({ data: undefined }, { expanded: false }, plainTheme), undefined);
  assert.equal(pi.messageRenderers.get("memory-recall")!({ details: undefined }, { expanded: true }, plainTheme), undefined);
  assert.equal(curationCard(1, "done", { applied: "nope" }), null);
  assert.equal(curationCard(1, "pending", { applied: [{ op: "add", entryId: 1, title: "A" }] }), null);
});
