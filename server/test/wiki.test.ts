import assert from "node:assert/strict";
import { test } from "node:test";

// Small compose chunk so G-015 can be checked with a handful of turns. config.ts
// reads env on first import, so everything server-side is imported dynamically.
const CHUNK = 1500;
process.env.WIKI_COMPOSE_CHUNK_CHARS = String(CHUNK);

const { call, db, entry, llmCalls, llmDefault, llmReset, ok, project, runQueueOnce, turn } = await import("./helpers.ts");
const { config } = await import("../src/config.ts");

type Call = { system: string; user: string };
type ComposeReply = { pages: Record<string, unknown>[]; note?: string };

// One fake LLM for the whole file: curation calls get "no changes", compose
// calls go to whatever handler the current test installed.
let composeHandler: (c: Call) => ComposeReply = () => ({ pages: [] });
const isCompose = (c: Call) => c.system.includes("You maintain a wiki");
function installLlm() {
  llmReset();
  llmDefault((c: Call) => (isCompose(c) ? composeHandler(c) : { ops: [], note: "nothing" }));
}
const composeCalls = () => llmCalls.filter(isCompose);
const transcriptsOf = (c: Call) => c.user.split("\nTRANSCRIPTS:\n")[1] ?? "";
const currentBodiesOf = (c: Call) => c.user.split("CURRENT BODIES of the pages you may update:\n")[1]?.split("\nTRANSCRIPTS:\n")[0] ?? "";

const count = (sql: string, ...args: (string | number)[]) => Number(Object.values(db.prepare(sql).get(...args) ?? { n: 0 })[0]);
const revCount = (pageId: number) => count(`SELECT COUNT(*) FROM wiki_revisions WHERE page_id = ?`, pageId);

async function page(b: { project_id?: number | null; slug?: string; title: string; body?: string; locked?: boolean }) {
  return ok("POST", "/wiki/pages", b);
}

async function composeJob(projectId: number | null, turnIds: number[]) {
  const job = await ok("POST", "/wiki/compose", { project_id: projectId, turn_ids: turnIds });
  await runQueueOnce();
  const jobs = await ok<any[]>("GET", "/wiki/jobs");
  return jobs.find((j) => j.id === job.id);
}

test("config picked up the small compose chunk from env", () => {
  assert.equal(config.wiki.composeChunkChars, CHUNK);
});

test("wiki pages CRUD: create, duplicate 409, by-slug, patch, delete, restore, revive", async () => {
  const p = await project("github.com/test/wiki-crud", "wiki-crud");
  const a = await page({ project_id: p.id, title: "Deploy Guide", body: "step one" });
  assert.equal(a.slug, "deploy-guide");
  assert.equal(a.project_id, p.id);
  assert.equal(a.source, "human");

  const dup = await call("POST", "/wiki/pages", { project_id: p.id, title: "deploy guide" });
  assert.equal(dup.status, 409);
  // Same slug in another wiki (global) is fine.
  const g = await page({ title: "Deploy Guide", body: "global" });
  assert.equal(g.project_id, null);
  assert.notEqual(g.id, a.id);

  assert.equal((await call("POST", "/wiki/pages", { project_id: p.id, title: "  " })).status, 400);
  assert.equal((await call("POST", "/wiki/pages", { project_id: 999999, title: "x" })).status, 404);
  const secret = await call("POST", "/wiki/pages", { project_id: p.id, title: "keys", body: `key ${"sk-" + "a".repeat(30)}` });
  assert.equal(secret.status, 422);

  const bySlug = await ok("GET", `/wiki/by-slug?project_id=${p.id}&slug=Deploy%20Guide`);
  assert.equal(bySlug.id, a.id);
  const byKey = await ok("GET", `/wiki/by-slug?project=${encodeURIComponent(p.key)}&slug=deploy-guide`);
  assert.equal(byKey.id, a.id);

  const upd = await ok("PATCH", `/wiki/pages/${a.id}`, { body: "step one\nstep two" });
  assert.equal(upd.body, "step one\nstep two");
  // No-op patch writes no revision.
  await ok("PATCH", `/wiki/pages/${a.id}`, { body: "step one\nstep two" });
  assert.equal(revCount(a.id), 2);

  const list = await ok<any[]>("GET", `/wiki/pages?project_id=${p.id}`);
  assert.deepEqual(list.map((x) => x.id), [a.id]);

  await ok("DELETE", `/wiki/pages/${a.id}`);
  assert.equal((await ok<any[]>("GET", `/wiki/pages?project_id=${p.id}`)).length, 0);
  assert.deepEqual((await ok<any[]>("GET", `/wiki/pages?project_id=${p.id}&deleted=1`)).map((x) => x.id), [a.id]);
  assert.equal((await call("PATCH", `/wiki/pages/${a.id}`, { body: "x" })).status, 404);

  const restored = await ok("POST", `/wiki/pages/${a.id}/restore`);
  assert.equal(restored.deleted_at, null);
  await ok("DELETE", `/wiki/pages/${a.id}`);

  // Re-creating a deleted slug revives the same row, keeping its history.
  const revived = await page({ project_id: p.id, title: "Deploy Guide", body: "fresh" });
  assert.equal(revived.id, a.id);
  assert.equal(revived.body, "fresh");
  const detail = await ok("GET", `/wiki/pages/${a.id}`);
  assert.deepEqual(
    detail.revisions.map((r: any) => r.action),
    ["restore", "delete", "restore", "delete", "update", "create"],
  );
  assert.equal(detail.project.id, p.id);
});

