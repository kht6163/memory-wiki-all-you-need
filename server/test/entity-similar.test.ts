// Similar-entity merge suggestions (GET /entities/similar, dismiss) and the
// pure scoring core. Guard G-020 (one entity per thing).
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, entry, ok } from "./helpers.ts";
import { findSimilarPairs } from "../src/entity-similar.ts";

type Any = any;

const similar = () => ok<Any[]>("GET", "/entities/similar?limit=500");
const pairOf = (pairs: Any[], x: string, y: string) =>
  pairs.find((p) => (p.a.name === x && p.b.name === y) || (p.a.name === y && p.b.name === x));
const involving = (pairs: Any[], name: string) => pairs.filter((p) => p.a.name === name || p.b.name === name);

test("Postgres / PostgreSQL pair by name, keeping the more-mentioned one", async () => {
  await entry({ title: "sim pg A", entities: [{ name: "Postgres", kind: "tech" }] });
  await entry({ title: "sim pg B", entities: [{ name: "Postgres", kind: "tech" }] });
  await entry({ title: "sim pg C", entities: [{ name: "PostgreSQL", kind: "tech" }] });
  const p = pairOf(await similar(), "Postgres", "PostgreSQL");
  assert.ok(p, "pair suggested");
  assert.ok(p.reasons.includes("contains"));
  assert.ok(p.reasons.includes("name"));
  assert.ok(p.a.id < p.b.id, "lower id first");
  const pg = p.a.name === "Postgres" ? p.a : p.b;
  const pgsql = p.a.name === "Postgres" ? p.b : p.a;
  assert.equal(pg.count, 2);
  assert.equal(pgsql.count, 1);
  assert.deepEqual(p.merge, { from: pgsql.id, into: pg.id }, "fewer mentions merge into more");
  assert.ok(p.score > 0.5 && p.score <= 1);
});

test("a short name does not pair with unrelated names, only with names it is a whole word of", async () => {
  await entry({ title: "sim short 1", entities: ["pg"] });
  await entry({ title: "sim short 2", entities: ["Upgrade Plan"] });
  await entry({ title: "sim short 3", entities: ["PgBouncer"] });
  await entry({ title: "sim short 4", entities: ["Paging"] });
  await entry({ title: "sim short 5", entities: ["pg dump"] });
  const pairs = involving(await similar(), "pg");
  assert.deepEqual(
    pairs.map((p) => (p.a.name === "pg" ? p.b.name : p.a.name)).sort(),
    ["PgBouncer", "pg dump"],
    "a word or leading camelCase part pairs; Upgrade Plan / Paging never pair",
  );
  for (const p of pairs) assert.deepEqual(p.reasons, ["contains"]);
});

test("entities that keep appearing together pair by co-occurrence", async () => {
  await entry({ title: "sim co 1", entities: ["Zephyr Gateway", "Quokka Auth"] });
  await entry({ title: "sim co 2", entities: ["Zephyr Gateway", "Quokka Auth"] });
  const p = pairOf(await similar(), "Zephyr Gateway", "Quokka Auth");
  assert.ok(p);
  assert.deepEqual(p.reasons, ["cooccur"]);
  // A single shared memory is not enough.
  await entry({ title: "sim co 3", entities: ["Marlin Queue", "Osprey Cache"] });
  assert.equal(pairOf(await similar(), "Marlin Queue", "Osprey Cache"), undefined);
});

test("an entity only deleted memories mention is ignored", async () => {
  await entry({ title: "sim del live", entities: ["Kafka Streams"] });
  const dead = await entry({ title: "sim del dead", entities: ["KafkaStream"] });
  assert.ok(pairOf(await similar(), "Kafka Streams", "KafkaStream"), "suggested while both are live");
  await ok("DELETE", `/entries/${dead.id}`);
  assert.equal(involving(await similar(), "KafkaStream").length, 0);
  await ok("POST", `/entries/${dead.id}/restore`);
  assert.ok(pairOf(await similar(), "Kafka Streams", "KafkaStream"), "back after restore");
});

test("a dismissed pair disappears and stays dismissed", async () => {
  await entry({ title: "sim dis 1", entities: ["Redis Cluster"] });
  await entry({ title: "sim dis 2", entities: ["Redis Clusters"] });
  const p = pairOf(await similar(), "Redis Cluster", "Redis Clusters");
  assert.ok(p);
  // Either order is accepted.
  assert.deepEqual(await ok("POST", "/entities/similar/dismiss", { a: p.b.id, b: p.a.id }), { ok: true });
  assert.equal(pairOf(await similar(), "Redis Cluster", "Redis Clusters"), undefined);
  await entry({ title: "sim dis 3", entities: ["Redis Cluster", "Redis Clusters"] });
  await entry({ title: "sim dis 4", entities: ["Redis Cluster", "Redis Clusters"] });
  assert.equal(pairOf(await similar(), "Redis Cluster", "Redis Clusters"), undefined, "new evidence does not bring it back");
  // Dismissing again is harmless.
  assert.deepEqual(await ok("POST", "/entities/similar/dismiss", { a: p.a.id, b: p.b.id }), { ok: true });
  assert.equal((await call("POST", "/entities/similar/dismiss", { a: p.a.id, b: 999999 })).status, 404);
  assert.equal((await call("POST", "/entities/similar/dismiss", { a: p.a.id, b: p.a.id })).status, 400);
});

