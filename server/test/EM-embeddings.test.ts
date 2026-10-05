// Semantic search (ADR-0034): memories and wiki pages get vectors from an
// OpenAI-compatible /embeddings endpoint (faked by embed-stub.ts) and search
// fuses keyword and vector ranks, so a Korean question finds an English memory.
// Embedding failures never block /context (G-063); vectors are per model (G-064).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

process.env.EMBED_BASE_URL = "http://embed.test/v1";
process.env.EMBED_MODEL = "fake-m3";

const { call, db, entry, llmReply, llmReset, ok, project, runQueueOnce, turn } = await import("./helpers.ts");
const { embedCalls, embedMode, embedReset } = await import("./embed-stub.ts");
const { config } = await import("../src/config.ts");
const emb = await import("../src/embeddings.ts");

type Any = any;
const search = (q: string, extra = "") => ok<Any[]>("GET", `/search?q=${encodeURIComponent(q)}${extra}`);
const context = (prompt: string, p: Any = null) => ok<Any>("POST", "/context", { project: p, prompt });
const rows = (table: string) => db.prepare(`SELECT * FROM ${table}`).all() as Any[];

// Recall only adds memories the stable block left out: keep that block empty here.
config.contextBudget = 1;

beforeEach(() => {
  embedReset();
  emb.resetQueryState();
  llmReset();
});

test("ADR-0034: memories are indexed in the background; an edit makes the vector stale, the trash is skipped", async () => {
  const a = await entry({ title: "Deploy procedure", body: "docker compose up -d --build in the compose folder" });
  const gone = await entry({ title: "Old weather note", body: "irrelevant" });
  await ok("DELETE", `/entries/${gone.id}`);
  assert.equal((await ok<Any>("GET", "/stats")).embedPending, 1, "one live memory without a vector");
  await emb.indexAll();
  const r = rows("entry_embeddings").find((x) => x.entry_id === a.id);
  assert.ok(r, "vector stored");
  assert.equal(r.model, "fake-m3");
  assert.equal(r.dim, 37);
  assert.equal(r.vector.byteLength, 37 * 4);
  assert.ok(!rows("entry_embeddings").some((x) => x.entry_id === gone.id), "a memory in the trash is not embedded");
  const s = await ok<Any>("GET", "/stats");
  assert.equal(s.embed, "fake-m3");
  assert.equal(s.embedPending, 0);
  await ok("PATCH", `/entries/${a.id}`, { body: "docker compose pull, then up -d" });
  assert.equal((await ok<Any>("GET", "/stats")).embedPending, 1, "edited text → stale vector");
  const n = embedCalls.length;
  await emb.indexAll();
  assert.equal(embedCalls.length, n + 1);
  assert.match(embedCalls.at(-1)!.input[0], /docker compose pull/);
  assert.equal((await ok<Any>("GET", "/health")).embedPending, 0);
  // Purging a memory takes its vector with it (FK cascade).
  await ok("DELETE", `/entries/${a.id}`);
  await ok("DELETE", `/entries/${a.id}/purge`);
  assert.ok(!rows("entry_embeddings").some((x) => x.entry_id === a.id));
});

test("ADR-0034: a question in another language finds the memory by meaning; keyword-only search does not", async () => {
  const m = await entry({ title: "Port setting", body: "The server listens on 8765; change it with the PORT env var." });
  await emb.indexAll();
  const hits = await search("서버 포트 몇 번이야?");
  assert.equal(hits[0]?.id, m.id, "Korean question → English memory");
  assert.equal(typeof hits[0].score, "number");
  const saved = config.embed.baseUrl;
  config.embed.baseUrl = "";
  try {
    assert.ok(!(await search("서버 포트 몇 번이야?")).some((h) => h.id === m.id), "embeddings off: no shared word, no hit");
  } finally {
    config.embed.baseUrl = saved;
  }
  // Japanese too, and a word match still ranks with the vector match.
  assert.equal((await search("サーバーのポートは?"))[0]?.id, m.id);
  assert.equal((await search("PORT env var"))[0]?.id, m.id);
});