test("revisions and revert, including revert of a deleted page", async () => {
  const v1 = await page({ title: "Revert Me", body: "version one" });
  await ok("PATCH", `/wiki/pages/${v1.id}`, { body: "version two" });
  await ok("PATCH", `/wiki/pages/${v1.id}`, { title: "Revert Me 3", body: "version three" });
  let detail = await ok("GET", `/wiki/pages/${v1.id}`);
  assert.equal(detail.revisions.length, 3);
  const first = detail.revisions.at(-1);
  assert.equal(first.action, "create");
  assert.equal(first.body, "version one");
  assert.equal(first.author, "human");

  const back = await ok("POST", `/wiki/pages/${v1.id}/revert`, { revisionId: first.id });
  assert.equal(back.body, "version one");
  assert.equal(back.title, "Revert Me");
  detail = await ok("GET", `/wiki/pages/${v1.id}`);
  assert.equal(detail.revisions.length, 4);
  assert.equal(detail.revisions[0].action, "update");
  assert.match(detail.revisions[0].reason, new RegExp(`#${first.id}`));

  // Revert of a deleted page restores it first.
  const second = detail.revisions.find((r: any) => r.body === "version two");
  await ok("DELETE", `/wiki/pages/${v1.id}`);
  const again = await ok("POST", `/wiki/pages/${v1.id}/revert`, { revisionId: second.id });
  assert.equal(again.deleted_at, null);
  assert.equal(again.body, "version two");

  // A revision of another page is not accepted.
  const other = await page({ title: "Other Revert", body: "o" });
  const otherRev = (await ok("GET", `/wiki/pages/${other.id}`)).revisions[0];
  assert.equal((await call("POST", `/wiki/pages/${v1.id}/revert`, { revisionId: otherRev.id })).status, 404);
});

test("backlinks and missing links follow [[slug]] / [[slug|label]] and ignore deleted pages", async () => {
  const p = await project("github.com/test/wiki-links", "wiki-links");
  const target = await page({ project_id: p.id, title: "Target Page", body: "self link [[target-page]] is ignored" });
  const a = await page({ project_id: p.id, title: "Linker A", body: "see [[Target Page|the target]] and [[nowhere-yet]] and [[target-page#section]]" });
  const b = await page({ project_id: p.id, title: "Linker B", body: "also [[target-page]]" });
  // Same slug in the global wiki must not count as a backlink of the project page.
  await page({ title: "Global Linker", body: "[[target-page]] [[global-missing]]" });

  let detail = await ok("GET", `/wiki/pages/${target.id}`);
  assert.deepEqual(detail.backlinks.map((x: any) => x.id).sort(), [a.id, b.id].sort());

  const missing = await ok<any[]>("GET", `/wiki/missing?project_id=${p.id}`);
  assert.deepEqual(missing, [{ from: "linker-a", to: "nowhere-yet" }]);
  const globalMissing = await ok<any[]>("GET", "/wiki/missing");
  assert.ok(globalMissing.some((m) => m.from === "global-linker" && m.to === "target-page"));
  assert.ok(!globalMissing.some((m) => m.to === "nowhere-yet"));

  // Creating the missing page resolves it; deleting a linker drops its backlink.
  await page({ project_id: p.id, title: "Nowhere Yet", body: "now here" });
  assert.deepEqual(await ok("GET", `/wiki/missing?project_id=${p.id}`), []);
  await ok("DELETE", `/wiki/pages/${b.id}`);
  detail = await ok("GET", `/wiki/pages/${target.id}`);
  assert.deepEqual(detail.backlinks.map((x: any) => x.id), [a.id]);

  // Editing the body re-indexes links.
  await ok("PATCH", `/wiki/pages/${a.id}`, { body: "no links any more" });
  detail = await ok("GET", `/wiki/pages/${target.id}`);
  assert.deepEqual(detail.backlinks, []);
});

