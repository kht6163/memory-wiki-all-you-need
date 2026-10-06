// Similar-project suggestions: projects that are probably one project split by
// an origin change are suggested for merging. Suggest-only (ADR-0030), and a
// name match alone (a fork) is never enough.
import assert from "node:assert/strict";
import { test } from "node:test";

const { call, db, entry, ok, project } = await import("./helpers.ts");
const { findSimilarProjects } = await import("../src/project-similar.ts");

type Any = any;
const posted = (p: { key: string; name: string }, client: string, cwd: string) =>
  ok("POST", "/turns", { sessionId: `s-${client}-${cwd}`, project: p, client, cwd, messages: [{ role: "user", text: "hi" }] });
const doneTurns = () => db.exec(`UPDATE turns SET status = 'done' WHERE status IN ('pending','processing')`);
const similar = () => ok<Any[]>("GET", "/projects/similar");
const pairOf = (list: Any[], x: number, y: number) => list.find((p) => (p.a.id === x && p.b.id === y) || (p.a.id === y && p.b.id === x));
const input = (id: number, key: string, o: Partial<Any> = {}) => ({
  id,
  key,
  name: key.split("/").pop()!,
  last_seen_at: null,
  created_at: `2026-01-0${id}T00:00:00Z`,
  entry_count: 0,
  folders: new Set<string>(),
  entities: new Set<number>(),
  ...o,
});

test("G-062: GET /projects/similar is not read as a project id", async () => {
  const r = await call("GET", "/projects/similar");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data));
});

test("ADR-0030: the same folder on the same machine, and local/<x> next to an origin ending in /x, are suggested", async () => {
  const old = await project("github.com/old-owner/alpha-tool", "alpha-tool");
  await posted(old, "laptop", "/src/alpha");
  const now = await project("github.com/new-owner/alpha-renamed", "alpha-renamed");
  await posted(now, "laptop", "/src/alpha");
  const local = await project("local/beta-svc", "beta-svc");
  const remote = await project("gitlab.example.com/team/beta-svc", "beta-svc");
  doneTurns();
  const list = await similar();
  const f = pairOf(list, old.id, now.id);
  assert.ok(f, "same folder");
  assert.deepEqual(f.reasons, ["folder"]);
  assert.deepEqual(f.merge, { from: old.id, into: now.id }, "the one seen last keeps its key");
  const l = pairOf(list, local.id, remote.id);
  assert.ok(l, "origin added");
  assert.deepEqual(l.reasons, ["local"]);
  assert.deepEqual(l.merge, { from: local.id, into: remote.id });
  assert.equal(l.a.id, Math.min(local.id, remote.id));
  assert.equal(typeof l.a.entry_count, "number");
});

test("ADR-0030: a fork (same name, two origins) needs shared entities too; the same cwd on another machine is not a folder match", async () => {
  const forkA = await project("github.com/alice/gamma", "gamma");
  const forkB = await project("github.com/bob/gamma", "gamma");
  await posted(forkA, "pc-1", "/work/gamma");
  await posted(forkB, "pc-2", "/work/gamma");
  doneTurns();
  assert.equal(pairOf(await similar(), forkA.id, forkB.id), undefined);
  for (const p of [forkA, forkB]) {
    await entry({ project_id: p.id, title: `gamma notes ${p.id}`, entities: ["GammaCore", "GammaApi", "GammaDb"] });
  }
  const pair = pairOf(await similar(), forkA.id, forkB.id);
  assert.ok(pair);
  assert.deepEqual(pair.reasons, ["name", "entities"]);
  assert.equal(pair.shared_entities, 3);
});

test("ADR-0030: dismiss stops suggesting a pair; bad ids are refused", async () => {
  const a = await project("local/delta", "delta");
  const b = await project("github.com/x/delta", "delta");
  assert.ok(pairOf(await similar(), a.id, b.id));
  assert.deepEqual(await ok("POST", "/projects/similar/dismiss", { a: b.id, b: a.id }), { ok: true });
  await ok("POST", "/projects/similar/dismiss", { a: a.id, b: b.id }); // again: harmless
  assert.equal(pairOf(await similar(), a.id, b.id), undefined);
  const bad = async (body: Any, status: number, error: string) => {
    const r = await call("POST", "/projects/similar/dismiss", body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.data.error, error);
  };
  await bad({ a: 0, b: a.id }, 400, "a and b must be project ids");
  await bad({ a: "x", b: a.id }, 400, "a and b must be project ids");
  await bad({ a: a.id, b: a.id }, 400, "a and b must be different projects");
  await bad({ a: a.id, b: 999999 }, 404, "project not found");
});

test("ADR-0030: pure core — strong entity overlap alone, weak overlap alone not, deleted memories do not count", () => {
  const ents = (...ids: number[]) => new Set(ids);
  const list = findSimilarProjects([
    input(1, "github.com/a/one", { entities: ents(1, 2, 3, 4, 5) }),
    input(2, "github.com/b/two", { entities: ents(1, 2, 3, 4, 5, 6) }),
    input(3, "github.com/c/three", { entities: ents(1, 2, 3, 7, 8, 9, 10, 11, 12, 13) }),
  ]);
  assert.deepEqual(
    list.map((p) => [p.a.id, p.b.id, p.reasons]),
    [[1, 2, ["entities"]]],
  );
  // Tie in last seen → the newer project (higher id) is kept.
  assert.deepEqual(list[0].merge, { from: 1, into: 2 });
  const t = findSimilarProjects([
    input(1, "local/x", { last_seen_at: "2026-02-01T00:00:00Z" }),
    input(2, "github.com/o/x", { last_seen_at: "2026-01-01T00:00:00Z" }),
  ]);
  assert.deepEqual(t[0].merge, { from: 2, into: 1 }, "the one seen last wins even if it is the local key");
  assert.equal(findSimilarProjects([input(1, "local/x"), input(2, "github.com/o/x")], new Set(["1:2"])).length, 0);
});

test("ADR-0030: memories in the trash do not count as shared entities", async () => {
  const a = await project("github.com/p/eps-one", "eps-one");
  const b = await project("github.com/q/eps-two", "eps-two");
  const names = ["EpsA", "EpsB", "EpsC", "EpsD", "EpsE"];
  await entry({ project_id: a.id, title: "eps a", entities: names });
  const m = await entry({ project_id: b.id, title: "eps b", entities: names });
  assert.ok(pairOf(await similar(), a.id, b.id));
  await ok("DELETE", `/entries/${m.id}`);
  assert.equal(pairOf(await similar(), a.id, b.id), undefined);
});

test("ADR-0044: a folder project outside git (home/…, path/…) is not paired by its last segment alone", () => {
  for (const [a, b] of [
    ["local/test", "path/tmp/test"],
    ["home/kim/Downloads/docs", "local/docs"],
    ["path/srv/app", "github.com/o/app"],
    ["home/kim/app", "path/opt/app"],
  ]) {
    assert.equal(findSimilarProjects([input(1, a), input(2, b)]).length, 0, `${a} ~ ${b}`);
  }
  // The same folder still counts (a folder that later became a repo).
  const f = findSimilarProjects([input(1, "path/work/app", { folders: new Set(["pc|/work/app"]) }), input(2, "local/app", { folders: new Set(["pc|/work/app"]) })]);
  assert.deepEqual(f[0]?.reasons, ["folder"]);
});
