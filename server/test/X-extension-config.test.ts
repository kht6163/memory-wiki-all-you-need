// The extension reads its settings from <agent dir>/extensions/memory-wiki-all-you-need.json
// (like other pi extensions), env vars override the file, a broken file never stops pi,
// and /memory-server saves the URL there without dropping other keys (ADR-0033).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { beforeAgentStartEvent, loadExtension, makeCtx, makePi, quietErrors, startMockServer, type FakePi, type MockServer } from "./X-ext-harness.ts";

let srv: MockServer;
let srv2: MockServer;
let pi: FakePi;
let agentDir: string;
let file: string;
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));

before(async () => {
  srv = await startMockServer();
  srv2 = await startMockServer();
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwayn-agent-"));
  file = path.join(agentDir, "extensions", "memory-wiki-all-you-need.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ serverUrl: `${srv.url}/`, timeoutMs: 1000, settleDelayMs: 60000, project: "github.com/test/from-file" }));
  for (const k of ["MEMORY_SERVER_URL", "MEMORY_TIMEOUT_MS", "MEMORY_SETTLE_DELAY_MS", "MEMORY_PROJECT", "MEMORY_DISABLED"]) delete process.env[k];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  srv.routes.set("/api/context", () => ({ system: "S", recall: "", project: null }));
  srv2.routes.set("/api/health", () => ({ entries: 3 }));
  pi = await loadExtension({ settingsFile: true });
});
after(async () => {
  await srv.close();
  await srv2.close();
});

test("ADR-0033: the server URL, timeouts and project key come from the settings file", async () => {
  const ctx = makeCtx(agentDir);
  await pi.emit("session_start", { type: "session_start" }, ctx);
  await pi.emit("before_agent_start", beforeAgentStartEvent("hi"), ctx);
  const req = srv.requests.find((r) => r.path === "/api/context");
  assert.ok(req, "the extension called the server from the settings file");
  assert.equal(req.body.project.key, "github.com/test/from-file");
});

test("ADR-0033: /memory-server shows the URL and where it came from", async () => {
  const ctx = makeCtx(agentDir);
  await pi.commands.get("memory-server")!.handler("", ctx);
  const n = ctx.notices.at(-1)!;
  assert.match(n.msg, new RegExp(`${srv.url} \\(from settings file\\)`));
  assert.match(n.msg, /memory-wiki-all-you-need\.json/);
});

test("ADR-0033: /memory-server <url> saves it to the file, keeps other keys and switches right away", async () => {
  const ctx = makeCtx(agentDir);
  await pi.commands.get("memory-server")!.handler(`  ${srv2.url}/ `, ctx);
  assert.deepEqual(read(), { serverUrl: srv2.url, timeoutMs: 1000, settleDelayMs: 60000, project: "github.com/test/from-file" });
  assert.match(ctx.notices.at(-1)!.msg, /memory server set to .* \(3 memories\)/);
  assert.ok(srv2.requests.some((r) => r.path === "/api/health"));
  await pi.emit("before_agent_start", beforeAgentStartEvent("again"), ctx);
  assert.ok(srv2.requests.some((r) => r.path === "/api/context"), "later requests go to the new server");
});

test("ADR-0033: /memory-server refuses a non-http URL and leaves the file alone", async () => {
  const ctx = makeCtx(agentDir);
  const before = fs.readFileSync(file, "utf8");
  for (const bad of ["ftp://x.example", "not a url"]) {
    await pi.commands.get("memory-server")!.handler(bad, ctx);
    assert.equal(ctx.notices.at(-1)!.level, "error", bad);
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("ADR-0033: env vars override the file; a broken or non-object file reads as empty", async () => {
  const { resolveSettings, readConfig, writeConfig } = await import("../../pi-extension/index.ts");
  const f = { serverUrl: "http://file.example:1", timeoutMs: 900, project: "p/file", disabled: false };
  const both = resolveSettings({ MEMORY_SERVER_URL: "http://env.example:2/", MEMORY_TIMEOUT_MS: "300", MEMORY_PROJECT: "p/env" }, f);
  assert.deepEqual([both.server, both.source, both.timeoutMs, both.project], ["http://env.example:2", "env", 300, "p/env"]);
  const fileOnly = resolveSettings({}, f);
  assert.deepEqual([fileOnly.server, fileOnly.source, fileOnly.timeoutMs, fileOnly.settleDelayMs], ["http://file.example:1", "file", 900, 8000]);
  const none = resolveSettings({}, {});
  assert.equal(none.source, "default");
  assert.equal(resolveSettings({}, { disabled: true }).disabled, true);
  assert.equal(resolveSettings({}, { timeoutMs: -5 }).timeoutMs, 1500, "a bad number falls back to the default");

  const tmp = path.join(agentDir, "broken.json");
  await quietErrors(async () => {
    fs.writeFileSync(tmp, "{ not json");
    assert.deepEqual(readConfig(tmp), {});
    fs.writeFileSync(tmp, "[1, 2]");
    assert.deepEqual(readConfig(tmp), {});
  });
  assert.deepEqual(readConfig(path.join(agentDir, "missing.json")), {});
  // Blank env values do not hide the file; a non-number in the file is ignored.
  assert.equal(resolveSettings({ MEMORY_TIMEOUT_MS: "", MEMORY_SETTLE_DELAY_MS: "  " }, { timeoutMs: 2500, settleDelayMs: 9000 }).timeoutMs, 2500);
  assert.equal(resolveSettings({ MEMORY_SETTLE_DELAY_MS: "  " }, { settleDelayMs: 9000 }).settleDelayMs, 9000);
  assert.equal(resolveSettings({}, { timeoutMs: null as unknown as number }).timeoutMs, 1500);
  // writeConfig never overwrites a file it cannot read as an object.
  fs.writeFileSync(tmp, '{"timeoutMs": 2500,}');
  assert.throws(() => writeConfig({ serverUrl: "http://x.example" }, tmp), /JSON/);
  assert.equal(fs.readFileSync(tmp, "utf8"), '{"timeoutMs": 2500,}');
  fs.writeFileSync(tmp, "[1]");
  assert.throws(() => writeConfig({ serverUrl: "http://x.example" }, tmp), /not a JSON object/);
  const fresh = path.join(agentDir, "nested", "dir", "c.json");
  writeConfig({ serverUrl: "http://a.example" }, fresh);
  writeConfig({ timeoutMs: 5 }, fresh);
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, "utf8")), { serverUrl: "http://a.example", timeoutMs: 5 });
});

test("ADR-0033: /memory-server leaves a broken settings file alone and says so", async () => {
  const ctx = makeCtx(agentDir);
  const saved = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, '{"project": "keep-me",}');
  await quietErrors(() => pi.commands.get("memory-server")!.handler(srv.url, ctx));
  assert.equal(ctx.notices.at(-1)!.level, "error");
  assert.match(ctx.notices.at(-1)!.msg, /fix or remove the file/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"project": "keep-me",}');
  fs.writeFileSync(file, saved);
});