test("/wiki/read falls back to the global wiki; project page wins; global: prefix forces global", async () => {
  const p = await project("github.com/test/wiki-read", "wiki-read");
  await page({ title: "Shared Howto", body: "global howto" });
  await page({ title: "Both Places", body: "global version" });
  await page({ project_id: p.id, title: "Both Places", body: "project version" });
  const key = encodeURIComponent(p.key);

  assert.equal((await ok("GET", `/wiki/read?project=${key}&slug=shared-howto`)).body, "global howto");
  assert.equal((await ok("GET", `/wiki/read?project=${key}&slug=both-places`)).body, "project version");
  assert.equal((await ok("GET", `/wiki/read?project=${key}&slug=global:both-places`)).body, "global version");
  assert.equal((await ok("GET", `/wiki/read?project_id=${p.id}&slug=Shared%20Howto`)).body, "global howto");

  const miss = await call("GET", `/wiki/read?project=${key}&slug=nope`);
  assert.equal(miss.status, 404);
  assert.match(JSON.stringify(miss.data), /both-places/);
  assert.equal((await call("GET", `/wiki/read?project=github.com/test/unknown&slug=x`)).status, 404);
});

test("agent writes via POST /agent/wiki: create, replace, append; G-013: locked page -> 423", async () => {
  const p = await project("github.com/test/wiki-agent", "wiki-agent");
  const ref = { key: p.key, name: p.name };
  const created = await call("POST", "/agent/wiki", { project: ref, slug: "notes", body: "first" });
  assert.equal(created.status, 201);
  assert.equal(created.data.action, "create");
  assert.equal(created.data.page.source, "agent");
  assert.equal(created.data.page.project_id, p.id);

  const app = await ok("POST", "/agent/wiki", { project: ref, slug: "notes", body: "second", mode: "append" });
  assert.equal(app.action, "append");
  assert.equal(app.page.body, "first\n\nsecond");
  const rep = await ok("POST", "/agent/wiki", { project: ref, slug: "notes", body: "replaced", reason: "cleanup" });
  assert.equal(rep.page.body, "replaced");
  assert.equal((await ok("GET", `/wiki/pages/${rep.page.id}`)).revisions[0].reason, "cleanup");

  const glob = await call("POST", "/agent/wiki", { project: ref, global: true, slug: "notes", body: "global notes" });
  assert.equal(glob.status, 201);
  assert.equal(glob.data.page.project_id, null);

  assert.equal((await call("POST", "/agent/wiki", { project: ref, slug: "notes", body: "  " })).status, 400);

  const locked = await page({ project_id: p.id, title: "Locked Rules", body: "human rules", locked: true });
  const before = revCount(locked.id);
  for (const mode of ["replace", "append"]) {
    const r = await call("POST", "/agent/wiki", { project: ref, slug: "locked-rules", body: "agent text", mode });
    assert.equal(r.status, 423, `mode ${mode}`);
  }
  assert.equal(revCount(locked.id), before);
  assert.equal((await ok("GET", `/wiki/pages/${locked.id}`)).page.body, "human rules");
  // A human can still edit a locked page.
  const human = await ok("PATCH", `/wiki/pages/${locked.id}`, { body: "human rules v2" });
  assert.equal(human.body, "human rules v2");
  assert.equal(human.locked, true);
});

