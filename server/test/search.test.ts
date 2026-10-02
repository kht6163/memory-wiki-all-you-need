import assert from "node:assert/strict";
import { test } from "node:test";
import { call, entry, ok, project, turn } from "./helpers.ts";

// All tests in this file share one DB, so each test uses its own distinctive
// vocabulary to avoid cross-talk between fixtures.

const q = (s: string) => encodeURIComponent(s);
const search = (query: string, extra = "") => ok<any[]>("GET", `/search?q=${q(query)}${extra}`);
const sessionSearch = (query: string, extra = "") => ok<any[]>("GET", `/session-search?q=${q(query)}${extra}`);
const ids = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);

test("G-001: two-syllable Korean terms (포트, 설정) find memories via LIKE fallback", async () => {
  const port = await entry({ title: "게이트웨이 포트 변경", body: "기본값은 8080 이다" });
  const conf = await entry({ title: "로깅 레벨", body: "환경 설정 파일에서 debug 로 바꾼다" });

  const byPort = await search("포트");
  assert.ok(byPort.some((e) => e.id === port.id), "포트 should find the port memory");
  assert.ok(!byPort.some((e) => e.id === conf.id));

  const byConf = await search("설정");
  assert.ok(byConf.some((e) => e.id === conf.id), "설정 should find the config memory (body match)");
  assert.ok(!byConf.some((e) => e.id === port.id));
});

test("G-001: particle-attached terms (포트를, 설정을, 프록시에서) are stripped to find the stem", async () => {
  const e = await entry({ title: "프록시 포트 정리", body: "프록시 설정 값 모음" });
  for (const word of ["포트를", "설정을", "포트는", "프록시를"]) {
    const hits = await search(word);
    assert.ok(hits.some((h) => h.id === e.id), `${word} should find the memory`);
  }
  // Two-syllable particle dropped: 프록시에서 -> 프록시.
  const twoDrop = await search("프록시에서");
  assert.ok(twoDrop.some((h) => h.id === e.id), "프록시에서 should strip down to 프록시");
});

test("G-001: a sentence with particles and stopwords still finds the memory", async () => {
  const e = await entry({ title: "캐시 만료 시간", body: "레디스 캐시는 10분 뒤 만료된다" });
  const hits = await search("캐시를 어떻게 만료해줘");
  assert.ok(hits.some((h) => h.id === e.id));
});

test("G-001: Korean term matches tags via LIKE", async () => {
  const e = await entry({ title: "unrelated title qwzx", body: "nothing here", tags: ["배포"] });
  const hits = await search("배포를");
  assert.ok(hits.some((h) => h.id === e.id), "tag 배포 should match 배포를");
});

test("trigram FTS: 3+ char terms match substrings, case-insensitively", async () => {
  const e = await entry({ title: "Uses PostgreSQL connection pooler", body: "pgbouncer in transaction mode" });
  for (const word of ["postgresql", "POSTGRES", "gres", "bouncer", "transaction"]) {
    const hits = await search(word);
    assert.ok(hits.some((h) => h.id === e.id), `${word} should match via trigram FTS`);
  }
  assert.equal((await search("mysqlonly")).length, 0);
});

test("trigram FTS: 3-syllable Korean term matches mid-word", async () => {
  const e = await entry({ title: "대용량데이터베이스 백업", body: "매일 새벽 덤프" });
  const hits = await search("데이터베");
  assert.ok(hits.some((h) => h.id === e.id));
});

test("search: OR semantics across terms and better coverage ranks higher", async () => {
  const both = await entry({ title: "kafkazz brokerzz layout", body: "three nodes" });
  const one = await entry({ title: "kafkazz retention", body: "seven days" });
  const hits = await search("kafkazz brokerzz");
  const iBoth = hits.findIndex((h) => h.id === both.id);
  const iOne = hits.findIndex((h) => h.id === one.id);
  assert.ok(iBoth >= 0 && iOne >= 0, "both entries should be returned");
  assert.ok(iBoth < iOne, "entry matching both terms should rank first");
  assert.ok(hits[iBoth].score > hits[iOne].score);
});

