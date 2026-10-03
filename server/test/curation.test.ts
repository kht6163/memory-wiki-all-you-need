import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { call, db, entry, llmCalls, llmReply, llmReset, ok, project, runQueueOnce, turn } from "./helpers.ts";

// Turn curation through the fake LLM: which ops are honoured (G-009), how the
// graph rides the single curation call (G-019), skipping, errors and retry.

let seq = 0;
/** A fresh project per test so the "latest project memories" candidate list stays small and predictable. */
async function freshProject() {
  seq++;
  return project(`github.com/test/curation-${seq}`, `curation-${seq}`);
}

/** Parse the EXISTING MEMORIES block of the curation prompt into candidate objects. */
function shownCandidates(user: string): { id: number; entities: string[]; links?: { to: number; type: string }[] }[] {
  const start = user.indexOf("EXISTING MEMORIES");
  const end = user.indexOf("KNOWN ENTITIES");
  assert.ok(start >= 0 && end > start, "prompt has an EXISTING MEMORIES block");
  return user
    .slice(start, end)
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
}

const getEntry = (id: number) => ok("GET", `/entries/${id}`);
const getTurn = (id: number) => ok("GET", `/turns/${id}`);
const maxEntryId = () => Number((db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM entries").get() as { m: number }).m);
const linkCount = (from: number, to: number) =>
  Number((db.prepare("SELECT COUNT(*) AS n FROM entry_links WHERE from_id = ? AND to_id = ?").get(from, to) as { n: number }).n);

beforeEach(() => llmReset());

test("G-009: update/delete apply to shown candidates and ignore ids that were not shown", async () => {
  const p = await freshProject();
  const other = await freshProject();
  const shown = await entry({ project_id: p.id, title: "deploy uses docker compose", body: "compose file at repo root" });
  const shown2 = await entry({ project_id: p.id, title: "staging deploy runs nightly", body: "cron at 02:00" });
  const hidden = await entry({ project_id: other.id, title: "zebra quokka unrelated note", body: "lorem" });

  llmReply((c: { user: string }) => {
    const ids = shownCandidates(c.user).map((x) => x.id);
    assert.ok(ids.includes(shown.id), "project memory is shown to the LLM");
    assert.ok(!ids.includes(hidden.id), "other project's memory is not shown");
    return {
      ops: [
        { op: "update", id: hidden.id, title: "HIJACKED", reason: "not shown" },
        { op: "delete", id: hidden.id, reason: "not shown" },
        { op: "update", id: shown.id, title: "deploy uses docker compose v2", reason: "turn says v2" },
        { op: "delete", id: shown2.id, reason: "obsolete" },
      ],
      note: "mixed",
    };
  });
  const t = await turn([{ role: "user", text: "deploy now uses docker compose v2; nightly staging deploy is gone" }, { role: "assistant", text: "updated" }], p);
  await runQueueOnce();

  assert.equal(llmCalls.length, 1);
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.equal(done.result.ops.length, 4, "raw ops are kept in the result");
  assert.deepEqual(
    done.result.applied.map((a: any) => [a.op, a.entryId]),
    [
      ["update", shown.id],
      ["delete", shown2.id],
    ],
  );
  const h = await getEntry(hidden.id);
  assert.equal(h.entry.title, "zebra quokka unrelated note");
  assert.equal(h.entry.deleted_at, null);
  const s = await getEntry(shown.id);
  assert.equal(s.entry.title, "deploy uses docker compose v2");
  const s2 = await getEntry(shown2.id);
  assert.ok(s2.entry.deleted_at, "shown candidate was soft-deleted");
});

test("G-009: ops on non-existent ids are ignored without failing the turn", async () => {
  const p = await freshProject();
  const before = maxEntryId();
  llmReply({ ops: [{ op: "update", id: 987654, title: "ghost" }, { op: "delete", id: 987655 }, { op: "update", id: "abc", title: "x" }] });
  const t = await turn([{ role: "user", text: "the build cache lives in .cache/build" }], p);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.applied, []);
  assert.equal(maxEntryId(), before);
});

test("G-009: the candidate list in the prompt matches exactly the ids that may be changed", async () => {
  const p = await freshProject();
  const a = await entry({ project_id: p.id, title: "lint runs with eslint flat config" });
  llmReply((c: { user: string }) => {
    const ids = shownCandidates(c.user).map((x) => x.id);
    // Update every shown id plus one that is not shown; only shown ones may apply.
    const notShown = Math.max(...ids, maxEntryId()) + 1000;
    return { ops: [...ids.map((id) => ({ op: "update", id, tags: ["touched"] })), { op: "update", id: notShown, tags: ["touched"] }] };
  });
  const t = await turn([{ role: "user", text: "eslint flat config is the lint setup here" }], p);
  await runQueueOnce();
  const shownIds = shownCandidates(llmCalls[0].user).map((x) => x.id);
  assert.ok(shownIds.includes(a.id));
  const done = await getTurn(t.id);
  const appliedIds = done.result.applied.map((x: any) => x.entryId).sort((x: number, y: number) => x - y);
  assert.ok(appliedIds.every((id: number) => shownIds.includes(id)), "every applied id was shown");
  assert.ok(appliedIds.includes(a.id));
});

test("G-019: exactly one LLM call per turn, and add attaches entities", async () => {
  const p = await freshProject();
  llmReply(
    { ops: [{ op: "add", scope: "project", category: "fact", title: "cache is Redis", body: "port 6379", entities: [{ name: "Redis", kind: "tech" }] }] },
    { ops: [{ op: "add", scope: "project", category: "convention", title: "use pnpm", body: "not npm", entities: [{ name: "pnpm", kind: "tool" }, { name: "Node.js", kind: "tech" }] }] },
  );
  const t1 = await turn([{ role: "user", text: "our cache is Redis on the default port" }], p);
  const t2 = await turn([{ role: "user", text: "always use pnpm for installs, never npm" }], p);
  await runQueueOnce();

  assert.equal(llmCalls.length, 2, "one call per turn, no separate graph call");
  const d1 = await getTurn(t1.id);
  const d2 = await getTurn(t2.id);
  assert.equal(d1.status, "done");
  assert.equal(d2.status, "done");
  const e1 = await getEntry(d1.result.applied[0].entryId);
  assert.deepEqual(e1.entities.map((n: any) => n.name), ["Redis"]);
  const e2 = await getEntry(d2.result.applied[0].entryId);
  assert.deepEqual(e2.entities.map((n: any) => n.name).sort(), ["Node.js", "pnpm"]);
  assert.equal(e2.entry.project_id, p.id);
  // The graph instructions ride the curation prompt itself.
  assert.match(llmCalls[0].system, /entities/);
  assert.match(llmCalls[0].system, /links/);
});

test("G-019: add links only to shown candidates or memories added in the same response", async () => {
  const p = await freshProject();
  const other = await freshProject();
  const cand = await entry({ project_id: p.id, title: "migration to postgres failed on enum types" });
  const hidden = await entry({ project_id: other.id, title: "walrus narwhal unrelated" });

  let firstNew = 0;
  llmReply(() => {
    firstNew = maxEntryId() + 1;
    return {
      ops: [
        { op: "add", scope: "project", category: "decision", title: "keep sqlite for now", body: "enum migration failed", entities: [{ name: "SQLite", kind: "tech" }], links: [{ to: cand.id, type: "because" }, { to: hidden.id, type: "related" }] },
        { op: "add", scope: "project", category: "insight", title: "enum types need manual casts", entities: [{ name: "PostgreSQL", kind: "tech" }], links: [{ to: firstNew, type: "related" }, { to: hidden.id, type: "because" }, { to: 999999, type: "related" }] },
      ],
    };
  });
  const t = await turn([{ role: "user", text: "the postgres migration failed on enum types, we keep sqlite" }], p);
  await runQueueOnce();

  const done = await getTurn(t.id);
  assert.equal(done.result.applied.length, 2);
  const [a1, a2] = done.result.applied.map((x: any) => x.entryId);
  assert.equal(a1, firstNew);
  assert.equal(linkCount(a1, cand.id), 1, "link to shown candidate kept");
  assert.equal(linkCount(a1, hidden.id), 0, "link to unseen memory dropped");
  assert.equal(linkCount(a2, a1), 1, "link to memory added in same response kept");
  assert.equal(linkCount(a2, hidden.id), 0);
  assert.equal(linkCount(a2, 999999), 0);
  const h = await getEntry(hidden.id);
  assert.deepEqual(h.links, []);
});

test("G-019: link op relates two shown candidates and is ignored when either end was not shown", async () => {
  const p = await freshProject();
  const other = await freshProject();
  const a = await entry({ project_id: p.id, title: "api gateway runs traefik" });
  const b = await entry({ project_id: p.id, title: "traefik needs docker socket access" });
  const hidden = await entry({ project_id: other.id, title: "platypus wombat unrelated" });

  llmReply({
    ops: [
      { op: "link", from: a.id, to: b.id, type: "depends_on" },
      { op: "link", from: hidden.id, to: a.id, type: "related" },
      { op: "link", from: b.id, to: hidden.id, type: "related" },
      { op: "link", from: a.id, to: a.id, type: "related" },
      { op: "link", from: b.id, to: a.id, type: "not-a-type" },
    ],
  });
  const t = await turn([{ role: "user", text: "traefik gateway depends on docker socket access" }], p);
  await runQueueOnce();

  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.equal(linkCount(a.id, b.id), 1);
  const row = db.prepare("SELECT type, author FROM entry_links WHERE from_id = ? AND to_id = ?").get(a.id, b.id) as { type: string; author: string };
  assert.equal(row.type, "depends_on");
  assert.equal(row.author, "llm");
  assert.equal(linkCount(hidden.id, a.id), 0);
  assert.equal(linkCount(b.id, hidden.id), 0);
  assert.equal(linkCount(a.id, a.id), 0);
  assert.equal(linkCount(b.id, a.id), 0);
  // The link op does not count as a memory change.
  assert.deepEqual(done.result.applied, []);
  // Next turn shows the existing out-link on the candidate.
  llmReply({ ops: [] });
  await turn([{ role: "user", text: "traefik gateway still on docker socket" }], p);
  await runQueueOnce();
  const shownA = shownCandidates(llmCalls[1].user).find((x) => x.id === a.id);
  assert.deepEqual(shownA?.links, [{ to: b.id, type: "depends_on" }]);
});

test("trivial turns are skipped without an LLM call", async () => {
  const p = await freshProject();
  const t = await turn([{ role: "user", text: "ok" }, { role: "assistant", text: "thanks!" }], p);
  await runQueueOnce();
  assert.equal(llmCalls.length, 0);
  const done = await getTurn(t.id);
  assert.equal(done.status, "skipped");
  assert.equal(done.result.note, "trivial turn");
  assert.deepEqual(done.result.applied, []);
});

test("short turns with tool calls are not trivial and are curated", async () => {
  const p = await freshProject();
  llmReply({ ops: [], note: "nothing durable" });
  const t = await turn([{ role: "user", text: "ls" }, { role: "assistant", text: "", toolCalls: [{ name: "bash", args: "ls" }] }, { role: "tool", name: "bash", text: "a b" }], p);
  await runQueueOnce();
  assert.equal(llmCalls.length, 1);
  const done = await getTurn(t.id);
  assert.equal(done.status, "done");
  assert.equal(done.result.note, "nothing durable");
});

test("LLM HTTP error marks the turn as error; retry re-queues and a later run completes it", async () => {
  const p = await freshProject();
  llmReply(new Error("upstream exploded"));
  const t = await turn([{ role: "user", text: "remember that the docs site builds with mkdocs" }], p);
  await runQueueOnce();
  assert.equal(llmCalls.length, 1);
  let cur = await getTurn(t.id);
  assert.equal(cur.status, "error");
  assert.match(cur.error, /LLM HTTP 500/);
  assert.match(cur.error, /upstream exploded/);
  assert.equal(cur.result, null);

  const r = await ok("POST", `/turns/${t.id}/retry`);
  assert.equal(r.status, "pending");
  assert.equal(r.error, null);

  llmReply({ ops: [{ op: "add", scope: "project", category: "fact", title: "docs build with mkdocs", entities: [{ name: "MkDocs", kind: "tool" }] }] });
  await runQueueOnce();
  assert.equal(llmCalls.length, 2);
  cur = await getTurn(t.id);
  assert.equal(cur.status, "done");
  assert.equal(cur.error, null);
  assert.equal(cur.result.applied.length, 1);
});

test("retry of an unknown turn is 404", async () => {
  const r = await call("POST", "/turns/999999/retry");
  assert.equal(r.status, 404);
});

test("non-JSON LLM output errors the turn instead of applying anything", async () => {
  const p = await freshProject();
  const before = maxEntryId();
  llmReply("I am not JSON at all");
  const t = await turn([{ role: "user", text: "remember the port for grafana is 3000" }], p);
  await runQueueOnce();
  const cur = await getTurn(t.id);
  assert.equal(cur.status, "error");
  assert.equal(maxEntryId(), before);
});

test("agent-saved memory without entities gets entities via an update op with only id+entities", async () => {
  const p = await freshProject();
  const saved = await ok("POST", "/agent/memory", {
    action: "add",
    target: "project",
    title: "backups go to restic repo",
    content: "nightly restic backup to the NAS",
    project: { key: p.key, name: p.name },
  });
  const id = saved.entry.id;
  const before = await getEntry(id);
  assert.deepEqual(before.entities, []);
  const revsBefore = before.revisions.length;

  llmReply((c: { user: string }) => {
    const shown = shownCandidates(c.user).find((x) => x.id === id);
    assert.ok(shown, "agent memory is shown as a candidate");
    assert.deepEqual(shown.entities, [], "shown with an empty entity list");
    return { ops: [{ op: "update", id, entities: [{ name: "restic", kind: "tool" }, { name: "NAS", kind: "service" }] }] };
  });
  const t = await turn(
    [
      { role: "user", text: "save that backups go nightly to restic" },
      { role: "assistant", text: "saved", toolCalls: [{ name: "memory_add", args: "{\"content\":\"nightly restic backup\"}" }] },
      { role: "tool", name: "memory_add", text: "ok" },
    ],
    p,
  );
  await runQueueOnce();

  assert.equal(llmCalls.length, 1);
  const done = await getTurn(t.id);
  assert.deepEqual(done.result.applied.map((a: any) => [a.op, a.entryId]), [["update", id]]);
  const after = await getEntry(id);
  assert.deepEqual(after.entities.map((n: any) => n.name).sort(), ["NAS", "restic"]);
  assert.equal(after.entry.title, before.entry.title, "title untouched");
  assert.equal(after.entry.body, before.entry.body, "body untouched");
  assert.equal(after.entry.category, before.entry.category, "category untouched");
  assert.deepEqual(after.entry.tags, before.entry.tags, "tags untouched");
  assert.ok(after.revisions.length > revsBefore, "entity change is recorded as a revision");
});

test("update without entities keeps the existing entity list", async () => {
  const p = await freshProject();
  const e = await entry({ project_id: p.id, title: "metrics scraped by prometheus", entities: [{ name: "Prometheus", kind: "tool" }] });
  llmReply({ ops: [{ op: "update", id: e.id, body: "scrape interval 15s" }] });
  await turn([{ role: "user", text: "prometheus scrape interval is 15s" }], p);
  await runQueueOnce();
  const after = await getEntry(e.id);
  assert.equal(after.entry.body, "scrape interval 15s");
  assert.deepEqual(after.entities.map((n: any) => n.name), ["Prometheus"]);
});

test("add with scope project but no project falls back to global; at most 20 ops are applied", async () => {
  const ops = Array.from({ length: 25 }, (_, i) => ({ op: "add", scope: "project", category: "fact", title: `bulk fact ${i}`, entities: [{ name: `Thing${i}`, kind: "concept" }] }));
  llmReply({ ops });
  const t = await turn([{ role: "user", text: "a long list of facts to remember right now" }], null);
  await runQueueOnce();
  const done = await getTurn(t.id);
  assert.equal(done.result.applied.length, 20);
  const first = await getEntry(done.result.applied[0].entryId);
  assert.equal(first.entry.scope, "global");
  assert.equal(first.entry.project_id, null);
  assert.match(llmCalls[0].user, /CURRENT PROJECT: none/);
});

test("the curation prompt dates the turn by when it happened, not when it is curated", async () => {
  const p = await freshProject();
  const t = await turn([{ role: "user", text: "yesterday the nightly build broke on the arm runner" }, { role: "assistant", text: "noted" }], p);
  // A backlog: the turn was recorded days before the worker gets to it.
  db.prepare("UPDATE turns SET created_at = ? WHERE id = ?").run("2026-03-04T10:00:00.000Z", t.id);
  llmReply((c: { system: string; user: string }) => {
    assert.match(c.user, /^TURN DATE: 2026-03-04 \(UTC\)$/m);
    assert.match(c.user, new RegExp(`^TODAY: ${new Date().toISOString().slice(0, 10)}$`, "m"));
    assert.match(c.system, /Resolve them against TURN DATE/);
    return { ops: [] };
  });
  await runQueueOnce();
  assert.equal(llmCalls.length, 1);
  assert.equal((await getTurn(t.id)).status, "done");
});

test("TURN DATE uses TIMEZONE: 01:00 in Seoul is still the previous day in UTC", async () => {
  const { config } = await import("../src/config.ts");
  const { localDate } = await import("../src/worker.ts");
  const prev = config.timezone;
  try {
    (config as { timezone: string }).timezone = "Asia/Seoul";
    assert.equal(localDate("2026-03-03T16:30:00.000Z"), "2026-03-04");
    (config as { timezone: string }).timezone = "UTC";
    assert.equal(localDate("2026-03-03T16:30:00.000Z"), "2026-03-03");
  } finally {
    (config as { timezone: string }).timezone = prev;
  }
});
