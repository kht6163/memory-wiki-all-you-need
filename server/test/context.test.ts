// /context: stable system block (G-005), per-prompt recall, bounded graph recall
// (G-018) and usage tracking. A small CONTEXT_BUDGET_CHARS keeps long memories
// out of the system block so they can only show up in recall.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.CONTEXT_BUDGET_CHARS = "400";
process.env.RECALL_BUDGET_CHARS = "3000";
delete process.env.GRAPH_RECALL_EXTRA;

const { call, db, entry, ok } = await import("./helpers.ts");
const { config } = await import("../src/config.ts");

// Filler made of dots: no letters, so it never matches a search term.
const pad = (n: number) => ".".repeat(n);
/** A project-scoped memory too long to ever fit the 400-char system block. */
const longMem = (pid: number, title: string, bodyLen = 420, extra: Partial<Parameters<typeof entry>[0]> = {}) =>
  entry({ scope: "project", project_id: pid, title, body: pad(bodyLen), ...extra });

let projSeq = 0;
async function proj() {
  projSeq++;
  const key = `example.com/ctx/p${projSeq}`;
  const r = await ok("POST", "/context", { project: { key, name: `p${projSeq}` }, prompt: "" });
  return r.project as { id: number; key: string; name: string };
}
const ctx = (p: { key: string; name: string }, prompt: string) => ok("POST", "/context", { project: { key: p.key, name: p.name }, prompt });
const preview = (pid: number, prompt: string) => ok("GET", `/context/preview?project_id=${pid}&prompt=${encodeURIComponent(prompt)}`);
const usage = async (id: number) => (await ok("GET", `/entries/${id}`)).usage as { recalled: number; searched: number; last_used_at: string | null; shown_at: string | null };
const NO_USAGE = { recalled: 0, searched: 0, last_used_at: null, shown_at: null };
const link = (from: number, to: number, type: string) => ok("POST", `/entries/${from}/links`, { to, type });
/** Memory lines of a recall block, each with its id and graph marker. */
function recallLines(recall: string) {
  return recall
    .split("\n")
    .filter((l) => l.startsWith("- [#"))
    .map((l) => ({ line: l, id: Number(/^- \[#(\d+)\]/.exec(l)![1]), via: /\(graph: ([^)]*)\)$/.exec(l)?.[1] ?? null }));
}

test("config picked up the test env (small context budget, default graph extra)", () => {
  assert.equal(config.contextBudget, 400);
  assert.equal(config.graph.recallExtra, 4);
});

test("G-005: system block is byte-identical across different prompts", async () => {
  const p = await proj();
  const a = await entry({ scope: "project", project_id: p.id, title: "alpha uses tabs" });
  const b = await entry({ scope: "project", project_id: p.id, title: "beta prefers yarn" });
  await entry({ category: "standing", title: "answer tersely" });
  const l1 = await longMem(p.id, "quokkafile rotation policy");
  const l2 = await longMem(p.id, "wombatcache eviction rule");

  const r1 = await ctx(p, "how does quokkafile rotation work?");
  const r2 = await ctx(p, "explain the wombatcache eviction");
  const r3 = await ctx(p, "");
  const r4 = await preview(p.id, "something unrelated entirely");
  assert.ok(r1.system.includes(`[#${a.id}]`) && r1.system.includes(`[#${b.id}]`), "short memories are in the system block");
  assert.ok(r1.system.includes("answer tersely"));
  assert.equal(r2.system, r1.system);
  assert.equal(r3.system, r1.system);
  assert.equal(r4.system, r1.system);
  // Prompt-specific content goes to recall only.
  assert.ok(!r1.system.includes("quokkafile") && !r1.system.includes("wombatcache"));
  assert.deepEqual(recallLines(r1.recall).map((x) => x.id), [l1.id]);
  assert.deepEqual(recallLines(r2.recall).map((x) => x.id), [l2.id]);
  assert.equal(r3.recall, "");
});

test("G-005: recall and search usage do not reorder the system block within the same day", async () => {
  const p = await proj();
  const first = await entry({ scope: "project", project_id: p.id, title: "first kiwiflag note" });
  const second = await entry({ scope: "project", project_id: p.id, title: "second note" });
  const third = await entry({ scope: "project", project_id: p.id, title: "third note" });
  const longOne = await longMem(p.id, "pangolinjob schedule");

  const before = await ctx(p, "");
  const order = (s: string) => [...s.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1])).filter((id) => [first.id, second.id, third.id].includes(id));
  assert.equal(order(before.system).length, 3);

  // A /context call that recalls something bumps usage.
  const rec = await ctx(p, "when does pangolinjob run?");
  assert.deepEqual(rec.recalled, [longOne.id]);
  assert.equal(rec.system, before.system);
  assert.equal((await usage(longOne.id)).recalled, 1);

  // Bump the memory that sorts last in the block; it must not jump ahead today.
  const last = order(before.system).at(-1)!;
  const lastTitle = [first, second, third].find((e) => e.id === last)!.title;
  await ok("GET", `/search?q=${encodeURIComponent(lastTitle)}&project_id=${p.id}&via=agent`);
  assert.ok((await usage(last)).searched >= 1);
  await ok("GET", `/graph/neighbors?id=${last}&project_id=${p.id}&via=agent`);

  const after1 = await ctx(p, "");
  const after2 = await ctx(p, "what about pangolinjob again");
  assert.equal(after1.system, before.system);
  assert.equal(after2.system, before.system);
});

/** Ids of the given memories in the order the system block lists them. */
const blockOrder = (system: string, ids: number[]) => [...system.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1])).filter((id) => ids.includes(id));
/** Move a memory's write time back by whole days, so usage days can outrank it. */
const backdate = (id: number, days: number) =>
  db.prepare(`UPDATE entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) WHERE id = ?`).run(`-${days} days`, id);
const rawUsage = (id: number) => db.prepare(`SELECT last_used_at, rank_day FROM entry_usage WHERE entry_id = ?`).get(id) as { last_used_at: string | null; rank_day: string | null } | undefined;
const dayOffset = (days: number) => String((db.prepare(`SELECT date('now', ?) AS d`).get(`${days} days`) as { d: string }).d);

test("G-005: same-day usage of old memories leaves the block byte-identical; previous-day usage moves them up", async () => {
  const p = await proj();
  // Each line is ~125 chars: the project share (280 with carry) fits exactly two.
  const m1 = await entry({ scope: "project", project_id: p.id, title: "heronmark note", body: pad(100) });
  const m2 = await entry({ scope: "project", project_id: p.id, title: "ibisquill note", body: pad(100) });
  const m3 = await entry({ scope: "project", project_id: p.id, title: "jacanatrail note", body: pad(100) });
  const m4 = await entry({ scope: "project", project_id: p.id, title: "zebrafinch note", body: pad(100) });
  const ids = [m1.id, m2.id, m3.id, m4.id];
  // Written days ago, so a use day can be newer than the write day.
  backdate(m1.id, 3);
  backdate(m2.id, 4);
  backdate(m3.id, 5);
  backdate(m4.id, 6);

  const before = await ctx(p, "");
  assert.deepEqual(blockOrder(before.system, ids), [m1.id, m2.id], "newest writes first, two fit");
  assert.match(before.system, /\(2 more not shown/);

  // Recall of an omitted memory today: counted, but the block does not change.
  const rec = await ctx(p, "zebrafinch");
  assert.deepEqual(rec.recalled, [m4.id]);
  assert.equal(rec.system, before.system);
  assert.equal((await usage(m4.id)).recalled, 1);
  assert.equal(rawUsage(m4.id)?.rank_day ?? null, null, "first ever use has no previous use day");

  // Agent search for the memory that sorts second (already in the block).
  const hits = await ok<any[]>("GET", `/search?q=ibisquill&project_id=${p.id}&via=agent`);
  assert.ok(hits.some((h) => h.id === m2.id));
  assert.equal((await usage(m2.id)).searched, 1);
  await ok("GET", `/graph/neighbors?id=${m2.id}&project_id=${p.id}&via=agent`);
  await ctx(p, "zebrafinch again");

  for (const s of [(await ctx(p, "")).system, (await ctx(p, "jacanatrail")).system, (await preview(p.id, "anything")).system]) {
    assert.equal(s, before.system, "same-day usage never changes the stable block");
  }

  // Pretend m4's last use was yesterday: it now outranks everything written days ago.
  db.prepare(`UPDATE entry_usage SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), rank_day = NULL WHERE entry_id = ?`).run(m4.id);
  const moved = await ctx(p, "");
  assert.notEqual(moved.system, before.system);
  assert.deepEqual(blockOrder(moved.system, ids), [m4.id, m1.id], "yesterday's use moves m4 up and pushes m2 out");

  // Using m4 again today keeps yesterday as its ranking day, so nothing moves.
  await ok("GET", `/search?q=zebrafinch&project_id=${p.id}&via=agent`);
  const ru = rawUsage(m4.id)!;
  assert.equal(ru.rank_day, dayOffset(-1), "first use on a new day remembers the previous use day");
  assert.equal(ru.last_used_at!.slice(0, 10), dayOffset(0));
  await ok("GET", `/search?q=zebrafinch&project_id=${p.id}&via=agent`);
  assert.equal(rawUsage(m4.id)!.rank_day, dayOffset(-1), "a second use the same day keeps rank_day");
  assert.equal((await ctx(p, "")).system, moved.system);

  // Used today but previously two days ago: ranks by that earlier day (newer than m1's write).
  db.prepare(`UPDATE entry_usage SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), rank_day = date('now', '-2 days') WHERE entry_id = ?`).run(m2.id);
  assert.deepEqual(blockOrder((await ctx(p, "")).system, ids), [m4.id, m2.id]);

  // A use day older than the write day does not lift a memory above newer writes.
  db.prepare(`UPDATE entry_usage SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'), rank_day = NULL WHERE entry_id IN (?, ?)`).run(m4.id, m2.id);
  assert.equal((await ctx(p, "")).system, before.system);
});

test("shown: POST /context records shown_at for included memories once a day; preview records nothing", async () => {
  const p = await proj();
  const sys = await entry({ scope: "project", project_id: p.id, title: "shown kestrelbox note" });
  const rec = await longMem(p.id, "kestrelbox recall only");

  const pv = await preview(p.id, "kestrelbox");
  assert.ok(pv.included.includes(sys.id));
  assert.deepEqual(pv.recalled, [rec.id]);
  assert.deepEqual(await usage(sys.id), NO_USAGE, "preview records no shown_at");
  assert.deepEqual(await usage(rec.id), NO_USAGE, "preview records no recall");

  const r = await ctx(p, "kestrelbox");
  assert.ok(r.included.includes(sys.id));
  assert.deepEqual(r.recalled, [rec.id]);
  const s1 = await usage(sys.id);
  assert.ok(s1.shown_at && !Number.isNaN(Date.parse(s1.shown_at)));
  assert.equal(s1.shown_at.slice(0, 10), dayOffset(0));
  assert.deepEqual({ ...s1, shown_at: null }, NO_USAGE);
  const ru = await usage(rec.id);
  assert.equal(ru.shown_at, null, "recall is not the stable block");
  assert.equal(ru.recalled, 1);
  for (const id of r.included) assert.ok((await usage(id)).shown_at, `included #${id} has shown_at`);

  // A second call the same day does not rewrite shown_at.
  await ctx(p, "");
  await ctx(p, "kestrelbox");
  assert.equal((await usage(sys.id)).shown_at, s1.shown_at);

  // Being shown does not reorder anything or count as use.
  const u = await usage(sys.id);
  assert.equal(u.recalled + u.searched, 0);
  assert.equal(u.last_used_at, null);
});

test("G-005: system block changes when memory changes", async () => {
  const p = await proj();
  await entry({ scope: "project", project_id: p.id, title: "gamma note" });
  const before = await ctx(p, "x");
  await entry({ scope: "project", project_id: p.id, title: "delta note" });
  const after = await ctx(p, "x");
  assert.notEqual(after.system, before.system);
  assert.ok(after.system.includes("delta note"));
});

test("recall holds prompt-specific hits that are not already in the system block", async () => {
  const p = await proj();
  const inSys = await entry({ scope: "project", project_id: p.id, title: "lemurdb port" });
  const outSys = await longMem(p.id, "lemurdb backup procedure");
  const unrelated = await longMem(p.id, "ocelot deploy steps");

  const r = await ctx(p, "lemurdb");
  assert.ok(r.included.includes(inSys.id));
  assert.ok(r.system.includes(`[#${inSys.id}]`));
  const ids = recallLines(r.recall).map((x) => x.id);
  assert.deepEqual(ids, [outSys.id]);
  assert.ok(!ids.includes(unrelated.id));
  assert.deepEqual(r.recalled, ids);
  for (const id of r.recalled) assert.ok(!r.included.includes(id), "recall never repeats the system block");
  assert.match(r.recall, /^<memory-recall note="[^"]*">\n[\s\S]*\n<\/memory-recall>$/);
  assert.ok(recallLines(r.recall).every((x) => x.via === null), "plain search hits carry no graph marker");
});

test("recall skips standing instructions", async () => {
  const p = await proj();
  await entry({ category: "standing", title: "always mention capybaralog", body: pad(420) });
  const r = await ctx(p, "capybaralog");
  assert.equal(r.recall, "");
  assert.deepEqual(r.recalled, []);
});

test("G-018: entity-mention extras are capped at GRAPH_RECALL_EXTRA and marked (graph: name)", async () => {
  const p = await proj();
  const hit = await longMem(p.id, "narwhalq pipeline overview");
  const ents: { id: number }[] = [];
  for (let i = 0; i < 3; i++) ents.push(await longMem(p.id, `first family item ${i}`, 300, { entities: [{ name: "Zorbexio", kind: "tech" }] }));
  for (let i = 0; i < 3; i++) ents.push(await longMem(p.id, `second family item ${i}`, 300, { entities: [{ name: "Quilvantra", kind: "tech" }] }));

  const r = await ctx(p, "narwhalq with zorbexio and quilvantra");
  const lines = recallLines(r.recall);
  assert.equal(lines[0].id, hit.id, "search hits come first");
  assert.equal(lines[0].via, null);
  const extras = lines.filter((x) => x.via !== null);
  assert.equal(extras.length, config.graph.recallExtra);
  assert.equal(lines.length, 1 + config.graph.recallExtra);
  for (const x of extras) {
    assert.ok(ents.some((e) => e.id === x.id));
    assert.ok(["Zorbexio", "Quilvantra"].includes(x.via!), `marker was ${x.via}`);
  }
  assert.equal((r.recall.match(/\(graph: /g) ?? []).length, config.graph.recallExtra);
  assert.equal(new Set(lines.map((x) => x.id)).size, lines.length, "no duplicates");
  const memChars = lines.reduce((n, x) => n + x.line.length, 0);
  assert.ok(memChars <= config.recallBudget);
  // At most 3 memories per mentioned entity.
  const firstFamily = new Set(ents.slice(0, 3).map((e) => e.id));
  assert.ok(extras.filter((x) => firstFamily.has(x.id)).length <= 3);
});

test("G-018: graph extras only fill what the recall budget leaves", async () => {
  const p = await proj();
  const hit = await longMem(p.id, "ibexstore sharding", 1500);
  const ents: number[] = [];
  for (let i = 0; i < 3; i++) ents.push((await longMem(p.id, `kudu item ${i}`, 600, { entities: [{ name: "Tranquor", kind: "tech" }] })).id);

  const r = await ctx(p, "ibexstore and tranquor");
  const lines = recallLines(r.recall);
  assert.equal(lines[0].id, hit.id);
  const memChars = lines.reduce((n, x) => n + x.line.length, 0);
  assert.ok(memChars <= config.recallBudget, `recall memory lines ${memChars} > ${config.recallBudget}`);
  assert.ok(lines.length >= 2 && lines.length < 4, `expected the budget to cut extras, got ${lines.length} lines`);
  assert.deepEqual(r.recalled, lines.map((x) => x.id));
});

test("G-018: search hits are never pushed out by graph extras", async () => {
  const p = await proj();
  const hits: number[] = [];
  for (let i = 0; i < 2; i++) hits.push((await longMem(p.id, `yakbridge hit ${i}`, 1300)).id);
  for (let i = 0; i < 3; i++) await longMem(p.id, `entity mem ${i}`, 300, { entities: [{ name: "Velmorith", kind: "tech" }] });
  const r = await ctx(p, "yakbridge velmorith");
  const lines = recallLines(r.recall);
  assert.deepEqual(lines.filter((x) => x.via === null).map((x) => x.id).sort(), [...hits].sort());
  assert.ok(lines.slice(0, 2).every((x) => x.via === null), "search hits are listed before extras");
  assert.ok(lines.reduce((n, x) => n + x.line.length, 0) <= config.recallBudget);
});

test("G-018: graph never adds memories already in the system block", async () => {
  const p = await proj();
  const short = await entry({ scope: "project", project_id: p.id, title: "short", entities: [{ name: "Harrowmint", kind: "tech" }] });
  const long = await longMem(p.id, "long one", 420, { entities: [{ name: "Harrowmint", kind: "tech" }] });
  const r = await ctx(p, "tell me about harrowmint");
  assert.ok(r.included.includes(short.id));
  const ids = recallLines(r.recall).map((x) => x.id);
  assert.ok(!ids.includes(short.id));
  assert.deepEqual(ids, [long.id]);
  assert.ok(!/\(graph: [^…]/.test(r.system), "graph markers never reach the system block (the policy text only names the format)");
});

test("G-018: because / depends_on neighbors of recalled memories are added with link marker", async () => {
  const p = await proj();
  const hit = await longMem(p.id, "falconsync retries");
  const why = await longMem(p.id, "upstream was flaky in march");
  const dep = await longMem(p.id, "needs the queue service");
  const rel = await longMem(p.id, "loosely related note");
  await link(hit.id, why.id, "because");
  await link(hit.id, dep.id, "depends_on");
  await link(hit.id, rel.id, "related");

  const r = await ctx(p, "falconsync");
  const lines = recallLines(r.recall);
  assert.equal(lines[0].id, hit.id);
  const byId = new Map(lines.map((x) => [x.id, x.via]));
  assert.equal(byId.get(why.id), `because #${hit.id}`);
  assert.equal(byId.get(dep.id), `depends_on #${hit.id}`);
  assert.ok(!byId.has(rel.id), "related links are not followed by recall");
});

test("G-018: supersedes is followed only toward the newer memory", async () => {
  const p = await proj();
  const oldM = await longMem(p.id, "marmotlog v1 format");
  const newM = await longMem(p.id, "the current log format");
  await link(newM.id, oldM.id, "supersedes");

  // Recalling the old one brings in its replacement.
  const fromOld = recallLines((await ctx(p, "marmotlog")).recall);
  assert.equal(fromOld[0].id, oldM.id);
  const repl = fromOld.find((x) => x.id === newM.id);
  assert.ok(repl, "newer memory is added");
  assert.equal(repl!.via, `replaces #${oldM.id}`);

  // Recalling the new one never drags the stale one back.
  const newHit = await longMem(p.id, "tapirlog current format");
  const stale = await longMem(p.id, "ancient format");
  await link(newHit.id, stale.id, "supersedes");
  const fromNew = recallLines((await ctx(p, "tapirlog")).recall);
  assert.deepEqual(fromNew.map((x) => x.id), [newHit.id]);
});

test("usage: POST /context counts recalled ids only; the system block is not counted", async () => {
  const p = await proj();
  const sys = await entry({ scope: "project", project_id: p.id, title: "gazellequeue size" });
  const rec = await longMem(p.id, "gazellequeue tuning");
  const r = await ctx(p, "gazellequeue");
  assert.ok(r.included.includes(sys.id));
  assert.deepEqual(r.recalled, [rec.id]);
  const u = await usage(rec.id);
  assert.equal(u.recalled, 1);
  assert.equal(u.searched, 0);
  assert.ok(u.last_used_at && !Number.isNaN(Date.parse(u.last_used_at)));
  const su = await usage(sys.id);
  assert.deepEqual({ ...su, shown_at: null }, NO_USAGE, "being in the system block is not use");
  assert.ok(su.shown_at, "but it is recorded as shown");
  await ctx(p, "gazellequeue again");
  assert.equal((await usage(rec.id)).recalled, 2);
});

test("usage: graph extras recalled by POST /context are counted too", async () => {
  const p = await proj();
  const hit = await longMem(p.id, "okapiroute table");
  const why = await longMem(p.id, "reason for the table");
  await link(hit.id, why.id, "because");
  const r = await ctx(p, "okapiroute");
  assert.deepEqual([...r.recalled].sort(), [hit.id, why.id].sort());
  assert.equal((await usage(why.id)).recalled, 1);
});

test("usage: GET /context/preview never counts", async () => {
  const p = await proj();
  const m = await longMem(p.id, "dingoindex rebuild");
  const r = await preview(p.id, "dingoindex");
  assert.deepEqual(r.recalled, [m.id]);
  assert.deepEqual(await usage(m.id), NO_USAGE);
});

test("usage: GET /search counts only with via=agent", async () => {
  const p = await proj();
  const m = await longMem(p.id, "civetproxy timeout");
  const plain = await ok<any[]>("GET", `/search?q=civetproxy&project_id=${p.id}`);
  assert.deepEqual(plain.map((h) => h.id), [m.id]);
  await ok("GET", `/search?q=civetproxy&project_id=${p.id}&via=web`);
  assert.deepEqual(await usage(m.id), NO_USAGE);
  await ok("GET", `/search?q=civetproxy&project_id=${p.id}&via=agent`);
  const u = await usage(m.id);
  assert.equal(u.searched, 1);
  assert.equal(u.recalled, 0);
  assert.ok(u.last_used_at);
});

test("usage: /graph/neighbors counts only with via=agent (memory and entity form)", async () => {
  const p = await proj();
  const a = await longMem(p.id, "graph usage a", 50, { entities: [{ name: "Sablewick", kind: "tech" }] });
  const b = await longMem(p.id, "graph usage b", 50, { entities: [{ name: "Sablewick", kind: "tech" }] });

  await ok("GET", `/graph/neighbors?id=${a.id}&project_id=${p.id}`);
  await ok("GET", `/graph/neighbors?entity=Sablewick&project_id=${p.id}`);
  assert.equal((await usage(a.id)).searched, 0);
  assert.equal((await usage(b.id)).searched, 0);

  await ok("GET", `/graph/neighbors?id=${a.id}&project_id=${p.id}&via=agent`);
  assert.equal((await usage(a.id)).searched, 1);
  assert.equal((await usage(b.id)).searched, 0);

  await ok("GET", `/graph/neighbors?entity=Sablewick&project_id=${p.id}&via=agent`);
  assert.equal((await usage(a.id)).searched, 2);
  assert.equal((await usage(b.id)).searched, 1);
  assert.equal((await usage(a.id)).recalled, 0);
});

test("GET /entries/:id returns usage; unknown id is 404", async () => {
  const p = await proj();
  const m = await longMem(p.id, "usage shape check");
  const d = await ok("GET", `/entries/${m.id}`);
  assert.deepEqual(d.usage, NO_USAGE);
  assert.equal(d.entry.id, m.id);
  const missing = await call("GET", "/entries/999999");
  assert.equal(missing.status, 404);
});
