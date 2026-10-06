// A supersedes link the graph backfill guesses hides nothing until a person confirms it (G-084):
// on production half of 18 such links joined different facts or ran backwards, and each one
// silently took a valid memory out of every prompt.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { entry, llmReply, llmReset, ok, project, runQueueOnce } = await import("./helpers.ts");

type Any = any;
const health = () => ok<Any>("GET", "/health");
const supersededBy = async (id: number) => (await ok<Any>("GET", `/entries/${id}`)).entry.superseded_by;

async function backfillGuess(tag: string) {
  llmReset();
  const p = await project(`github.com/test/g084-${tag}`, `g084-${tag}`);
  const body = "short body for the supersedes test.";
  const oldM = await entry({ project_id: p.id, title: `g084 ${tag} plan`, body });
  const newM = await entry({ project_id: p.id, title: `g084 ${tag} outcome`, body });
  llmReply(() => ({ memories: [{ id: newM.id, entities: [`Kite ${tag}`], links: [{ to: oldM.id, type: "supersedes" }] }] }));
  await ok("POST", "/graph/backfill", { project_id: p.id });
  await runQueueOnce();
  return { p, oldM, newM };
}

test("G-084: a backfill supersedes guess waits on the review page and hides nothing", async () => {
  const before = (await health()).supersedesPending;
  const { p, oldM, newM } = await backfillGuess("wait");
  assert.equal(await supersededBy(oldM.id), null, "the older memory is still current");
  const links = (await ok<Any>("GET", `/entries/${newM.id}`)).links;
  assert.deepEqual(links.map((l: Any) => [l.other.id, l.type, l.pending]), [[oldM.id, "supersedes", true]]);
  const pending = await ok<Any[]>("GET", `/review/supersedes?project_id=${p.id}`);
  assert.deepEqual(pending.map((s) => [s.from_id, s.to_id, s.author]), [[newM.id, oldM.id, "llm"]]);
  assert.equal(pending[0].to.title, oldM.title);
  assert.deepEqual(await ok<Any[]>("GET", "/review/supersedes"), [], "the global / user scope has none");
  const h = await health();
  assert.equal(h.supersedesPending, before + 1);
  assert.equal(typeof h.supersedesPendingProject, "number");

  // A person confirms: the same link, now retiring.
  await ok("POST", `/entries/${newM.id}/links`, { to: oldM.id, type: "supersedes" });
  assert.equal(await supersededBy(oldM.id), newM.id);
  assert.deepEqual(await ok<Any[]>("GET", `/review/supersedes?project_id=${p.id}`), []);
  assert.equal((await ok<Any>("GET", `/entries/${newM.id}`)).links[0].pending, false);
});

test("G-084: dropping a guess or turning it into 'related' leaves both memories current", async () => {
  const { p, oldM, newM } = await backfillGuess("drop");
  await ok("DELETE", `/entries/${newM.id}/links?to=${oldM.id}&type=supersedes`);
  await ok("POST", `/entries/${newM.id}/links`, { to: oldM.id, type: "related" });
  assert.equal(await supersededBy(oldM.id), null);
  assert.deepEqual(await ok<Any[]>("GET", `/review/supersedes?project_id=${p.id}`), []);
  assert.deepEqual((await ok<Any>("GET", `/entries/${newM.id}`)).links.map((l: Any) => l.type), ["related"]);
});

test("G-084: the backfill passes pending for supersedes; the review page offers confirm / related / drop", () => {
  const worker = readFileSync(new URL("../src/graph-worker.ts", import.meta.url), "utf8");
  assert.match(worker, /addLink\(id, to, l\.type, "llm", \{ pending: l\.type === "supersedes" \}\)/);
  const page = readFileSync(new URL("../../web/src/pages/ReviewPage.tsx", import.meta.url), "utf8");
  assert.match(page, /<PendingSupersedes projectId=\{projectId\} \/>/);
  for (const label of ["대체 확인", "관련으로", "지우기"]) assert.ok(page.includes(label), label);
});

test("G-084: recall does not follow an unconfirmed supersedes as \"replaces\"", async () => {
  llmReset();
  const p = await project("github.com/test/g084-recall", "g084-recall");
  const oldM = await entry({ project_id: p.id, title: "g084 heliotrope 설정값", body: "heliotrope 버퍼는 64KB" });
  const newM = await entry({ project_id: p.id, title: "g084 다른 주제 메모", body: "관계없는 내용" });
  // Keep the stable block empty so the older memory reaches the prompt through recall.
  const { config } = await import("../src/config.ts");
  config.contextBudget = 1;
  const ask = () => ok<Any>("POST", "/context", { project: { key: p.key, name: p.name }, prompt: "heliotrope 버퍼 크기 알려줘" });
  // A pending guess, as the backfill leaves it.
  const { db } = await import("./helpers.ts");
  db.prepare(`INSERT INTO entry_links (from_id, to_id, type, author, retires) VALUES (?, ?, 'supersedes', 'llm', 0)`).run(newM.id, oldM.id);
  const r = await ask();
  assert.ok(r.recalled.includes(oldM.id), "the older memory is still current and recalled");
  assert.ok(!r.recalled.includes(newM.id), "the guess is no route to the other memory");
  assert.ok(!/replaces/.test(r.recall), "no \"replaces\" note for a guess");
});

test("G-084: the search corpus key changes when a supersedes is confirmed (retires 0 → 1)", () => {
  const src = readFileSync(new URL("../src/search.ts", import.meta.url), "utf8");
  assert.match(src, /IFNULL\(SUM\(retires\), 0\) FROM entry_links WHERE type = 'supersedes'/);
});