test("ADR-0034: recall injects a memory found only by meaning, never an unrelated one", async () => {
  const p = await project("github.com/test/embed-recall", "embed-recall");
  const m = await entry({ project_id: p.id, title: "Deploy procedure", body: "docker compose up -d --build; back up the DB first" });
  await emb.indexAll();
  const r = await context("운영에 새 버전 배포하려면?", { key: p.key, name: p.name });
  assert.ok(r.recalled.includes(m.id), "Korean prompt recalls the English memory");
  assert.match(r.recall, /Deploy procedure/);
  const none = await context("오늘 날씨 어때?", { key: p.key, name: p.name });
  assert.ok(!none.recalled.includes(m.id), "unrelated prompt: nothing by vector");
  // The recall floor is its own setting: above every cosine, only keyword hits remain.
  const saved = config.embed.recallMinSimilarity;
  config.embed.recallMinSimilarity = 0.999;
  try {
    assert.ok(!(await context("운영에 새 버전 배포하려면?", { key: p.key, name: p.name })).recalled.includes(m.id));
    assert.ok((await search("운영에 새 버전 배포하려면?", `&project_id=${p.id}`)).some((h) => h.id === m.id), "search uses the lower search floor");
  } finally {
    config.embed.recallMinSimilarity = saved;
  }
});

test("G-063: a failing or hanging embedding endpoint never blocks /context — keyword recall, then a back-off", async () => {
  const p = await project("github.com/test/embed-down", "embed-down");
  const m = await entry({ project_id: p.id, title: "sqlite tuning", body: "WAL mode, busy_timeout 5000" });
  await emb.indexAll();
  embedMode("error");
  const r = await call<Any>("POST", "/context", { project: { key: p.key, name: p.name }, prompt: "sqlite tuning tips" });
  assert.equal(r.status, 200);
  assert.ok(r.data.recalled.includes(m.id), "keyword recall still works");
  const n = embedCalls.length;
  await context("another prompt about sqlite", { key: p.key, name: p.name });
  assert.equal(embedCalls.length, n, "endpoint skipped during the back-off");
  assert.equal((await search("sqlite tuning", `&project_id=${p.id}`))[0]?.id, m.id, "search falls back too");

  emb.resetQueryState();
  embedMode("hang");
  const saved = config.embed.queryTimeoutMs;
  config.embed.queryTimeoutMs = 150;
  try {
    const t = Date.now();
    const h = await context("sqlite tuning again", { key: p.key, name: p.name });
    assert.ok(Date.now() - t < 1500, `returned in ${Date.now() - t} ms`);
    assert.ok(h.recalled.includes(m.id));
  } finally {
    config.embed.queryTimeoutMs = saved;
  }
});

test("ADR-0034: the same prompt is embedded once (query cache)", async () => {
  await context("cache me: database question");
  await context("cache me: database question");
  assert.equal(embedCalls.filter((c) => c.input[0] === "cache me: database question").length, 1);
});

test("G-064: vectors of another model are never compared; a model change re-embeds everything", async () => {
  const m = await entry({ title: "Timezone", body: "The user is in Asia/Seoul." });
  await emb.indexAll();
  assert.equal((await search("내 시간대가 뭐지?"))[0]?.id, m.id);
  const saved = config.embed.model;
  config.embed.model = "fake-other";
  emb.resetVectorCache();
  emb.resetQueryState();
  try {
    assert.ok(!(await search("내 시간대가 뭐지?")).some((h) => h.id === m.id), "old-model vectors are ignored");
    assert.ok((await ok<Any>("GET", "/stats")).embedPending >= 1, "every memory is stale under the new model");
    await emb.indexAll();
    assert.ok(rows("entry_embeddings").every((x) => x.model === "fake-other"));
    assert.equal((await search("내 시간대가 뭐지?"))[0]?.id, m.id);
  } finally {
    config.embed.model = saved;
    emb.resetVectorCache();
    emb.resetQueryState();
    await emb.indexAll();
  }
});

test("ADR-0034: a text the endpoint refuses is skipped; the rest of the batch is indexed", async () => {
  const bad = await entry({ title: "REFUSE-ME", body: "x" });
  const good = await entry({ title: "fine database note", body: "y" });
  embedMode((input) => (input.some((t) => t.includes("REFUSE-ME")) ? new Response("input too long", { status: 400 }) : undefined));
  await emb.indexAll();
  const ids = rows("entry_embeddings").map((x) => x.entry_id);
  assert.ok(ids.includes(good.id));
  assert.ok(!ids.includes(bad.id));
  const st = await ok<Any>("GET", "/stats");
  assert.equal(st.embedPending, 0, "the refused text is not retried until it changes");
  assert.ok(st.embedSkipped >= 1, "and it is counted");
});

