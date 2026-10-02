import assert from "node:assert/strict";
import { test } from "node:test";
import { call, entry, llmCalls, llmReply, ok, project, runQueueOnce, turn } from "./helpers.ts";

test("health answers and reports the fake LLM model", async () => {
  const r = await call("GET", "/health");
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.llm, "test-model");
});

test("a curated turn adds a memory through the fake LLM", async () => {
  const p = await project();
  await entry({ title: "existing global fact" });
  llmReply({ ops: [{ op: "add", scope: "project", category: "fact", title: "uses PostgreSQL", body: "pool max 20", entities: [{ name: "PostgreSQL", kind: "tech" }] }], note: "ok" });
  const t = await turn([{ role: "user", text: "we use PostgreSQL with pool max 20, remember it" }, { role: "assistant", text: "noted" }], p);
  await runQueueOnce();
  assert.equal(llmCalls.length, 1);
  const done = await ok("GET", `/turns/${t.id}`);
  assert.equal(done.status, "done");
  const list = await ok<any[]>("GET", `/entries?project_id=${p.id}`);
  assert.equal(list[0].title, "uses PostgreSQL");
});
