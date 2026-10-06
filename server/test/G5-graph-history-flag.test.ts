// The graph API marks history (ADR-0047): a memory replaced by a "supersedes" link or past its
// valid_until is sent with active: false, so the web hides it unless "이력" is on; current
// memories are active: true.
import assert from "node:assert/strict";
import { test } from "node:test";
import { entry, ok } from "./helpers.ts";

type Any = any;

test("GET /graph: superseded and expired memories are active: false, current ones true", async () => {
  const old = await entry({ title: "Deploy uses docker run", body: "old way" });
  const next = await entry({ title: "Deploy uses docker compose", body: "new way" });
  const expired = await entry({ title: "Freeze until spring", body: "merge freeze", valid_until: "2020-01-01" } as Any);
  const now = await entry({ title: "Current fact", body: "still true" });
  await ok("POST", `/entries/${next.id}/links`, { to: old.id, type: "supersedes" });
  const g = await ok<Any>("GET", "/graph");
  const flag = (id: number) => g.nodes.find((n: Any) => n.type === "memory" && n.entryId === id)?.active;
  assert.equal(flag(old.id), false, "superseded");
  assert.equal(flag(expired.id), false, "expired");
  assert.equal(flag(next.id), true);
  assert.equal(flag(now.id), true);
});
