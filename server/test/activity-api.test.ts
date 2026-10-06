// The API behind the pi extension's activity cards: /context names the recalled
// memories (recalledEntries, same order as `recalled`), and GET /turns/:id/status is
// the light poll (status + result, never the turn's messages).
import assert from "node:assert/strict";
import { test } from "node:test";

// A small block budget keeps the long memory out of the system block: it can only be recalled.
process.env.CONTEXT_BUDGET_CHARS = "400";
const { call, entry, llmReply, ok, runQueueOnce, turn } = await import("./helpers.ts");

test("/context: recalledEntries gives id and title for each recalled memory", async () => {
  const a = await entry({ title: "Deploy uses blue-green pools", body: ".".repeat(500) });
  await entry({ title: "Unrelated note about lunch", body: "sandwiches" });
  const r = await ok<{ recalled: number[]; recalledEntries: { id: number; title: string }[] }>("POST", "/context", { project: null, prompt: "how does deploy blue-green work?" });
  assert.ok(r.recalled.includes(a.id));
  assert.deepEqual(r.recalledEntries.map((e) => e.id), r.recalled);
  assert.equal(r.recalledEntries.find((e) => e.id === a.id)?.title, "Deploy uses blue-green pools");
  // An empty prompt recalls nothing.
  const none = await ok<{ recalledEntries: unknown[] }>("POST", "/context", { project: null, prompt: "" });
  assert.deepEqual(none.recalledEntries, []);
});

test("GET /turns/:id/status: pending, then done with the applied ops; no messages; 404 for a missing turn", async () => {
  const t = await turn([
    { role: "user", text: "remember that the staging DB is on port 5433" },
    { role: "assistant", text: "noted" },
  ]);
  const before = await ok<Record<string, unknown>>("GET", `/turns/${t.id}/status`);
  assert.deepEqual(before, { id: t.id, status: "pending", error: null, result: null });
  llmReply({ ops: [{ op: "add", scope: "global", category: "fact", title: "Staging DB port is 5433", body: "staging Postgres listens on 5433" }] });
  await runQueueOnce();
  const after = await ok<{ status: string; result: { applied: { op: string; title: string }[] }; payload?: unknown }>("GET", `/turns/${t.id}/status`);
  assert.equal(after.status, "done");
  assert.deepEqual(after.result.applied.map((a) => [a.op, a.title]), [["add", "Staging DB port is 5433"]]);
  assert.equal(after.payload, undefined);
  assert.equal((await call("GET", "/turns/999999/status")).status, 404);
});
