// Recall's graph extras judged against the prompt (G-087, ADR-0051): per-entity extras
// prefer memories naming more of the prompt's entities, linked memories far below the
// prompt's mean meaning are not added, and memories close in meaning to a recalled one
// fill leftover slots only when they also stand out for the prompt. No prompt vector =
// keyword recall exactly as before.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

process.env.EMBED_BASE_URL = "http://embed.test/v1";
process.env.EMBED_MODEL = "fake-m3";
delete process.env.GRAPH_RECALL_EXTRA;

const { entry, ok } = await import("./helpers.ts");
const { embedReset } = await import("./embed-stub.ts");
const { config } = await import("../src/config.ts");
const emb = await import("../src/embeddings.ts");

type Any = any;
const context = (prompt: string) =>
  ok<Any>("POST", "/context", { project: null, prompt });
const link = (from: number, to: number, type: string) =>
  ok("POST", `/entries/${from}/links`, { to, type });
const viaOf = (recall: string, id: number) =>
  new RegExp(`^- \\[#${id}\\].*\\(graph: (.*)\\)$`, "m").exec(recall)?.[1] ??
  null;

// Recall only adds memories the stable block left out: keep that block empty here.
config.contextBudget = 1;
config.recallBudget = 20_000;

beforeEach(() => {
  embedReset();
  emb.resetQueryState();
});

async function keywordOnly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = config.embed.baseUrl;
  config.embed.baseUrl = "";
  try {
    return await fn();
  } finally {
    config.embed.baseUrl = saved;
  }
}

async function withGraph<T>(
  patch: Partial<typeof config.graph>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = { ...config.graph };
  Object.assign(config.graph, patch);
  try {
    return await fn();
  } finally {
    Object.assign(config.graph, saved);
  }
}

// Runs first: the z-scores need at least 30 compared memories with vectors.
test("setup: a corpus large enough for z-scores", async () => {
  for (let i = 0; i < 34; i++)
    await entry({ title: `filler ${i} pv`, body: `unrelated note pv${i}` });
  await emb.indexAll();
});

test("G-042: an entity's extras put memories naming more of the prompt's entities first, hubs included", async () => {
  // Gridhub is a hub (no extra slots of its own), but naming it still ranks a memory.
  for (let i = 0; i < 41; i++)
    await entry({
      title: `hub note ${i} gq`,
      body: `gq${i}`,
      entities: ["Gridhub"],
    });
  const both = await entry({
    title: "older note mentioning two",
    body: "first",
    entities: ["Ravenmq", "Gridhub"],
  });
  const newer: number[] = [];
  for (let i = 0; i < 3; i++)
    newer.push(
      (
        await entry({
          title: `newer note ${i} rq`,
          body: `rq${i}`,
          entities: ["Ravenmq"],
        })
      ).id,
    );
  const r = await keywordOnly(() => context("ravenmq 와 gridhub 문제 봐줘"));
  const ids = r.recalled as number[];
  assert.equal(
    ids[0],
    both.id,
    "the older memory naming both entities comes first",
  );
  assert.equal(viaOf(r.recall, both.id), "Ravenmq");
  assert.equal(ids.length, 3, "still 3 per entity, none for the hub (G-042)");
  assert.equal(
    ids.filter((id) => newer.includes(id)).length,
    2,
    "then two of the newer ones",
  );
});

test("G-087: a linked memory far below the prompt's mean meaning is not added; without a vector it is", async () => {
  const hit = await entry({
    title: "Kestrel deploy procedure",
    body: "deploy with docker compose",
  });
  const far = await entry({
    title: "Bird watching log",
    body: "날씨 is sunny, saw a heron",
  });
  const near = await entry({
    title: "Rollback note",
    body: "ship to production with the previous tag",
  });
  const newer = await entry({
    title: "Weather station notes",
    body: "날씨 log moved to a new sheet",
  });
  await link(hit.id, far.id, "depends_on");
  await link(hit.id, near.id, "because");
  await emb.indexAll();
  const prompt = "kestrel deploy steps";
  // Meaning alone never recalls here: the linked memories only come in over their links.
  const saved = config.embed.recallMinZ;
  config.embed.recallMinZ = 1000;
  try {
    await withGraph({ recallMinZ: -100, proximityMinZ: 0 }, async () => {
      const r = await context(prompt);
      assert.ok(r.recalled.includes(far.id), "floor off: the link is followed");
    });
    await withGraph({ recallMinZ: 1000, proximityMinZ: 0 }, async () => {
      const r = await context(prompt);
      assert.ok(r.recalled.includes(hit.id));
      assert.ok(!r.recalled.includes(far.id), "far below the floor: dropped");
      assert.ok(!r.recalled.includes(near.id), "every linked memory is judged");
      const kw = await keywordOnly(() => context(prompt));
      assert.ok(
        kw.recalled.includes(far.id) && kw.recalled.includes(near.id),
        "no prompt vector: no floor (G-063)",
      );
    });
    // A replacement is what the old memory says now: never judged.
    await link(newer.id, far.id, "supersedes");
    await withGraph({ recallMinZ: 1000, proximityMinZ: 0 }, async () => {
      const r = await context("bird watching heron");
      assert.ok(!r.recalled.includes(far.id), "superseded: history");
      assert.equal(viaOf(r.recall, newer.id), `replaces #${far.id}`);
    });
  } finally {
    config.embed.recallMinZ = saved;
  }
});

