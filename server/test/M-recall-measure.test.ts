// Recall measurement (ADR-0050, G-085): with debug mode on, /context logs the client kind, the
// session and what each recall gate dropped; when the session's turn arrives, a "recall.use" line
// says which recalled memories the agent's own output used; /debug/recall-report sums the log.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const { entry, ok, project, turn } = await import("./helpers.ts");
const { config, localDate } = await import("../src/config.ts");
const use = await import("../src/recall-use.ts");

type Any = any;
const today = () => localDate(new Date().toISOString());
const ofType = (type: string): Any[] => {
  const f = path.join(config.debug.logDir, `${today()}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === type) : [];
};

// Recall only adds memories the stable block left out: keep that block empty here.
config.contextBudget = 1;

test("G-085: off — nothing is remembered or logged", async () => {
  use.resetRecallUse();
  const p = await project("github.com/test/m-off", "m-off");
  await entry({ project_id: p.id, title: "m-off quokka setting", body: "quokka buffer 64KB" });
  await ok("POST", "/context", { project: { key: p.key, name: p.name }, prompt: "quokka buffer?", agent: "pi", sessionId: "m-off" });
  await turn([{ role: "user", text: "quokka buffer?" }, { role: "assistant", text: "quokka buffer is 64KB" }], p, "m-off");
  assert.equal(ofType("recall.use").length, 0);
});

test("G-085: a recalled memory the agent's answer draws on is \"used\"; one it ignored is not; the report sums both", async () => {
  await ok("PUT", "/debug", { enabled: true });
  use.resetRecallUse();
  const p = await project("github.com/test/m-use", "m-use");
  const ref = { key: p.key, name: p.name };
  const used = await entry({ project_id: p.id, title: "wombat 배포 절차", body: "wombat 은 helmfile apply 후 smoke-gate 스크립트로 확인한다" });
  const ignored = await entry({ project_id: p.id, title: "wombat 로그 보관", body: "wombat 로그는 loki retention 30일" });

  const ctx = await ok<Any>("POST", "/context", { project: ref, prompt: "wombat 배포 어떻게 해?", agent: "claude-code", sessionId: "m-use-1" });
  assert.deepEqual([...ctx.recalled].sort(), [used.id, ignored.id].sort());
  const line = ofType("context").at(-1);
  assert.equal(line.agent, "claude-code");
  assert.equal(line.session, "m-use-1");
  assert.deepEqual(Object.keys(line.gated).sort(), ["common", "graphMinZ", "keywordMinZ", "minZ"]);

  // The prompt as the turn records it (whitespace may differ); the answer uses one memory's words.
  await turn(
    [
      { role: "user", text: "wombat  배포 어떻게 해?\n" },
      { role: "assistant", text: "helmfile apply 하고 smoke-gate 를 돌립니다.", toolCalls: [{ name: "bash", args: "helmfile apply" }] },
      // Tool results are not the agent's words: loki / retention here does not count.
      { role: "tool", text: "loki retention 30d", name: "bash" },
    ],
    ref,
    "m-use-1",
  );
  const u = ofType("recall.use").at(-1);
  assert.equal(u.agent, "claude-code");
  assert.deepEqual(u.used, [used.id]);
  const byId = Object.fromEntries(u.memories.map((m: Any) => [m.id, m]));
  assert.ok(byId[used.id].matched.includes("helmfile"));
  assert.equal(byId[ignored.id].used, false, "words only in a tool result do not count");

  // Cited as #id counts even without shared words.
  await ok("POST", "/context", { project: ref, prompt: "wombat 로그 얼마나 보관해?", agent: "pi", sessionId: "m-use-2" });
  await turn([{ role: "user", text: "wombat 로그 얼마나 보관해?" }, { role: "assistant", text: `#${ignored.id} 기준으로 답합니다.` }], ref, "m-use-2");
  const cited = ofType("recall.use").at(-1);
  assert.ok(cited.memories.find((m: Any) => m.id === ignored.id).cited);

  // A turn of another session or prompt matches nothing.
  await ok("POST", "/context", { project: ref, prompt: "wombat 배포 어떻게 해?", agent: "pi", sessionId: "m-use-3" });
  const before = ofType("recall.use").length;
  await turn([{ role: "user", text: "다른 질문" }, { role: "assistant", text: "helmfile smoke-gate" }], ref, "m-use-3");
  assert.equal(ofType("recall.use").length, before);

  const r = await ok<Any>("GET", "/debug/recall-report?days=1");
  assert.ok(r.prompts["claude-code"] >= 1 && r.prompts.pi >= 2);
  assert.equal(r.use["claude-code"].used >= 1, true);
  assert.equal(r.use.pi.cited >= 1, true);
  assert.equal(typeof r.gated.common, "number");
  assert.equal(typeof r.gated.graphMinZ, "number");
  assert.ok(r.gatedPrompts >= 3, "only prompts that logged the gates are counted");
  await ok("PUT", "/debug", { enabled: false });
});

