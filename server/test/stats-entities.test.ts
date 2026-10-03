// graphStats().entities counts entities with at least one live mention — the EXISTS
// form replaced a DISTINCT over every mention (slow /api/health on large DBs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, entry, ok } from "./helpers.ts";
import { graphStats } from "../src/graph.ts";

type Any = any;
const distinct = () =>
  Number((db.prepare(`SELECT COUNT(DISTINCT ee.entity_id) AS n FROM entry_entities ee JOIN entries e ON e.id = ee.entry_id WHERE e.deleted_at IS NULL`).get() as Any).n);

test("graph stats: entities = distinct entities of live memories (twice-mentioned once, trashed-only none)", async () => {
  await entry({ title: "stats a", body: "x", entities: [{ name: "StatsAlpha", kind: "tech" }, { name: "StatsBeta", kind: "tech" }] });
  await entry({ title: "stats b", body: "y", entities: [{ name: "StatsAlpha", kind: "tech" }] });
  const gone = await entry({ title: "stats c", body: "z", entities: [{ name: "StatsGamma", kind: "tech" }] });
  const before = graphStats().entities;
  assert.equal(before, distinct());
  await ok("DELETE", `/entries/${gone.id}`);
  assert.equal(graphStats().entities, distinct());
  assert.equal(graphStats().entities, before - 1, "an entity only a trashed memory mentions is not counted");
});