test("search: empty, single-char and stopword-only queries return nothing", async () => {
  await entry({ title: "the and for with", body: "a b c" });
  assert.deepEqual(await search(""), []);
  assert.deepEqual(await search("a"), []);
  assert.deepEqual(await search("the and"), []);
  assert.deepEqual(await ok<any[]>("GET", "/search"), []);
});

test("search: special characters in queries do not break FTS or LIKE", async () => {
  const e = await entry({ title: "path /etc/nginxqq/conf.d", body: "50% of traffic_x" });
  const r1 = await call("GET", `/search?q=${q('"nginxqq" OR (')}`);
  assert.equal(r1.status, 200);
  assert.ok(r1.data.some((h: any) => h.id === e.id));
  // "q_" is a 2-char term (LIKE path); unescaped it would match "qq" in the title above.
  const r2 = await call("GET", `/search?q=${q("q_")}&all=1`);
  assert.equal(r2.status, 200);
  assert.ok(!r2.data.some((h: any) => h.id === e.id), "LIKE wildcards must be escaped");
});

test("scope: project memories are visible only from their own project; global/user everywhere", async () => {
  const pa = await project("github.com/test/scope-a", "scope-a");
  const pb = await project("github.com/test/scope-b", "scope-b");
  const a = await entry({ project_id: pa.id, title: "zylophone alpha note" });
  const b = await entry({ project_id: pb.id, title: "zylophone beta note" });
  const g = await entry({ scope: "global", title: "zylophone global note" });
  const u = await entry({ scope: "user", title: "zylophone user note" });

  assert.deepEqual(ids(await search("zylophone", `&project_id=${pa.id}`)), ids([a, g, u]));
  assert.deepEqual(ids(await search("zylophone", `&project_id=${pb.id}`)), ids([b, g, u]));
  assert.deepEqual(ids(await search("zylophone", `&project=${q(pa.key)}`)), ids([a, g, u]), "project key resolves like project_id");
  assert.deepEqual(ids(await search("zylophone")), ids([g, u]), "no project: only global + user");
  assert.deepEqual(ids(await search("zylophone", "&all=1")), ids([a, b, g, u]), "all=1 searches every project");
  assert.deepEqual(ids(await search("zylophone", `&project=${q("github.com/test/unknown-x")}`)), ids([g, u]));
});

test("scope: short Korean LIKE path respects project scope too", async () => {
  const pa = await project("github.com/test/ko-a", "ko-a");
  const pb = await project("github.com/test/ko-b", "ko-b");
  const a = await entry({ project_id: pa.id, title: "큐잉 정책 A" });
  const b = await entry({ project_id: pb.id, title: "큐잉 정책 B" });
  const g = await entry({ scope: "global", title: "공통 큐잉 정책" });
  const fromA = ids(await search("정책을", `&project_id=${pa.id}`));
  assert.deepEqual(fromA, ids([a, g]));
  assert.ok(!fromA.includes(b.id));
  assert.deepEqual(ids(await search("정책", "&all=1")).filter((id) => [a.id, b.id, g.id].includes(id)), ids([a, b, g]));
});

test("scope filter, category filter, limit and project boost", async () => {
  const p = await project("github.com/test/filters", "filters");
  const pe = await entry({ project_id: p.id, title: "quokkaword shared", category: "fact" });
  const ge = await entry({ scope: "global", title: "quokkaword shared", category: "decision" });
  const ue = await entry({ scope: "user", title: "quokkaword shared", category: "fact" });

  const userOnly = await search("quokkaword", `&project_id=${p.id}&scope=user`);
  assert.deepEqual(ids(userOnly), ids([ue]));
  const decisions = await search("quokkaword", `&project_id=${p.id}&category=decision`);
  assert.deepEqual(ids(decisions), ids([ge]));
  const limited = await search("quokkaword", `&project_id=${p.id}&limit=1`);
  assert.equal(limited.length, 1);
  assert.equal(limited[0].id, pe.id, "identical text: project-scoped entry ranks first");
});

