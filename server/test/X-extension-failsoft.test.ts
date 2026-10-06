// G-010: the pi extension never blocks or breaks a pi turn when the memory
// server is down, hanging or erroring, and keeps unsent turns for later.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  assistantMsg,
  beforeAgentStartEvent,
  loadExtension,
  makeCtx,
  quietErrors,
  startMockServer,
  userMsg,
  type FakeCtx,
  type FakePi,
  type MockServer,
} from "./X-ext-harness.ts";

const TIMEOUT_MS = 200;
// A broken timeout must fail the test, not hang CI (node:test has no default timeout).
const BOUNDED = { timeout: 5000 };
let srv: MockServer;
let pi: FakePi;
let ctx: FakeCtx;
let cwd: string;

const turnPosts = () => srv.requests.filter((r) => r.method === "POST" && r.path === "/api/turns");

before(async () => {
  srv = await startMockServer();
  process.env.MEMORY_SERVER_URL = srv.url;
  process.env.MEMORY_TIMEOUT_MS = String(TIMEOUT_MS);
  process.env.MEMORY_SETTLE_DELAY_MS = "60000"; // flushes in this file come from session_shutdown only
  process.env.MEMORY_PROJECT = "github.com/test/demo";
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mwayn-ext-"));
  srv.routes.set("/api/context", (r) => ({ system: `SYS for ${r.body.prompt}`, recall: "RECALL", project: { id: 1 } }));
  srv.routes.set("/api/turns", () => ({ id: 1 }));
  pi = await loadExtension();
  ctx = makeCtx(cwd);
  await pi.emit("session_start", { type: "session_start" }, ctx);
});

after(async () => {
  await srv.close();
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("G-010: 서버가 정상이면 메모리 블록을 system 섹션에, 회상을 숨은 메시지로 넣는다", async () => {
  const ev = beforeAgentStartEvent("first");
  const res = await pi.emit("before_agent_start", ev, ctx);
  assert.equal(ev.systemPromptOptions.sections?.["memory-context"], "SYS for first");
  assert.deepEqual(res, { message: { customType: "memory-recall", content: "RECALL", display: false } });
  const req = srv.requests.at(-1)!;
  assert.equal(req.path, "/api/context");
  // agent / sessionId: for the server's recall measurement (ADR-0050).
  assert.deepEqual(req.body, { project: { key: "github.com/test/demo", name: "demo", remote: null }, prompt: "first", agent: "pi", sessionId: "sess-x" });
  assert.equal(ctx.status.at(-1), "🧠 demo");
  assert.equal(ctx.notices.length, 0);
});

test("G-010: 서버가 응답하지 않으면 MEMORY_TIMEOUT_MS 안에 풀리고 캐시한 블록을 다시 쓴다", BOUNDED, async () => {
  srv.mode = "hang";
  const ev = beforeAgentStartEvent("second");
  const t0 = Date.now();
  const res = await pi.emit("before_agent_start", ev, ctx);
  const took = Date.now() - t0;
  assert.ok(took >= TIMEOUT_MS - 20, `waited ${took}ms`);
  assert.ok(took < TIMEOUT_MS + 1000, `took ${took}ms, should be bounded by the timeout`);
  assert.equal(res, undefined, "no recall message when the server did not answer");
  assert.equal(ev.systemPromptOptions.sections?.["memory-context"], "SYS for first", "cached block reused");
  assert.equal(ctx.notices.length, 1);
  assert.equal(ctx.notices[0].level, "warning");
  assert.match(ctx.notices[0].msg, /memory server unreachable/);
  assert.equal(ctx.status.at(-1), "🧠 offline");
});

test("G-010: 연결이 거부돼도 던지지 않고 곧바로 풀리며, 두 번째 실패는 다시 알리지 않는다", BOUNDED, async () => {
  await srv.stop();
  srv.mode = "ok";
  const ev = beforeAgentStartEvent("third");
  const t0 = Date.now();
  const res = await pi.emit("before_agent_start", ev, ctx);
  assert.ok(Date.now() - t0 < TIMEOUT_MS + 1000);
  assert.equal(res, undefined);
  assert.equal(ev.systemPromptOptions.sections?.["memory-context"], "SYS for first");
  assert.equal(ctx.notices.length, 1, "only the first failure is announced");
  assert.equal(ctx.status.at(-1), "🧠 offline");
});

test("G-010: 턴 수집과 대기 타이머는 네트워크를 쓰지 않아 서버가 없어도 바로 끝난다", async () => {
  const before = srv.requests.length;
  const t0 = Date.now();
  await pi.emit("message_end", userMsg("hello while offline"), ctx);
  await pi.emit("message_end", assistantMsg("answer while offline"), ctx);
  await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(srv.requests.length, before);
});

test("G-010: 전송에 실패한 턴은 버리지 않고 서버가 돌아오면 다음 전송에 함께 보낸다", async () => {
  // Server still down: the shutdown flush fails but resolves.
  const { logged } = await quietErrors(() => pi.emit("session_shutdown", { type: "session_shutdown" }, ctx));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /failed to send turn/);
  assert.equal(turnPosts().length, 0);

  await srv.restart();
  // Recovery: status back to the project, warning flag reset.
  const ev = beforeAgentStartEvent("back");
  await pi.emit("before_agent_start", ev, ctx);
  assert.equal(ev.systemPromptOptions.sections?.["memory-context"], "SYS for back");
  assert.equal(ctx.status.at(-1), "🧠 demo");

  await pi.emit("message_end", userMsg("after recovery"), ctx);
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  const posts = turnPosts();
  assert.equal(posts.length, 1);
  assert.deepEqual(
    posts[0].body.messages.map((m: { text: string }) => m.text),
    ["hello while offline", "answer while offline", "after recovery"],
  );
});

test("G-010: 서버가 오류(500)를 내도 턴은 남고, 오류 메시지는 서버의 error 값", async () => {
  srv.requests.length = 0;
  srv.mode = "error500";
  await pi.emit("message_end", userMsg("q1"), ctx);
  const { logged } = await quietErrors(() => pi.emit("session_shutdown", { type: "session_shutdown" }, ctx));
  assert.match(logged[0], /boom/);
  srv.mode = "ok";
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  const posts = turnPosts();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body.messages.map((m: { text: string }) => m.text), ["q1"]);
});