test("G-085: words that can tell one memory from another (replayed on production turns)", () => {
  // Particles off, nouns of 3+ characters, names / paths / versions.
  assert.equal(use.useTerm("마이그레이션을"), "마이그레이션");
  assert.equal(use.useTerm("10.10.40.70의"), "10.10.40.70");
  assert.equal(use.useTerm("db는"), null, "two letters say nothing");
  assert.equal(use.useTerm("helmfile"), "helmfile");
  // Generic words that matched on real turns without the memory being used.
  for (const w of ["내용", "커밋이", "범위로", "확인할", "확인해야", "확인하지", "그래서", "https", "json"]) assert.equal(use.useTerm(w), null, w);
  // Nouns that end like a verb form are kept.
  for (const [w, t] of [["메시지를", "메시지"], ["패키지", "패키지"], ["이미지", "이미지"]]) assert.equal(use.useTerm(w), t, w);
});

test("G-085: one batch with several prompts — each is judged on its own answer; a repeated prompt pairs in order", async () => {
  await ok("PUT", "/debug", { enabled: true });
  use.resetRecallUse();
  const p = await project("github.com/test/m-batch", "m-batch");
  const ref = { key: p.key, name: p.name };
  const a = await entry({ project_id: p.id, title: "numbat 백업 절차", body: "numbat 은 restic snapshot 후 rclone sync 로 보낸다" });
  await ok("POST", "/context", { project: ref, prompt: "numbat 백업?", agent: "pi", sessionId: "m-batch" });
  await ok("POST", "/context", { project: ref, prompt: "계속", agent: "pi", sessionId: "m-batch" });
  const before = ofType("recall.use").length;
  await turn(
    [
      { role: "user", text: "numbat 백업?" },
      { role: "assistant", text: "알아보겠습니다." },
      { role: "user", text: "계속" },
      { role: "assistant", text: "restic snapshot 뒤 rclone sync 입니다." },
    ],
    ref,
    "m-batch",
  );
  const lines = ofType("recall.use").slice(before);
  const first = lines.find((l) => l.prompt === "numbat 백업?");
  assert.ok(first, "the first prompt is judged");
  assert.equal(first.memories.find((m: Any) => m.id === a.id).used, false, "the next prompt's answer is not its evidence");
  await ok("PUT", "/debug", { enabled: false });
});

test("G-085: a redacted or very long prompt still pairs with the turn's copy", async () => {
  await ok("PUT", "/debug", { enabled: true });
  use.resetRecallUse();
  const p = await project("github.com/test/m-key", "m-key");
  const ref = { key: p.key, name: p.name };
  await entry({ project_id: p.id, title: "dingo 설정", body: "dingo 는 nginx upstream 으로 둔다" });
  const long = `dingo 설정 sk-${"a".repeat(40)} ${"로그 ".repeat(2500)}`;
  await ok("POST", "/context", { project: ref, prompt: long, agent: "pi", sessionId: "m-key" });
  const before = ofType("recall.use").length;
  await turn([{ role: "user", text: long }, { role: "assistant", text: "nginx upstream" }], ref, "m-key");
  assert.equal(ofType("recall.use").length, before + 1);
  await ok("PUT", "/debug", { enabled: false });
});

test("G-085: route kinds of graph extras", () => {
  assert.equal(use.viaKind("because #12"), "because");
  assert.equal(use.viaKind("replaces #3"), "replaces");
  assert.equal(use.viaKind("follows from #3 (2-hop)"), "follows from 2-hop");
  assert.equal(use.viaKind("PostgreSQL"), "entity");
  assert.equal(use.viaKind("similar to #4"), "similar to", "G-087 proximity routes");
  assert.equal(use.viaKind("same time as #4"), "same time as");
  assert.equal(use.agentKind("claude-code"), "claude-code");
  assert.equal(use.agentKind("Bad Agent!"), null);
  assert.equal(use.agentKind("constructor"), null, "only known client kinds");
});

test("G-085: both clients send agent and sessionId with /context", () => {
  const pi = fs.readFileSync(new URL("../../pi-extension/index.ts", import.meta.url), "utf8");
  assert.match(pi, /prompt: event\.prompt, agent: "pi", sessionId: ctx\.sessionManager\.getSessionId\(\)/);
  const cc = fs.readFileSync(new URL("../../claude-code-plugin/hooks/register.ts", import.meta.url), "utf8");
  assert.match(cc, /prompt, agent: "claude-code", sessionId: await \$\.session\.id\(\)/);
});
