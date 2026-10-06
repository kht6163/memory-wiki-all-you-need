// Recall's gates (ADR-0046): recall injects memories nobody asked for, so a weak match
// must not fill the slots. Short Latin words match whole words only (G-078), a word in
// many memories cannot recall by itself, and by meaning a memory must stand out from the
// prompt's cosine to every memory (z-score), not just pass a fixed cosine (G-079).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

process.env.EMBED_BASE_URL = "http://embed.test/v1";
process.env.EMBED_MODEL = "fake-m3";

const { entry, ok, project } = await import("./helpers.ts");
const { embedReset } = await import("./embed-stub.ts");
const { config } = await import("../src/config.ts");
const emb = await import("../src/embeddings.ts");

type Any = any;
const search = (q: string) => ok<Any[]>("GET", `/search?q=${encodeURIComponent(q)}`);
const context = (prompt: string) => ok<Any>("POST", "/context", { project: null, prompt });

// Recall only adds memories the stable block left out: keep that block empty here.
config.contextBudget = 1;

beforeEach(() => {
  embedReset();
  emb.resetQueryState();
});

/** Runs fn with keyword search only (no query vector). */
async function keywordOnly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = config.embed.baseUrl;
  config.embed.baseUrl = "";
  try {
    return await fn();
  } finally {
    config.embed.baseUrl = saved;
  }
}

test("G-078: a short Latin word matches whole words only — \"pr\" is not inside HAProxy, \"pm2\" still takes a particle", async () => {
  const haproxy = await entry({ title: "HAProxy ingress 재시작 절차", body: "haproxy-ingress 파드를 다시 띄운다" });
  const pr = await entry({ title: "PR 리뷰 규칙", body: "PR은 두 명이 승인해야 머지한다" });
  const pm2 = await entry({ title: "백엔드 재시작", body: "PM2를 재시작한 뒤 로그를 본다" });
  const api = await entry({ title: "상태 엔드포인트", body: "GET /api/health 로 확인" });
  const testDb = await entry({ title: "NEC 접속 정보", body: "테스트DB는 bitz, 신규APIs 문서는 0.9.9 기준" });
  await keywordOnly(async () => {
    const byPr = await search("pr 승인");
    assert.ok(byPr.some((h) => h.id === pr.id));
    assert.ok(!(await search("pr")).some((h) => h.id === haproxy.id), "pr inside HAProxy is no match");
    assert.ok((await search("pm2")).some((h) => h.id === pm2.id), "pm2를 → pm2");
    assert.ok((await search("api")).some((h) => h.id === api.id), "/api/health → api");
    // A Latin word fused to Hangul on either side, a plural, a dotted version prefix.
    for (const q of ["db", "api", "0.9"]) assert.ok((await search(q)).some((h) => h.id === testDb.id), `${q} → 테스트DB는 / 신규APIs / 0.9.9`);
    // Four letters and up still match inside words.
    assert.ok((await search("prox")).some((h) => h.id === haproxy.id));
  });
});

test("G-079: a word in many memories cannot recall by itself; a rarer word in the prompt can", async () => {
  for (let i = 0; i < 24; i++) await entry({ title: `작업 메모 qz${i}`, body: `qz${i} 결과를 확인했다` });
  const target = await entry({ title: "레디스캐시 만료", body: "레디스캐시는 10분 뒤 만료되는지 확인한다" });
  await keywordOnly(async () => {
    const common = await context("확인해줘");
    assert.deepEqual(common.recalled, [], "확인 is in 25 memories: no evidence");
    assert.equal(common.recall, "");
    const rare = await context("레디스캐시 확인해줘");
    assert.deepEqual(rare.recalled, [target.id], "the rare word recalls; the common one only adds to the score");
    // Search is not gated: the agent asked, it judges the hits.
    assert.ok((await search("확인")).length > 1);
  });
});

test("G-079: a word is common only among the memories this project can see", async () => {
  const busy = await project("github.com/test/rg-busy", "rg-busy");
  const quiet = await project("github.com/test/rg-quiet", "rg-quiet");
  for (let i = 0; i < 24; i++) await entry({ project_id: busy.id, title: `파서 노트 xk${i}`, body: `플럭스파서 xk${i} 단계` });
  const mine = await entry({ project_id: quiet.id, title: "플럭스파서 설정", body: "버퍼는 64KB" });
  const ask = (p: Any) => keywordOnly(() => ok<Any>("POST", "/context", { project: { key: p.key, name: p.name }, prompt: "플럭스파서 알려줘" }));
  assert.ok((await ask(quiet)).recalled.includes(mine.id), "rare in this project: recalled");
  assert.deepEqual((await ask(busy)).recalled, [], "in 24 of this project's memories: common");
});

test("G-079: by meaning, recall needs a z-score that stands out; a keyword hit far in meaning is dropped; search is not gated", async () => {
  for (let i = 0; i < 12; i++) await entry({ title: `filler ${i} wq`, body: `unrelated note wq${i}` });
  const deploy = await entry({ title: "Deploy procedure", body: "docker compose up -d --build; back up the DB first" });
  const zebra = await entry({ title: "zebrafinch 관찰 기록", body: "zebrafinch 는 아침에 운다" });
  await emb.indexAll();
  const prompt = "운영에 새 버전 배포하려면?";
  assert.ok((await context(prompt)).recalled.includes(deploy.id), "found by meaning, far above the prompt's mean cosine");
  const saved = { ...config.embed };
  try {
    config.embed.recallMinZ = 1000;
    assert.ok(!(await context(prompt)).recalled.includes(deploy.id), "cosine over the floor is not enough");
    assert.ok((await search(prompt)).some((h) => h.id === deploy.id), "search keeps it");
    config.embed.recallMinZ = 0;
    assert.ok((await context(prompt)).recalled.includes(deploy.id), "0 = gate off");

    // A shared rare word, but the memory is far from the prompt in meaning.
    config.embed.recallKeywordMinZ = 0;
    assert.ok((await context("zebrafinch 배포")).recalled.includes(zebra.id));
    config.embed.recallKeywordMinZ = 1000;
    assert.ok(!(await context("zebrafinch 배포")).recalled.includes(zebra.id));
    // Not embedded yet: no meaning to judge, the word match stands.
    const fresh = await entry({ title: "zebrafinch 먹이", body: "좁쌀" });
    assert.ok((await context("zebrafinch 배포")).recalled.includes(fresh.id));
  } finally {
    Object.assign(config.embed, saved);
  }
});
