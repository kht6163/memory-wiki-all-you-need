// G-006: the extension buffers message_end events and ships the turn only after
// agent_settled + MEMORY_SETTLE_DELAY_MS; a new prompt before that merges the
// turns, session_shutdown sends at once. The POST /api/turns body is the
// server's TurnInput (checked by feeding it to the real API in-process).
//
// The settle timer runs on node:test's fake clock (setTimeout only, enabled for
// the whole file so the extension's timer handles never outlive the clock that
// made them), so "not yet sent" checks cannot race a slow CI machine:
// the timer fires only when the test ticks past it. The network (fetch to the
// mock server) stays real, so waits for it poll with setImmediate on the real
// clock (Date is not mocked).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, mock, test } from "node:test";
import {
  assistantMsg,
  beforeAgentStartEvent,
  loadExtension,
  makeCtx,
  startMockServer,
  toolResultMsg,
  userMsg,
  type FakeCtx,
  type FakePi,
  type MockServer,
} from "./X-ext-harness.ts";

const DELAY_MS = 8000; // fake clock: the value only has to be > 1
/** Real time given to a request that would have been sent, before "not sent" is asserted. */
const NET_GRACE_MS = 150;
let srv: MockServer;
let pi: FakePi;
let ctx: FakeCtx;
let cwd: string;

const turnPosts = () => srv.requests.filter((r) => r.method === "POST" && r.path === "/api/turns");
const texts = (body: { messages: { text: string }[] }) => body.messages.map((m) => m.text);
const settled = () => pi.emit("agent_settled", { type: "agent_settled" }, ctx);
const prompt = (p: string) => pi.emit("before_agent_start", beforeAgentStartEvent(p), ctx);
const msg = (m: unknown) => pi.emit("message_end", m, ctx);

// Real-clock waits that do not use setTimeout (it is faked during timing tests).
const nextLoop = () => new Promise<void>((r) => setImmediate(r));
async function realWait(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) await nextLoop();
}
async function realWaitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await nextLoop();
  return cond();
}
const clock = mock.timers;

before(async () => {
  srv = await startMockServer();
  process.env.MEMORY_SERVER_URL = srv.url;
  process.env.MEMORY_SETTLE_DELAY_MS = String(DELAY_MS);
  process.env.MEMORY_TIMEOUT_MS = "1000";
  process.env.MEMORY_PROJECT = "github.com/test/demo";
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mwayn-ext-"));
  srv.routes.set("/api/context", () => ({ system: "SYS", recall: "" }));
  srv.routes.set("/api/turns", () => ({ id: 1 }));
  pi = await loadExtension();
  clock.enable({ apis: ["setTimeout"] });
  ctx = makeCtx(cwd, "sess-flush");
  await pi.emit("session_start", { type: "session_start" }, ctx);
});

beforeEach(() => {
  srv.requests.length = 0;
});

