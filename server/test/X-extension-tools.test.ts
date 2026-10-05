// The extension's tools and slash commands call the right server endpoints
// and fail cleanly (a rejected tool call or an error notice, never a hang or a
// crash) when the server errors or is down.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  assistantMsg,
  loadExtension,
  makeCtx,
  quietErrors,
  startMockServer,
  userMsg,
  type FakeCtx,
  type FakePi,
  type MockServer,
} from "./X-ext-harness.ts";

let srv: MockServer;
let pi: FakePi;
let ctx: FakeCtx;
let cwd: string;

const entry = { id: 7, scope: "project", category: "convention", title: "Use pnpm", body: "not npm", tags: [] };
const last = () => srv.requests.at(-1)!;
const params = (p: string) => Object.fromEntries(new URL(p, "http://x").searchParams);
const pathname = (p: string) => new URL(p, "http://x").pathname;
const run = (name: string, args: Record<string, unknown>) => pi.tools.get(name)!.execute("call-1", args);
const outText = (r: { content: { text: string }[] }) => r.content[0].text;

before(async () => {
  srv = await startMockServer();
  process.env.MEMORY_SERVER_URL = `${srv.url}//`; // trailing slashes are trimmed
  process.env.MEMORY_TIMEOUT_MS = "1000";
  process.env.MEMORY_SETTLE_DELAY_MS = "60000";
  process.env.MEMORY_PROJECT = "github.com/test/demo";
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mwayn-ext-"));
  srv.routes.set("/api/search", () => [entry]);
  srv.routes.set("/api/session-search", () => [{ id: 3, project_name: "demo", created_at: "2026-10-01T10:20:30Z", snippet: "past" }]);
  srv.routes.set("/api/graph/neighbors", () => ({
    kind: "entity",
    entity: { name: "PostgreSQL", kind: "tech", description: "db" },
    memories: [entry],
    related: [{ name: "pgbouncer" }],
  }));
  srv.routes.set("/api/wiki/search", () => [{ slug: "deploy", title: "배포", project_id: null, snippet: "compose" }]);
  srv.routes.set("/api/wiki/read", () => ({ title: "배포", body: "## 절차", updated_at: "2026-10-01T00:00:00Z" }));
  srv.routes.set("/api/agent/wiki", (r) => ({ action: "created", page: { slug: r.body.slug, title: r.body.title, project_id: 1 } }));
  srv.routes.set("/api/agent/memory", (r) => ({ action: r.body.action, entry }));
  srv.routes.set("/api/health", () => ({ entries: 12, pending: 0, llm: "test-model" }));
  srv.routes.set("/api/context", () => ({ system: "", recall: "", project: { id: 4 } }));
  srv.routes.set("/api/entries", () => ({ id: 9 }));
  srv.routes.set("/api/turns", () => ({ id: 1 }));
  srv.routes.set("/api/wiki/compose", () => ({ id: 5, payload: { turns: [1, 2] } }));
  pi = await loadExtension();
  ctx = makeCtx(cwd, "sess-tools");
  await pi.emit("session_start", { type: "session_start" }, ctx);
});

beforeEach(() => {
  srv.requests.length = 0;
  srv.mode = "ok";
});