test("ADR-0034: wiki search finds a page by meaning", async () => {
  const page = await ok<Any>("POST", "/wiki/pages", { title: "Release runbook", body: "How we ship to production: tag, CI builds the image, compose pull." });
  await emb.indexAll();
  assert.ok(rows("wiki_embeddings").some((x) => x.page_id === page.id));
  const hits = await ok<Any[]>("GET", `/wiki/search?q=${encodeURIComponent("배포 절차 문서")}`);
  assert.equal(hits[0]?.id, page.id);
  assert.ok(hits[0].snippet.length > 0);
});

test("ADR-0034: turn curation also shows memories that match the turn by meaning", async () => {
  const g = await entry({ title: "Deploy procedure (global)", body: "docker compose up -d --build" });
  await emb.indexAll();
  let shown = "";
  llmReply((c: { user: string }) => {
    shown = c.user;
    return { ops: [], note: "nothing new" };
  });
  await turn([
    { role: "user", text: "운영에 올리는 방법 바꿨어" },
    { role: "assistant", text: "알겠습니다" },
  ]);
  await runQueueOnce();
  assert.match(shown, new RegExp(`"id":${g.id}\\b`), "the English memory is a candidate for a Korean turn");
});

test("G-064: an edited memory is not matched by its old vector before it is re-embedded", async () => {
  const m = await entry({ title: "Timezone of the build box", body: "UTC on the build box" });
  await emb.indexAll();
  assert.ok((await search("시간대 설정")).some((h) => h.id === m.id), "found by meaning");
  await ok("PATCH", `/entries/${m.id}`, { title: "Build box disk", body: "500 GB, ext4" });
  emb.resetQueryState();
  assert.ok(!(await search("시간대 설정")).some((h) => h.id === m.id), "the old vector (time zone) no longer matches");
  await emb.indexAll();
  assert.ok(!(await search("시간대 설정")).some((h) => h.id === m.id));
});

test("ADR-0034: when every text fails (bad key, wrong URL, rate limit) nothing is skipped and the error shows until it recovers", async () => {
  const skippedBefore = (await ok<Any>("GET", "/stats")).embedSkipped;
  await entry({ title: "port note one", body: "a" });
  await entry({ title: "port note two", body: "b" });
  embedMode(() => new Response("unauthorized", { status: 401 }));
  await assert.rejects(emb.indexAll(), /HTTP 401/);
  const s = await ok<Any>("GET", "/stats");
  assert.ok(s.embedPending >= 2, "still pending, not silently skipped");
  assert.equal(s.embedSkipped, skippedBefore);
  assert.match(s.embedError, /401/);
  embedMode("ok");
  await emb.indexAll();
  const after = await ok<Any>("GET", "/stats");
  assert.equal(after.embedPending, 0);
  assert.equal(after.embedError, null, "error cleared after a good step");
});

test("ADR-0034: a 5xx caused by one input does not stall the index", async () => {
  const bad = await entry({ title: "CRASH-ME", body: "x" });
  const good = await entry({ title: "another database note", body: "z" });
  embedMode((input) => (input.some((t) => t.includes("CRASH-ME")) ? new Response("worker crashed", { status: 500 }) : undefined));
  await emb.indexAll();
  const ids = rows("entry_embeddings").map((x) => x.entry_id);
  assert.ok(ids.includes(good.id));
  assert.ok(!ids.includes(bad.id));
  assert.ok((await ok<Any>("GET", "/stats")).embedSkipped >= 1);
});

test("G-063: a failure on the request path does not turn off the vector for turn curation (separate back-off)", async () => {
  embedMode("error");
  await context("request lane fails here");
  embedMode("ok");
  const n = embedCalls.length;
  assert.equal(await emb.queryVector("request lane, still backing off"), null);
  assert.equal(embedCalls.length, n, "request lane skips the endpoint");
  assert.ok(await emb.queryVector("background lane still works", { background: true }));
  assert.equal(embedCalls.length, n + 1);
});

test("ADR-0034: with embeddings off, search scores keep two decimals", async () => {
  await entry({ title: "rounding check alpha beta", body: "alpha beta gamma alpha" });
  const saved = config.embed.baseUrl;
  config.embed.baseUrl = "";
  try {
    for (const h of await search("alpha beta gamma")) assert.equal(h.score, Math.round(h.score * 100) / 100);
  } finally {
    config.embed.baseUrl = saved;
  }
});