test("ADR-0033: /memory-config <key> <value> saves and applies at once; unset removes the key", async () => {
  const ctx = makeCtx(agentDir);
  const cfg = pi.commands.get("memory-config")!;
  await cfg.handler("timeoutMs 2500", ctx);
  assert.equal(read().timeoutMs, 2500);
  assert.match(ctx.notices.at(-1)!.msg, /timeoutMs = 2500 {2}\(settings file\)/);
  await cfg.handler("project github.com/test/changed", ctx);
  await pi.emit("before_agent_start", beforeAgentStartEvent("p"), ctx);
  const req = srv2.requests.filter((r) => r.path === "/api/context").at(-1)!; // srv2: set by the /memory-server test above
  assert.equal(req.body.project.key, "github.com/test/changed", "the project override applies without a restart");
  await cfg.handler("unset project", ctx);
  assert.equal("project" in read(), false);
  await cfg.handler("disabled true", ctx);
  assert.equal(read().disabled, true);
  assert.match(ctx.notices.at(-1)!.msg, /run \/reload to apply/);
  await cfg.handler("unset disabled", ctx);
  for (const bad of ["timeoutMs 0", "timeoutMs abc", "settleDelayMs -1", "disabled maybe", "serverUrl ftp://x", "nope 1", "unset nope"]) {
    const before = JSON.stringify(read());
    await cfg.handler(bad, ctx);
    assert.equal(ctx.notices.at(-1)!.level, "error", bad);
    assert.equal(JSON.stringify(read()), before, bad);
  }
  await cfg.handler("timeoutMs", ctx);
  assert.match(ctx.notices.at(-1)!.msg, /^timeoutMs = 2500/);
});