test("G-010: 서버가 계속 없으면 수집 단계(message_end)에서 남겨 둔 턴을 최근 600개로 자른다", async () => {
  srv.requests.length = 0;
  srv.mode = "error500";
  for (let i = 0; i < 400; i++) await pi.emit("message_end", userMsg(`m${i}`), ctx);
  await quietErrors(() => pi.emit("session_shutdown", { type: "session_shutdown" }, ctx));
  for (let i = 400; i < 700; i++) await pi.emit("message_end", userMsg(`m${i}`), ctx);
  await quietErrors(() => pi.emit("session_shutdown", { type: "session_shutdown" }, ctx));
  srv.mode = "ok";
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  const last = turnPosts().at(-1)!;
  const texts = last.body.messages.map((m: { text: string }) => m.text);
  assert.equal(texts.length, 600);
  assert.equal(texts[0], "m100");
  assert.equal(texts.at(-1), "m699");
});

test("G-010: 보내는 도중 쌓인 메시지와 실패한 턴을 다시 합칠 때도 최근 600개로 자른다", BOUNDED, async () => {
  srv.requests.length = 0;
  srv.mode = "hang";
  for (let i = 0; i < 400; i++) await pi.emit("message_end", userMsg(`r${i}`), ctx);
  const { result: sent } = await quietErrors(async () => {
    const pending = pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
    // While the POST hangs, 300 more messages arrive (buffer alone stays under the cap).
    while (turnPosts().length === 0) await new Promise((r) => setTimeout(r, 5));
    for (let i = 400; i < 700; i++) await pi.emit("message_end", userMsg(`r${i}`), ctx);
    await srv.stop(); // the hanging POST fails: 400 unsent + 300 new = 700 > 600
    await pending;
    return turnPosts()[0].body.messages.length;
  });
  assert.equal(sent, 400);
  await srv.restart();
  srv.mode = "ok";
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  const texts = turnPosts().at(-1)!.body.messages.map((m: { text: string }) => m.text);
  assert.equal(texts.length, 600);
  assert.equal(texts[0], "r100");
  assert.equal(texts.at(-1), "r699");
});

test("G-010: 첫 요청부터 서버가 없으면 블록 없이 그대로 진행한다(새 세션, 캐시 없음)", BOUNDED, async () => {
  await srv.stop();
  const fresh = await loadExtension();
  const c2 = makeCtx(cwd, "sess-2");
  await fresh.emit("session_start", { type: "session_start" }, c2);
  const ev = beforeAgentStartEvent("cold");
  const res = await fresh.emit("before_agent_start", ev, c2);
  assert.equal(res, undefined);
  assert.equal(ev.systemPromptOptions.sections, undefined, "system prompt untouched");
  assert.equal(c2.notices.length, 1);
  assert.equal(c2.status.at(-1), "🧠 offline");
  await srv.restart();
});