test("after a merge the pair is gone", async () => {
  await entry({ title: "sim merge 1", entities: ["Elasticsearch"] });
  await entry({ title: "sim merge 2", entities: ["ElasticSearch Engine"] });
  const p = pairOf(await similar(), "Elasticsearch", "ElasticSearch Engine");
  assert.ok(p);
  await ok("POST", `/entities/${p.merge.from}/merge`, { into: p.merge.into });
  const after = await similar();
  assert.equal(involving(after, "ElasticSearch Engine").length, 0);
  assert.equal(pairOf(after, "Elasticsearch", "ElasticSearch Engine"), undefined);
});

test("/entities/similar is not shadowed by /entities/:id", async () => {
  const r = await call("GET", "/entities/similar");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data));
});

test("pure core: different kinds lower the score, ties keep the lower id, limit applies", () => {
  const ents = [
    { id: 1, name: "Postgres", kind: "tech", count: 3 },
    { id: 2, name: "PostgreSQL", kind: "tech", count: 3 },
    { id: 3, name: "Postgres", kind: "tech", count: 1 },
    { id: 4, name: "PostgreSQL", kind: "service", count: 1 },
  ];
  const pairs = findSimilarPairs(ents, new Map());
  const same = pairs.find((p) => p.a.id === 1 && p.b.id === 2)!;
  const diff = pairs.find((p) => p.a.id === 3 && p.b.id === 4)!;
  assert.ok(same && diff);
  assert.ok(diff.score < same.score, "different kinds score lower but are kept");
  assert.deepEqual(same.merge, { from: 2, into: 1 }, "tie keeps the lower id");
  assert.equal(findSimilarPairs(ents, new Map(), new Set(), 2).length, 2);
  assert.ok(!findSimilarPairs(ents, new Map(), new Set(["1:2"])).some((p) => p.a.id === 1 && p.b.id === 2));
});

test("pure core: a short name needs a word boundary, not just a shared prefix", () => {
  const names = ["pg", "pgx", "PgBouncer", "Go", "Gold", "google", "gopher", "ai", "airflow", "js", "jsx", "SQL", "PostgreSQL", "MySQL"];
  // Kinds alternate so the kind penalty applies to most pairs.
  const ents = names.map((name, i) => ({ id: i + 1, name, kind: i % 2 ? "tech" : "project", count: 1 }));
  const found = findSimilarPairs(ents, new Map(), new Set(), 500).map((p) => `${p.a.name}~${p.b.name}`);
  assert.deepEqual(found, ["pg~PgBouncer"], "only the camelCase word pairs, even across kinds");
});

test("pure core: blocking finds every pair the scoring would keep", () => {
  const names = [
    "pg", "pgx", "PgBouncer", "pg dump", "Go", "Gold", "go lang", "ai", "airflow", "js", "jsx", "Node.js", "NodeJS",
    "Postgres", "PostgreSQL", "postgres db", "Redis", "Redis Cluster", "k8s", "K8S", "쿠버네티스", "쿠버네티스 클러스터",
    "HTTPServer", "HTTP", "Elasticsearch", "ElasticSearch Engine", "upgrade", "Paging",
  ];
  // Huge mention counts make the co-occurrence term ~0, so a forced candidate scores on its name alone.
  const ents = names.map((name, i) => ({ id: i + 1, name, kind: i % 3 ? "tech" : "project", count: 1_000_000 }));
  const key = (p: Any) => `${p.a.id}:${p.b.id}`;
  const all = new Set(findSimilarPairs(ents, new Map(), new Set(), 10_000).map(key));
  // Brute force: make each pair a candidate through the co-occurrence path, bypassing the name index.
  const brute = new Set<string>();
  for (let i = 0; i < ents.length; i++)
    for (let j = i + 1; j < ents.length; j++)
      for (const p of findSimilarPairs([ents[i], ents[j]], new Map([[`${i + 1}:${j + 1}`, 2]]), new Set(), 10)) brute.add(key(p));
  assert.ok(brute.size > 5, "the fixture has real pairs");
  assert.deepEqual([...all].sort(), [...brute].sort());
});