test("ADR-0033: /memory-config with no arguments lets you pick a setting and type a value", async () => {
  const ctx = makeCtx(agentDir);
  const cfg = pi.commands.get("memory-config")!;
  ctx.answers.push(undefined); // cancelled: nothing changes
  await cfg.handler("", ctx);
  assert.equal(ctx.asked[0].kind, "select");
  assert.deepEqual(ctx.asked[0].options!.map((o) => o.split(" ")[0]), ["serverUrl", "timeoutMs", "settleDelayMs", "project", "disabled"]);
  const pick = ctx.asked[0].options!.find((o) => o.startsWith("settleDelayMs"))!;
  ctx.answers.push(pick, "9000");
  await cfg.handler("", ctx);
  assert.equal(read().settleDelayMs, 9000);
  assert.equal(ctx.asked.at(-1)!.kind, "input");
  ctx.answers.push(ctx.asked[0].options!.find((o) => o.startsWith("settleDelayMs"))!, "unset");
  await cfg.handler("", ctx);
  assert.equal("settleDelayMs" in read(), false);
  ctx.answers.push(ctx.asked[0].options!.find((o) => o.startsWith("disabled"))!, "true");
  await cfg.handler("", ctx);
  assert.equal(read().disabled, true);
  await cfg.handler("unset disabled", ctx);
});

test("ADR-0033: /memory-config autocompletes keys, unset targets and true/false", async () => {
  const { configCompletions } = await import("../../pi-extension/index.ts");
  assert.deepEqual(configCompletions("")!.map((i) => i.label), ["serverUrl", "timeoutMs", "settleDelayMs", "project", "disabled", "unset"]);
  assert.deepEqual(configCompletions("se")!.map((i) => i.value), ["serverUrl ", "settleDelayMs "]);
  assert.deepEqual(configCompletions("unset p")!.map((i) => i.value), ["unset project"]);
  assert.deepEqual(configCompletions("disabled t")!.map((i) => i.value), ["disabled true"]);
  assert.equal(configCompletions("timeoutMs 1"), null);
  assert.equal(configCompletions("zzz"), null);
});

test("ADR-0033: only MEMORY_DISABLED=1 counts as an env override, like resolveSettings", async () => {
  const { envOverrides } = await import("../../pi-extension/index.ts");
  assert.equal(envOverrides("disabled", { MEMORY_DISABLED: "0" }), null);
  assert.equal(envOverrides("disabled", { MEMORY_DISABLED: "1" }), "1");
  assert.equal(envOverrides("timeoutMs", { MEMORY_TIMEOUT_MS: " " }), null);
  assert.equal(envOverrides("timeoutMs", { MEMORY_TIMEOUT_MS: "900" }), "900");
  const ctx = makeCtx(agentDir);
  process.env.MEMORY_DISABLED = "0";
  process.env.MEMORY_TIMEOUT_MS = "900";
  try {
    await pi.commands.get("memory-config")!.handler("disabled true", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /run \/reload to apply/, "MEMORY_DISABLED=0 does not override the file");
    await pi.commands.get("memory-config")!.handler("timeoutMs 2000", ctx);
    assert.equal(ctx.notices.at(-1)!.level, "warning");
    assert.match(ctx.notices.at(-1)!.msg, /MEMORY_TIMEOUT_MS=900 still overrides it/);
    await pi.commands.get("memory-config")!.handler("timeoutMs", ctx);
    assert.match(ctx.notices.at(-1)!.msg, /timeoutMs = 900 {2}\(env MEMORY_TIMEOUT_MS\)/);
  } finally {
    delete process.env.MEMORY_DISABLED;
    delete process.env.MEMORY_TIMEOUT_MS;
  }
});

test("ADR-0033: when disabled, only /memory-config is registered and it can turn the extension back on", async () => {
  const mod = await import("../../pi-extension/index.ts");
  assert.equal(read().disabled, true, "left on by the previous test");
  const off = makePi();
  mod.default(off.api);
  assert.deepEqual([...off.commands.keys()], ["memory-config"]);
  assert.equal(off.tools.size, 0);
  const ctx = makeCtx(agentDir);
  await off.commands.get("memory-config")!.handler("", ctx);
  assert.match(ctx.notices.at(-1)!.msg, /\/memory-config disabled false/);
  await off.commands.get("memory-config")!.handler("disabled false", ctx);
  assert.equal(read().disabled, false);
  const on = makePi();
  mod.default(on.api);
  assert.ok(on.commands.has("memory") && on.tools.size > 0, "registered again after the reload");
});