after(async () => {
  // Nothing may be left pending (a stray timer would POST after the test).
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  clock.reset();
  await srv.close();
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("G-006: agent_end·message_end만으로는 보내지 않고, agent_settled 뒤 지연이 지나야 한 번 보낸다", async () => {
  await prompt("deploy?");
  await msg(userMsg("how do I deploy?"));
  await msg(assistantMsg("Run compose.", [{ name: "bash", arguments: { cmd: "docker compose up -d" } }]));
  await msg(toolResultMsg("bash", "started"));
  await pi.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
  clock.tick(DELAY_MS * 2);
  await realWait(NET_GRACE_MS);
  assert.equal(turnPosts().length, 0, "agent_end must not flush");

  await settled();
  clock.tick(DELAY_MS - 1);
  await realWait(NET_GRACE_MS);
  assert.equal(turnPosts().length, 0, "not before the settle delay");
  clock.tick(1);
  assert.ok(await realWaitFor(() => turnPosts().length === 1), "sent once the delay has passed");
  clock.tick(DELAY_MS * 2);
  await realWait(NET_GRACE_MS);
  assert.equal(turnPosts().length, 1, "sent exactly once");
  assert.deepEqual(texts(turnPosts()[0].body), ["how do I deploy?", "Run compose.", "started"]);
});

test("G-006: 지연 전에 새 프롬프트가 오면 전송을 미루고 두 요청을 한 턴으로 합친다", async () => {
  await msg(userMsg("first question"));
  await msg(assistantMsg("first answer"));
  await settled();
  clock.tick(DELAY_MS / 2);
  await prompt("second question"); // cancels the pending send
  await msg(userMsg("second question"));
  await msg(assistantMsg("second answer"));
  clock.tick(DELAY_MS * 2);
  await realWait(NET_GRACE_MS);
  assert.equal(turnPosts().length, 0, "cancelled timer must not fire");
  await settled();
  clock.tick(DELAY_MS);
  assert.ok(await realWaitFor(() => turnPosts().length === 1));
  await realWait(NET_GRACE_MS);
  assert.equal(turnPosts().length, 1);
  assert.deepEqual(texts(turnPosts()[0].body), ["first question", "first answer", "second question", "second answer"]);
});

test("G-006: agent_settled가 다시 오면 앞 타이머를 지우고 그 시점부터 새로 재서 한 번만 보낸다", async () => {
  await msg(userMsg("q"));
  await msg(assistantMsg("a"));
  await settled();
  clock.tick(DELAY_MS / 2);
  await settled();
  // Past the first timer's deadline: it must have been replaced, not left running.
  clock.tick(DELAY_MS / 2 + 1);
  await realWait(NET_GRACE_MS);
  assert.equal(turnPosts().length, 0, "the first settle timer was cleared");
  // Exactly DELAY_MS after the second agent_settled.
  clock.tick(DELAY_MS / 2 - 1);
  assert.ok(await realWaitFor(() => turnPosts().length === 1));
  clock.tick(DELAY_MS * 2);
  await realWait(NET_GRACE_MS);
  assert.equal(turnPosts().length, 1);
  assert.deepEqual(texts(turnPosts()[0].body), ["q", "a"]);
});

test("G-006: session_shutdown은 지연 없이 곧바로 보내고 걸려 있던 타이머를 지운다", async () => {
  await msg(userMsg("bye"));
  await msg(assistantMsg("ok"));
  await settled();
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  assert.equal(turnPosts().length, 1, "sent when the handler resolves");
  // A leftover timer would ship this message on its own.
  await msg(userMsg("late"));
  clock.tick(DELAY_MS * 2);
  await realWait(NET_GRACE_MS);
  assert.equal(turnPosts().length, 1, "the settle timer was cancelled");
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  assert.equal(turnPosts().length, 2);
  assert.deepEqual(texts(turnPosts()[1].body), ["late"]);
});

test("G-006: /memory-flush는 바로 보내고 대기 중인 전송을 취소한다", async () => {
  await msg(userMsg("now"));
  await msg(assistantMsg("sure"));
  await settled();
  await pi.commands.get("memory-flush")!.handler("", ctx);
  assert.equal(turnPosts().length, 1);
  assert.equal(ctx.notices.at(-1)?.level, "info");
  await msg(userMsg("later"));
  clock.tick(DELAY_MS * 2);
  await realWait(NET_GRACE_MS);
  assert.equal(turnPosts().length, 1, "the settle timer was cancelled");
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  assert.deepEqual(texts(turnPosts()[1].body), ["later"]);
});

test("G-006: 사용자·어시스턴트 메시지가 없는 버퍼(도구 결과만)는 보내지 않고 버린다", async () => {
  await msg(toolResultMsg("bash", "noise"));
  await msg({ message: { role: "custom", content: "ignored" } });
  await msg(userMsg("   "));
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  assert.equal(turnPosts().length, 0);
  await msg(userMsg("real"));
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  assert.deepEqual(texts(turnPosts()[0].body), ["real"], "the dropped tool-only buffer does not come back");
});

test("G-006: POST /api/turns 본문은 서버 TurnInput 모양이고 서버가 그대로 받는다", async () => {
  const secret = `sk-${"a1B2".repeat(8)}`;
  await msg(userMsg(`use key ${secret} please`));
  await msg(assistantMsg("done", [{ name: "write", arguments: { path: "x.env", content: `KEY=${secret}` } }]));
  await msg(toolResultMsg("write", "failed", true));
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  const post = turnPosts()[0];
  assert.ok(post);
  const body = post.body;
  assert.deepEqual(Object.keys(body).sort(), ["client", "cwd", "messages", "project", "sessionId"]);
  assert.equal(body.sessionId, "sess-flush");
  assert.equal(body.cwd, cwd);
  assert.equal(typeof body.client, "string");
  assert.deepEqual(body.project, { key: "github.com/test/demo", name: "demo", remote: null });
  assert.deepEqual(body.messages[0], { role: "user", text: "use key [REDACTED:key] please" });
  assert.equal(body.messages[1].role, "assistant");
  assert.equal(body.messages[1].text, "done");
  assert.equal(body.messages[1].toolCalls[0].name, "write");
  assert.ok(!JSON.stringify(body).includes(secret), "secrets are redacted before leaving the machine");
  assert.deepEqual(body.messages[2], { role: "tool", name: "write", isError: true, text: "failed" });

  // The real server accepts exactly this body.
  const { ok } = await import("./helpers.ts");
  const turn = await ok<{ id: number; session_id: string; cwd: string }>("POST", "/turns", body);
  assert.ok(turn.id > 0);
});