after(async () => {
  await srv.close();
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("G-010: 도구 9개와 명령 5개를 등록한다", () => {
  assert.deepEqual(
    [...pi.tools.keys()].sort(),
    ["memory_add", "memory_graph", "memory_remove", "memory_replace", "memory_search", "session_search", "wiki_read", "wiki_search", "wiki_write"].sort(),
  );
  assert.deepEqual([...pi.commands.keys()].sort(), ["memory", "memory-flush", "memory-pin", "memory-server", "wiki-compose"]);
});

test("G-010: memory_search는 GET /api/search에 프로젝트·범위·분류를 붙인다", async () => {
  const r = await run("memory_search", { query: "패키지 매니저", scope: "project", category: "convention" });
  assert.equal(last().method, "GET");
  assert.equal(pathname(last().path), "/api/search", "MEMORY_SERVER_URL trailing slashes trimmed");
  assert.deepEqual(params(last().path), {
    q: "패키지 매니저",
    limit: "10",
    via: "agent",
    project: "github.com/test/demo",
    scope: "project",
    category: "convention",
  });
  assert.match(outText(r), /#7 \[project\/convention\] Use pnpm\n {2}not npm/);

  await run("memory_search", { query: "x", scope: "all", limit: 3 });
  assert.deepEqual(params(last().path), { q: "x", limit: "3", via: "agent", project: "github.com/test/demo" }, "scope=all is not sent");
});

test("G-010: session_search는 all_projects면 프로젝트를 빼고 보낸다", async () => {
  const r = await run("session_search", { query: "배포" });
  assert.equal(pathname(last().path), "/api/session-search");
  assert.deepEqual(params(last().path), { q: "배포", limit: "8", project: "github.com/test/demo" });
  assert.match(outText(r), /turn #3 · demo · 2026-10-01T10:20/);
  await run("session_search", { query: "배포", all_projects: true });
  assert.deepEqual(params(last().path), { q: "배포", limit: "8" });
});

test("G-010: memory_graph는 인자가 없으면 서버를 부르지 않고, 있으면 /api/graph/neighbors", async () => {
  const empty = await run("memory_graph", {});
  assert.equal(srv.requests.length, 0);
  assert.match(outText(empty), /Give an entity name or a memory id/);
  const r = await run("memory_graph", { entity: "PostgreSQL" });
  assert.equal(pathname(last().path), "/api/graph/neighbors");
  assert.deepEqual(params(last().path), { via: "agent", entity: "PostgreSQL", project: "github.com/test/demo" });
  assert.match(outText(r), /PostgreSQL \(tech\) — db/);
  assert.match(outText(r), /Related entities: pgbouncer/);
});

test("G-010: wiki_search·wiki_read·wiki_write가 위키 엔드포인트를 부른다", async () => {
  const s = await run("wiki_search", { query: "배포", all_projects: true });
  assert.equal(pathname(last().path), "/api/wiki/search");
  assert.deepEqual(params(last().path), { q: "배포", limit: "8", all: "1" });
  assert.match(outText(s), /global:deploy — 배포/);

  const rd = await run("wiki_read", { slug: "global:deploy" });
  assert.equal(pathname(last().path), "/api/wiki/read");
  assert.deepEqual(params(last().path), { slug: "global:deploy", project: "github.com/test/demo" });
  assert.match(outText(rd), /^# 배포\n\(updated 2026-10-01;/);

  const w = await run("wiki_write", { slug: "deploy", title: "배포", body: "## 절차", mode: "append" });
  assert.equal(last().method, "POST");
  assert.equal(last().path, "/api/agent/wiki");
  assert.deepEqual(last().body, {
    slug: "deploy",
    title: "배포",
    body: "## 절차",
    mode: "append",
    project: { key: "github.com/test/demo", name: "demo", remote: null },
  });
  assert.equal(outText(w), "created: deploy — 배포");
});

test("G-010: memory_add·replace·remove는 POST /api/agent/memory에 action과 프로젝트를 보낸다", async () => {
  const project = { key: "github.com/test/demo", name: "demo", remote: null };
  const a = await run("memory_add", { target: "project", content: "Use pnpm" });
  assert.equal(last().path, "/api/agent/memory");
  assert.deepEqual(last().body, { action: "add", target: "project", content: "Use pnpm", project });
  assert.equal(outText(a), "add: #7 [project/convention] Use pnpm");
  await run("memory_replace", { target: "memory", old_text: "npm", content: "pnpm" });
  assert.deepEqual(last().body, { action: "replace", target: "memory", old_text: "npm", content: "pnpm", project });
  await run("memory_remove", { target: "user", old_text: "npm" });
  assert.deepEqual(last().body, { action: "remove", target: "user", old_text: "npm", project });
});

test("G-010: 서버 오류면 도구는 서버의 error 메시지(없으면 HTTP 상태)로 거부되고 멈추지 않는다", async () => {
  const calls: [string, Record<string, unknown>][] = [
    ["memory_search", { query: "x" }],
    ["session_search", { query: "x" }],
    ["memory_graph", { id: 1 }],
    ["wiki_search", { query: "x" }],
    ["wiki_read", { slug: "x" }],
    ["wiki_write", { slug: "x", body: "y" }],
    ["memory_add", { target: "memory", content: "x" }],
    ["memory_replace", { target: "memory", old_text: "x", content: "y" }],
    ["memory_remove", { target: "memory", old_text: "x" }],
  ];
  srv.mode = "error500";
  for (const [name, args] of calls) await assert.rejects(run(name, args), { message: "boom" }, name);
  srv.mode = "errorText";
  for (const [name, args] of calls) await assert.rejects(run(name, args), { message: "HTTP 500" }, name);
  await srv.stop();
  try {
    for (const [name, args] of calls) await assert.rejects(run(name, args), Error, name);
  } finally {
    await srv.restart();
  }
});

test("G-010: /memory는 상태와 프로젝트 링크를 알리고, 서버가 없으면 오류 알림만 낸다", async () => {
  await pi.commands.get("memory")!.handler("", ctx);
  const n = ctx.notices.at(-1)!;
  assert.equal(n.level, "info");
  assert.match(n.msg, /project github\.com\/test\/demo · 12 memories · 0 pending · llm test-model/);
  assert.ok(n.msg.endsWith(`${srv.url}/#/p/4`), n.msg);

  await srv.stop();
  try {
    await pi.commands.get("memory")!.handler("", ctx);
    assert.equal(ctx.notices.at(-1)!.level, "error");
    assert.match(ctx.notices.at(-1)!.msg, /memory server unreachable/);
  } finally {
    await srv.restart();
  }
});

test("G-010: /memory-pin은 standing 메모리를 만들고 --project면 프로젝트 id를 붙인다", async () => {
  await pi.commands.get("memory-pin")!.handler("항상 한국어로 답한다", ctx);
  assert.equal(last().path, "/api/entries");
  assert.deepEqual(last().body, { scope: "global", project_id: null, category: "standing", title: "항상 한국어로 답한다", body: "" });

  await pi.commands.get("memory-pin")!.handler("테스트 먼저 --project", ctx);
  assert.deepEqual(
    srv.requests.map((r) => r.path),
    ["/api/entries", "/api/context", "/api/entries"],
  );
  assert.deepEqual(last().body, { scope: "project", project_id: 4, category: "standing", title: "테스트 먼저", body: "" });

  srv.mode = "error500";
  await pi.commands.get("memory-pin")!.handler("x", ctx);
  assert.equal(ctx.notices.at(-1)!.level, "error");
  assert.match(ctx.notices.at(-1)!.msg, /memory-pin failed: boom/);
});

test("G-010: /wiki-compose는 버퍼를 먼저 보낸 뒤 이 세션으로 정리 작업을 건다", async () => {
  await pi.emit("message_end", userMsg("배포 절차"), ctx);
  await pi.emit("message_end", assistantMsg("compose up"), ctx);
  await pi.commands.get("wiki-compose")!.handler(" 배포 위주로 ", ctx);
  assert.deepEqual(srv.requests.map((r) => r.path), ["/api/turns", "/api/wiki/compose"]);
  assert.deepEqual(last().body, {
    project: { key: "github.com/test/demo", name: "demo", remote: null },
    session_id: "sess-tools",
    instruction: "배포 위주로",
  });
  assert.match(ctx.notices.at(-1)!.msg, /job #5 queued \(2 turns\)/);

  srv.mode = "error500";
  await quietErrors(() => pi.commands.get("wiki-compose")!.handler("", ctx));
  assert.equal(ctx.notices.at(-1)!.level, "error");
  assert.match(ctx.notices.at(-1)!.msg, /wiki-compose failed: boom/);
});
