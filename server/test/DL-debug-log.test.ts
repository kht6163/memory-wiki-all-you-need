// Debug mode (ADR-0035): one JSON-lines file per local day with requests,
// recall reasons, searches, LLM calls, curation results and the console.
// Off by default; never blocks a request and never writes secrets (G-065).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";

const { call, entry, llmReply, llmReset, ok, project, runQueueOnce, turn } = await import("./helpers.ts");
const { config, localDate } = await import("../src/config.ts");
const dbg = await import("../src/debug-log.ts");

type Any = any;
const today = () => localDate(new Date().toISOString());
const dir = () => config.debug.logDir;
const lines = (date = today()): Any[] => {
  const f = path.join(dir(), `${date}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const ofType = (type: string) => lines().filter((l) => l.type === type);

beforeEach(() => {
  llmReset();
});

test("ADR-0035: off by default — no files, /health says so, responses unchanged", async () => {
  const st = await ok<Any>("GET", "/debug");
  assert.equal(st.enabled, false);
  assert.equal(st.source, "default");
  assert.deepEqual(st.files, []);
  assert.equal((await ok<Any>("GET", "/health")).debug, false);
  const r = await ok<Any>("POST", "/context", { project: null, prompt: "anything" });
  assert.equal("debug" in r, false);
  assert.equal(fs.existsSync(dir()), false, "nothing written while off");
});

test("ADR-0035: switching on persists in debug.json; /context logs the prompt (secrets redacted) and why recall picked each memory", async () => {
  const on = await ok<Any>("PUT", "/debug", { enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(on.source, "file");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config.dataDir, "debug.json"), "utf8")), { enabled: true });
  assert.equal((await ok<Any>("GET", "/stats")).debug, true);

  const p = await project("github.com/test/debug", "debug");
  const saved = config.contextBudget;
  config.contextBudget = 1; // recall only adds what the stable block left out
  try {
    const m = await entry({ project_id: p.id, title: "sqlite busy timeout", body: "set busy_timeout to 5000" });
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const r = await ok<Any>("POST", "/context", { project: { key: p.key, name: p.name }, prompt: `sqlite busy timeout? my key is ${secret}` });
    assert.equal("debug" in r, false, "the extension payload does not grow");
    assert.ok(r.recalled.includes(m.id));
    const ctx = ofType("context").at(-1);
    assert.ok(ctx, "context line written");
    assert.equal(ctx.project.key, p.key);
    assert.ok(!ctx.prompt.includes(secret), "secret redacted");
    assert.match(ctx.prompt, /\[REDACTED:openai-key\]/);
    assert.ok(ctx.recalled.includes(m.id));
    const hit = ctx.hits.find((h: Any) => h.id === m.id);
    assert.ok(hit && hit.keyword > 0, "keyword score of the hit");
    assert.equal(ctx.embed.result, "off");
    assert.equal(typeof ctx.ms, "number");
    assert.ok(!fs.readFileSync(path.join(dir(), `${today()}.jsonl`), "utf8").includes(secret));
  } finally {
    config.contextBudget = saved;
  }
  // http lines: /context yes, polling no.
  await ok("GET", "/health");
  await ok("GET", "/stats");
  const http = ofType("http").map((l) => l.path);
  assert.ok(http.includes("/context"));
  assert.ok(!http.includes("/health") && !http.includes("/stats"));
  // search line with hits
  await ok("GET", `/search?q=${encodeURIComponent("busy timeout")}&project_id=${p.id}`);
  const s = ofType("search").at(-1);
  assert.equal(s.q, "busy timeout");
  assert.ok(s.hits.length >= 1);
  // filtered read
  const text = await call("GET", `/debug/logs/${today()}?type=search`);
  assert.equal(text.status, 200);
  // call() parses a one-line body as JSON already.
  const got = typeof text.data === "string" ? text.data.trim().split("\n").map((l) => JSON.parse(l)) : [text.data];
  assert.ok(got.length >= 1);
  for (const l of got) assert.equal(l.type, "search");
  assert.ok((await ok<Any>("GET", "/debug")).files.some((f: Any) => f.date === today() && f.bytes > 0));
});

test("ADR-0035: an LLM call is logged with its caller label, prompt and reply; curation logs ops and what was applied", async () => {
  await ok("PUT", "/debug", { enabled: true });
  llmReply({ ops: [{ op: "add", scope: "global", title: "debug-mode curation note", body: "x", category: "fact" }], note: "added one" });
  await turn([
    { role: "user", text: "remember that the debug note exists please" },
    { role: "assistant", text: "ok" },
  ]);
  await runQueueOnce();
  const llm = ofType("llm").at(-1);
  assert.equal(llm.label, "curation");
  assert.equal(llm.messages.length, 2);
  assert.match(llm.raw, /debug-mode curation note/);
  const cur = ofType("curation").at(-1);
  assert.equal(cur.ops.length, 1);
  assert.equal(cur.applied.length, 1);
  assert.equal(cur.note, "added one");
});

test("ADR-0035: console lines are captured while on", async () => {
  await ok("PUT", "/debug", { enabled: true });
  dbg.captureConsole();
  dbg.captureConsole(); // once only
  const orig = console.warn;
  console.warn("[test] captured line", 42);
  assert.equal(console.warn, orig);
  const c = ofType("console").filter((l) => l.message === "[test] captured line 42");
  assert.equal(c.length, 1, "written once (no double wrap)");
  assert.equal(c[0].level, "warn");
});

test("G-065: long strings are cut; a day stops at the size cap with one marker", async () => {
  await ok("PUT", "/debug", { enabled: true });
  const saved = { ...config.debug };
  try {
    config.debug.maxStringChars = 40;
    dbg.debugLog("probe", { text: "x".repeat(500) });
    const p = ofType("probe").at(-1);
    assert.match(p.text, /^x{40}… \(500 chars\)$/);
    // size cap on a separate day file
    config.debug.maxBytesPerDay = 400;
    const at = new Date("2031-05-05T03:00:00Z");
    for (let i = 0; i < 20; i++) dbg.debugLog("fill", { i }, at);
    const day = localDate(at.toISOString());
    const got = lines(day);
    assert.equal(got.at(-1).type, "truncated");
    assert.equal(got.filter((l) => l.type === "truncated").length, 1);
    assert.ok(fs.statSync(path.join(dir(), `${day}.jsonl`)).size <= 400 + 200);
    dbg.debugLog("fill", { i: 99 }, at);
    assert.equal(lines(day).length, got.length, "nothing more that day");
  } finally {
    Object.assign(config.debug, saved);
    dbg.resetDebugState();
  }
});

test("ADR-0035: the day file follows TIMEZONE, and files older than DEBUG_LOG_KEEP_DAYS are pruned", async () => {
  await ok("PUT", "/debug", { enabled: true });
  const savedTz = config.timezone;
  const savedKeep = config.debug.keepDays;
  try {
    config.timezone = "Asia/Seoul";
    dbg.debugLog("tz", {}, new Date("2032-01-01T15:30:00Z")); // 00:30 on Jan 2 in Seoul
    assert.ok(fs.existsSync(path.join(dir(), "2032-01-02.jsonl")));
    for (const d of ["2031-12-20", "2031-12-25", "2031-12-26"]) fs.writeFileSync(path.join(dir(), `${d}.jsonl`), "{}\n");
    fs.writeFileSync(path.join(dir(), "notes.txt"), "kept");
    config.debug.keepDays = 8; // 2032-01-02 back to 2031-12-26
    const removed = dbg.pruneDebugLogs(new Date("2032-01-01T15:30:00Z"));
    assert.ok(removed.includes("2031-12-20") && removed.includes("2031-12-25"));
    assert.ok(fs.existsSync(path.join(dir(), "2031-12-26.jsonl")));
    assert.ok(fs.existsSync(path.join(dir(), "notes.txt")), "only day files are touched");
  } finally {
    config.timezone = savedTz;
    config.debug.keepDays = savedKeep;
    dbg.resetDebugState();
  }
});

test("ADR-0035: DEBUG_MODE forces it on (the web cannot turn it off); bad dates are refused before touching the disk", async () => {
  const saved = config.debug.env;
  config.debug.env = true;
  try {
    const st = await ok<Any>("GET", "/debug");
    assert.equal(st.enabled, true);
    assert.equal(st.source, "env");
    const r = await call<Any>("PUT", "/debug", { enabled: false });
    assert.equal(r.status, 409);
  } finally {
    config.debug.env = saved;
  }
  assert.equal((await call<Any>("PUT", "/debug", { enabled: "yes" })).status, 400);
  for (const bad of ["2026-1-1", "..%2F..%2Fetc", "2026-10-05.jsonl", "latest"]) assert.equal((await call("GET", `/debug/logs/${bad}`)).status, 400, bad);
  assert.equal((await call("GET", "/debug/logs/1999-01-01")).status, 404);
});

test("G-065: an unwritable log dir never breaks a request", async () => {
  await ok("PUT", "/debug", { enabled: true });
  const saved = config.debug.logDir;
  const blocker = path.join(config.dataDir, "not-a-dir");
  fs.writeFileSync(blocker, "file in the way");
  config.debug.logDir = path.join(blocker, "logs");
  dbg.resetDebugState();
  try {
    const r = await call<Any>("POST", "/context", { project: null, prompt: "still works" });
    assert.equal(r.status, 200);
    assert.equal(typeof r.data.system, "string");
  } finally {
    config.debug.logDir = saved;
    dbg.resetDebugState();
  }
});

test("ADR-0035: switching off writes a last line and then stops", async () => {
  await ok("PUT", "/debug", { enabled: true });
  const before = lines().length;
  const off = await ok<Any>("PUT", "/debug", { enabled: false });
  assert.equal(off.enabled, false);
  const after = lines();
  assert.equal(after.at(-1).type, "debug");
  assert.equal(after.at(-1).enabled, false);
  await ok("POST", "/context", { project: null, prompt: "not logged" });
  assert.equal(lines().length, after.length);
  assert.ok(after.length > before);
});

test("G-065: a secret across the cut point is redacted (redact first, then cut)", async () => {
  await ok("PUT", "/debug", { enabled: true });
  const saved = config.debug.maxStringChars;
  config.debug.maxStringChars = 30;
  try {
    const key = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    dbg.debugLog("cut", { text: `prompt text: ${key} and more` });
    const raw = fs.readFileSync(path.join(dir(), `${today()}.jsonl`), "utf8");
    assert.ok(!raw.includes("sk-proj-ABCDEFGH"), "no start of the key in clear");
    assert.match(ofType("cut").at(-1).text, /REDACTED/);
  } finally {
    config.debug.maxStringChars = saved;
  }
});

test("G-065: the logs folder removed while running is recreated; a failed mkdir is retried on the next event", async () => {
  await ok("PUT", "/debug", { enabled: true });
  dbg.debugLog("before", {});
  fs.rmSync(dir(), { recursive: true, force: true });
  dbg.debugLog("after-rm", {});
  assert.equal(ofType("after-rm").length, 1, "folder recreated");
  const saved = config.debug.logDir;
  const blocker = path.join(config.dataDir, "blocker-file");
  fs.writeFileSync(blocker, "x");
  config.debug.logDir = path.join(blocker, "logs");
  dbg.resetDebugState();
  try {
    dbg.debugLog("lost", {}); // cannot create the folder: dropped
    config.debug.logDir = saved;
    dbg.debugLog("recovered", {});
    assert.equal(ofType("recovered").length, 1, "the next event opens the day again");
  } finally {
    config.debug.logDir = saved;
    dbg.resetDebugState();
  }
});

test("ADR-0035: 열기 shows the day as text, 받기 downloads ndjson", async () => {
  await ok("PUT", "/debug", { enabled: true });
  dbg.debugLog("view", {});
  const { api } = await import("../src/api.ts");
  const open = await api.request(`/debug/logs/${today()}`);
  assert.equal(open.status, 200);
  assert.match(open.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(open.headers.get("content-disposition"), null);
  assert.match(await open.text(), /"type":"view"/);
  const dl = await api.request(`/debug/logs/${today()}?download=1&type=view`);
  assert.match(dl.headers.get("content-type") ?? "", /x-ndjson/);
  assert.match(dl.headers.get("content-disposition") ?? "", /attachment/);
  const body = (await dl.text()).trim().split("\n");
  assert.ok(body.length >= 1 && body.every((l) => JSON.parse(l).type === "view"));
  assert.equal(await dbg.readDebugLog("1999-01-01"), null);
});