test("G-013: compose may update/delete only unlocked pages whose body was shown in that call", async () => {
  installLlm();
  const p = await project("github.com/test/wiki-g013", "wiki-g013");
  const overview = await page({ project_id: p.id, slug: "overview", title: "Overview", body: "overview body original" });
  const locked = await page({ project_id: p.id, slug: "kubernetes", title: "Kubernetes", body: "kubernetes cluster notes by human", locked: true });
  const lockedDel = await page({ project_id: p.id, slug: "kubernetes-old", title: "Kubernetes old", body: "kubernetes legacy cluster", locked: true });
  const hidden = await page({ project_id: p.id, slug: "zqxjv", title: "Zqxjv", body: "wkpfmq bvnzrt" });
  const hiddenDel = await page({ project_id: p.id, slug: "plmokn", title: "Plmokn", body: "ijnuhb ygvtfc" });
  const revs = new Map([overview, locked, lockedDel, hidden, hiddenDel].map((x) => [x.id, revCount(x.id)]));

  const t = await turn([{ role: "user", text: "how is the kubernetes cluster set up?" }, { role: "assistant", text: "the kubernetes cluster uses three nodes" }], p, "g013");
  await runQueueOnce(); // curate the turn first so only the compose call is left

  let seen: Call | undefined;
  composeHandler = (c) => {
    seen = c;
    return {
      pages: [
        { action: "update", slug: "overview", title: "Overview", body: "overview body updated" },
        { action: "update", slug: "kubernetes", title: "Kubernetes", body: "llm overwrote locked" },
        { action: "delete", slug: "kubernetes-old" },
        { action: "update", slug: "zqxjv", title: "Zqxjv", body: "llm overwrote unseen" },
        { action: "delete", slug: "plmokn" },
        { action: "create", slug: "cluster-nodes", title: "Cluster nodes", body: "three nodes" },
      ],
      note: "ok",
    };
  };
  const job = await composeJob(p.id, [t.id]);
  assert.equal(job.status, "done");
  assert.ok(seen, "compose LLM was called");

  // Preconditions of the scenario: what the LLM was shown.
  const bodies = currentBodiesOf(seen!);
  assert.match(bodies, /overview body original/);
  assert.match(bodies, /\[\[kubernetes\]\] Kubernetes \(LOCKED/);
  assert.doesNotMatch(bodies, /wkpfmq/);
  assert.doesNotMatch(bodies, /ijnuhb/);

  const applied = job.result.applied.map((a: any) => `${a.action}:${a.slug}`).sort();
  assert.deepEqual(applied, ["create:cluster-nodes", "update:overview"]);

  assert.equal((await ok("GET", `/wiki/pages/${overview.id}`)).page.body, "overview body updated");
  for (const x of [locked, lockedDel, hidden, hiddenDel]) {
    const d = await ok("GET", `/wiki/pages/${x.id}`);
    assert.equal(d.page.body, x.body, x.slug);
    assert.equal(d.page.deleted_at, null, x.slug);
    assert.equal(revCount(x.id), revs.get(x.id), x.slug);
  }
  const ov = (await ok("GET", `/wiki/pages/${overview.id}`)).revisions[0];
  assert.equal(ov.author, "llm");
  assert.equal(ov.job_id, job.id);
});

test("G-014: [#id] references to non-existent memories are stripped from compose output", async () => {
  installLlm();
  const p = await project("github.com/test/wiki-g014", "wiki-g014");
  const live = await entry({ project_id: p.id, title: "redis cache ttl is 60s" });
  const gone = await entry({ project_id: p.id, title: "old memory soon deleted" });
  await ok("DELETE", `/entries/${gone.id}`); // soft-deleted rows still exist
  const fake = live.id + 100000;

  const t = await turn([{ role: "user", text: "redis cache ttl?" }, { role: "assistant", text: "60 seconds" }], p, "g014");
  await runQueueOnce();
  composeHandler = () => ({
    pages: [{ action: "create", slug: "caching", title: "Caching", body: `TTL is 60s [#${live.id}] see also [#${fake}] and [#${gone.id}].` }],
  });
  const job = await composeJob(p.id, [t.id]);
  assert.equal(job.status, "done");
  const pg = await ok("GET", `/wiki/by-slug?project_id=${p.id}&slug=caching`);
  assert.ok(pg.body.includes(`[#${live.id}]`));
  assert.ok(pg.body.includes(`[#${gone.id}]`));
  assert.ok(!pg.body.includes(`[#${fake}]`), pg.body);
  const detail = await ok("GET", `/wiki/pages/${pg.id}`);
  assert.deepEqual(detail.cites.map((e: any) => e.id).sort((a: number, b: number) => a - b), [live.id, gone.id].sort((a, b) => a - b));

  // Human-written references are not checked (writer's intent is respected).
  const human = await page({ project_id: p.id, title: "Human refs", body: `ref [#${fake}]` });
  assert.ok(human.body.includes(`[#${fake}]`));
});

test("G-015: compose splits turns into chunks with TRANSCRIPTS under WIKI_COMPOSE_CHUNK_CHARS", async () => {
  installLlm();
  const p = await project("github.com/test/wiki-g015", "wiki-g015");
  const ids: number[] = [];
  for (const [i, n] of [900, 900, 900, 5000].entries()) {
    const text = `turn${i} ` + "lorem ipsum ".repeat(Math.ceil(n / 12)).slice(0, n);
    const msgs = n > 4000 ? [{ role: "user" as const, text: text.slice(0, 3000) }, { role: "assistant" as const, text: text.slice(3000) }] : [{ role: "user" as const, text }];
    ids.push((await turn(msgs, p, "g015")).id);
  }
  await runQueueOnce();
  llmCalls.length = 0;

  let n = 0;
  composeHandler = () => {
    n++;
    return n === 1
      ? { pages: [{ action: "create", slug: "chunk-notes", title: "Chunk notes", body: "from chunk one" }] }
      : { pages: [{ action: "update", slug: "chunk-notes", title: "Chunk notes", body: `from chunk ${n}` }] };
  };
  const job = await composeJob(p.id, ids);
  assert.equal(job.status, "done");
  const calls = composeCalls();
  assert.ok(calls.length >= 3, `expected several compose calls, got ${calls.length}`);
  assert.equal(job.result.chunks, calls.length);
  for (const c of calls) {
    const tx = transcriptsOf(c);
    assert.ok(tx.length > 0);
    assert.ok(tx.length <= CHUNK, `TRANSCRIPTS ${tx.length} > ${CHUNK}`);
  }
  // Every turn appears exactly once, in order across chunks; the oversized one is clipped.
  const order = calls.flatMap((c) => [...transcriptsOf(c).matchAll(/=== turn #(\d+)/g)].map((m) => Number(m[1])));
  assert.deepEqual(order, ids);
  assert.match(transcriptsOf(calls.at(-1)!), /\[turn truncated\]/);
  // Later chunks see the page the earlier chunk created and may update it.
  assert.match(currentBodiesOf(calls[1]), /from chunk one/);
  const pg = await ok("GET", `/wiki/by-slug?project_id=${p.id}&slug=chunk-notes`);
  assert.equal(pg.body, `from chunk ${calls.length}`);
  assert.deepEqual([...job.result.done].sort((a: number, b: number) => a - b), ids);
});

test("POST /wiki/compose with no turn_ids picks uncomposed turns; wiki_composed marks them per wiki", async () => {
  installLlm();
  const p = await project("github.com/test/wiki-default", "wiki-default");
  const t1 = await turn([{ role: "user", text: "first default turn" }], p, "def-a");
  const t2 = await turn([{ role: "user", text: "second default turn" }], p, "def-b");
  await runQueueOnce();
  composeHandler = () => ({ pages: [] });

  let pool = await ok<any[]>("GET", `/wiki/compose/turns?project_id=${p.id}&uncomposed=1`);
  assert.deepEqual(pool.map((x) => x.id).sort(), [t1.id, t2.id].sort());
  assert.equal(pool.find((x) => x.id === t1.id).prompt, "first default turn");

  const job = await ok("POST", "/wiki/compose", { project: { key: p.key, name: p.name } });
  assert.deepEqual(job.payload.turns, [t1.id, t2.id]);
  assert.equal(job.project_id, p.id);
  await runQueueOnce();
  assert.equal(count(`SELECT COUNT(*) FROM wiki_composed WHERE scope = ? AND turn_id IN (?, ?) AND job_id = ?`, p.id, t1.id, t2.id, job.id), 2);

  pool = await ok<any[]>("GET", `/wiki/compose/turns?project_id=${p.id}&uncomposed=1`);
  assert.deepEqual(pool, []);
  const all = await ok<any[]>("GET", `/wiki/compose/turns?project_id=${p.id}`);
  assert.ok(all.every((x) => x.composed_at));
  assert.equal((await call("POST", "/wiki/compose", { project_id: p.id })).status, 400);

  // A new turn is the only one picked next time.
  const t3 = await turn([{ role: "user", text: "third default turn" }], p, "def-a");
  await runQueueOnce();
  const next = await ok("POST", "/wiki/compose", { project_id: p.id });
  assert.deepEqual(next.payload.turns, [t3.id]);
  await runQueueOnce();

  // session_id picks every turn of the session, composed or not.
  const sess = await ok("POST", "/wiki/compose", { project_id: p.id, session_id: "def-a", instruction: "  focus  " });
  assert.deepEqual(sess.payload.turns, [t1.id, t3.id]);
  assert.equal(sess.payload.instruction, "focus");
  await runQueueOnce();

  // Composed into the project wiki is not composed into the global wiki.
  const globalPool = await ok<any[]>("GET", "/wiki/compose/turns?uncomposed=1");
  assert.ok([t1.id, t2.id, t3.id].every((id) => globalPool.some((x) => x.id === id)));

  assert.equal((await call("POST", "/wiki/compose", { project: { key: "github.com/test/never-seen", name: "x" } })).status, 404);
  assert.equal((await call("POST", "/wiki/compose", { project_id: p.id, turn_ids: [999999] })).status, 404);
});

test("G-016: memory changes never enqueue wiki jobs", async () => {
  installLlm();
  const p = await project("github.com/test/wiki-g016a", "wiki-g016a");
  const jobsBefore = count(`SELECT COUNT(*) FROM wiki_jobs`);
  const e = await entry({ project_id: p.id, title: "memory for g016", body: "b" });
  await ok("PATCH", `/entries/${e.id}`, { body: "b2" });
  await ok("DELETE", `/entries/${e.id}`);
  await ok("POST", `/entries/${e.id}/restore`);
  // Curation adds a memory through the LLM too.
  llmCalls.length = 0;
  const llmBefore = llmCalls.length;
  composeHandler = () => {
    throw new Error("compose must not run");
  };
  llmDefault((c: Call) =>
    isCompose(c) ? composeHandler(c) : { ops: [{ op: "add", scope: "project", category: "fact", title: "curated g016 fact", body: "x" }], note: "ok" },
  );
  await turn([{ role: "user", text: "remember the g016 fact" }, { role: "assistant", text: "ok" }], p, "g016");
  await runQueueOnce();
  assert.ok(llmCalls.length > llmBefore);
  assert.ok((await ok<any[]>("GET", `/entries?project_id=${p.id}`)).some((x) => x.title === "curated g016 fact"));
  assert.equal(composeCalls().length, 0);
  assert.equal(count(`SELECT COUNT(*) FROM wiki_jobs`), jobsBefore);
  assert.equal((await ok("GET", "/stats")).wikiPending, 0);
});

test("G-016: page writes (human, agent, LLM compose) never change memory", async () => {
  installLlm();
  const p = await project("github.com/test/wiki-g016b", "wiki-g016b");
  const e = await entry({ project_id: p.id, title: "memory cited by pages", body: "unchanged" });
  const t = await turn([{ role: "user", text: "write a page that cites memory" }], p, "g016b");
  await runQueueOnce();
  llmCalls.length = 0;
  const snap = () => ({
    entries: db.prepare(`SELECT id, title, body, updated_at, deleted_at FROM entries ORDER BY id`).all(),
    revisions: count(`SELECT COUNT(*) FROM revisions`),
    turns: db.prepare(`SELECT id, status FROM turns ORDER BY id`).all(),
  });
  const before = snap();

  const pg = await page({ project_id: p.id, title: "Cites Memory", body: `cites [#${e.id}]` });
  await ok("PATCH", `/wiki/pages/${pg.id}`, { body: `still cites [#${e.id}] more` });
  await ok("POST", "/agent/wiki", { project: { key: p.key, name: p.name }, slug: "agent-cites", body: `agent [#${e.id}]` });
  composeHandler = () => ({ pages: [{ action: "create", slug: "llm-cites", title: "LLM cites", body: `llm [#${e.id}]` }] });
  const job = await composeJob(p.id, [t.id]);
  assert.equal(job.status, "done");
  await ok("DELETE", `/wiki/pages/${pg.id}`);

  assert.deepEqual(snap(), before);
  // Only the compose call reached the LLM.
  assert.equal(llmCalls.length, 1);
  assert.ok(isCompose(llmCalls[0]));
});

test("/wiki/read falls back to the global page when the project page with that slug was deleted", async () => {
  const p = await project("github.com/test/wiki-read-del", "wiki-read-del");
  await page({ title: "Shadowed", body: "global shadowed" });
  const local = await page({ project_id: p.id, title: "Shadowed", body: "project shadowed" });
  const url = `/wiki/read?project=${encodeURIComponent(p.key)}&slug=shadowed`;
  // While the project page is live it wins over the global page.
  const live = await call("GET", url);
  assert.equal(live.status, 200, JSON.stringify(live.data));
  assert.equal(live.data.body, "project shadowed");
  assert.equal(live.data.id, local.id);
  await ok("DELETE", `/wiki/pages/${local.id}`);
  const r = await call("GET", url);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.body, "global shadowed");
});