test("search: deleted memories are excluded from both FTS and LIKE paths", async () => {
  const e1 = await entry({ title: "ephemeralword gone", body: "임시 삭제대상" });
  assert.ok((await search("ephemeralword")).some((h) => h.id === e1.id));
  assert.ok((await search("임시")).some((h) => h.id === e1.id));
  await ok("DELETE", `/entries/${e1.id}`);
  assert.ok(!(await search("ephemeralword")).some((h) => h.id === e1.id));
  assert.ok(!(await search("임시")).some((h) => h.id === e1.id));
});

test("search: edited memories are re-indexed", async () => {
  const e = await entry({ title: "oldtermvv here" });
  await ok("PATCH", `/entries/${e.id}`, { title: "newtermvv here" });
  assert.ok(!(await search("oldtermvv")).some((h) => h.id === e.id));
  assert.ok((await search("newtermvv")).some((h) => h.id === e.id));
});

test("session-search: finds turns by 3+ char term, 2-char Korean term and particle form", async () => {
  const p = await project("github.com/test/sess", "sess");
  const t = await turn([{ role: "user", text: "nginxsess 리버스 프록시 포트를 바꿔야 해" }, { role: "assistant", text: "알겠어요" }], p, "sess-1");

  for (const word of ["nginxsess", "리버스", "포트", "포트를"]) {
    const hits = await sessionSearch(word);
    const hit = hits.find((h) => h.id === t.id);
    assert.ok(hit, `${word} should find the turn`);
    assert.equal(hit.session_id, "sess-1");
    assert.equal(hit.project_id, p.id);
    assert.equal(hit.project_name, "sess");
    assert.ok(hit.snippet.includes("nginxsess"));
  }
});

test("session-search: project filter by id and key; no filter searches all turns", async () => {
  const pa = await project("github.com/test/sess-a", "sess-a");
  const pb = await project("github.com/test/sess-b", "sess-b");
  const ta = await turn([{ role: "user", text: "marmotword 배치 작업" }], pa, "sa");
  const tb = await turn([{ role: "user", text: "marmotword 배치 작업" }], pb, "sb");
  const tn = await turn([{ role: "user", text: "marmotword 배치 작업" }], null, "sn");

  assert.deepEqual(ids(await sessionSearch("marmotword", `&project_id=${pa.id}`)), [ta.id]);
  assert.deepEqual(ids(await sessionSearch("배치", `&project=${q(pb.key)}`)), [tb.id]);
  assert.deepEqual(ids(await sessionSearch("marmotword")), ids([ta, tb, tn]));
  const nullHit = (await sessionSearch("marmotword")).find((h) => h.id === tn.id);
  assert.equal(nullHit.project_id, null);
  assert.equal(nullHit.project_name, null);
});

test("session-search: tool results are not indexed; limit and newest-first tie order", async () => {
  const t1 = await turn([{ role: "user", text: "pangolinx first" }], null, "lim");
  const t2 = await turn([{ role: "user", text: "pangolinx second" }], null, "lim");
  const t3 = await turn([{ role: "user", text: "pangolinx third" }], null, "lim");
  const limited = await sessionSearch("pangolinx", "&limit=2");
  assert.deepEqual(limited.map((h) => h.id), [t3.id, t2.id]);
  assert.ok(!limited.some((h) => h.id === t1.id));

  await turn([{ role: "user", text: "look it up" }, { role: "tool", name: "grep", text: "toolonlyword found" }], null, "tool");
  assert.deepEqual(await sessionSearch("toolonlyword"), []);
});

test("session-search: snippet is centered near the match for long turns", async () => {
  const long = "filler ".repeat(200) + "needlewordx is here " + "tail ".repeat(200);
  const t = await turn([{ role: "user", text: long }], null, "snip");
  const hit = (await sessionSearch("needlewordx")).find((h) => h.id === t.id);
  assert.ok(hit);
  assert.ok(hit.snippet.startsWith("…"));
  assert.ok(hit.snippet.endsWith("…"));
  assert.ok(hit.snippet.includes("needlewordx"));
  assert.ok(hit.snippet.length <= 402);
});

test("session-search: empty query returns empty list", async () => {
  assert.deepEqual(await sessionSearch(""), []);
  assert.deepEqual(await ok<any[]>("GET", "/session-search"), []);
});