test("G-087: a memory close in meaning to a recalled one fills a slot only with a prompt vector and its own z", async () => {
  const hit = await entry({
    title: "Osprey deploy runbook",
    body: "deploy the osprey service",
  });
  const close = await entry({
    title: "Release checklist",
    body: "배포 전에 ship to production 순서를 확인",
  });
  const unrelated = await entry({
    title: "Timezone notes",
    body: "time zone of the office",
  });
  await emb.indexAll();
  const saved = { ...config.embed };
  try {
    // Meaning alone never recalls here: only the graph's proximity can bring `close` in.
    config.embed.recallMinZ = 1000;
    const prompt = "osprey deploy";
    const r = await context(prompt);
    assert.ok(r.recalled.includes(hit.id));
    assert.ok(
      r.recalled.includes(close.id),
      "close to the hit and related to the prompt",
    );
    assert.equal(viaOf(r.recall, close.id), `similar to #${hit.id}`);
    assert.ok(!r.recalled.includes(unrelated.id));
    assert.match(
      r.system,
      /"similar to #A"/,
      "the policy explains the marker (G-043)",
    );
    assert.ok(
      !(await keywordOnly(() => context(prompt))).recalled.includes(close.id),
      "no prompt vector: nothing by closeness",
    );
    await withGraph({ proximityMinZ: 0 }, async () => {
      assert.ok(
        !(await context(prompt)).recalled.includes(close.id),
        "0 = off",
      );
    });
    await withGraph({ proximityMinZ: 1000 }, async () => {
      assert.ok(
        !(await context(prompt)).recalled.includes(close.id),
        "close to the hit is not enough: the prompt must care too",
      );
    });
    await withGraph({ similarMin: 0.999 }, async () => {
      assert.ok(
        !(await context(prompt)).recalled.includes(close.id),
        "below GRAPH_SIMILAR_MIN: not close",
      );
    });
    await withGraph({ recallExtra: 0 }, async () => {
      assert.ok(
        !(await context(prompt)).recalled.includes(close.id),
        "GRAPH_RECALL_EXTRA still bounds it (G-018)",
      );
    });
  } finally {
    Object.assign(config.embed, saved);
  }
});

test("G-087: 'same time as' is off by default and still needs the prompt's z when on", async () => {
  assert.equal(config.graph.nearbyHours, 0);
  const hit = await entry({
    title: "Merlin office hours",
    body: "office opens at nine",
  });
  const sameDay = await entry({ title: "공지 메모", body: "시간대 변경 공지" });
  await emb.indexAll();
  const saved = { ...config.embed };
  try {
    config.embed.recallMinZ = 1000;
    const prompt = "merlin timezone";
    // similarMin above 1: only the time window can bring `sameDay` in.
    await withGraph({ similarMin: 2 }, async () => {
      assert.ok(
        !(await context(prompt)).recalled.includes(sameDay.id),
        "off by default",
      );
    });
    await withGraph({ nearbyHours: 24, similarMin: 2 }, async () => {
      const r = await context(prompt);
      // Written in the same test run as every recalled memory: any of them is "the same time".
      const via = viaOf(r.recall, sameDay.id) ?? "";
      assert.match(via, /^same time as #\d+$/);
      assert.ok(r.recalled.includes(Number(via.slice(via.indexOf("#") + 1))), "next to a recalled memory");
    });
    await withGraph(
      { nearbyHours: 24, similarMin: 2, proximityMinZ: 1000 },
      async () => {
        assert.ok(
          !(await context(prompt)).recalled.includes(sameDay.id),
          "written the same day is not enough",
        );
      },
    );
  } finally {
    Object.assign(config.embed, saved);
  }
});
