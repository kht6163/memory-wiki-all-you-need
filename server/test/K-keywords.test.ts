import assert from "node:assert/strict";
import { test } from "node:test";
import { createEntry, listRevisions, normalizeKeywords, revertEntry, updateEntry } from "../src/store.ts";
import { searchEntries } from "../src/search.ts";
import { keywordRedundant, textWordSet } from "../src/words.ts";
import { applyMemoryOps } from "../src/worker.ts";

// Search keywords that only repeat words of the title/body add nothing to
// search; machine-written ones are dropped at write time.

test("G-051: redundancy uses the search word split (whole words, edge punctuation trimmed)", () => {
  const words = textWordSet("Cluster runs on k8s/", "DB is PostgreSQL 16, see docs.");
  assert.equal(keywordRedundant("k8s", words), true, "k8s/ and k8s are the same search word");
  assert.equal(keywordRedundant("K8S", words), true, "case-insensitive");
  assert.equal(keywordRedundant("Postgres", words), false, "a prefix of a word is a different word");
  assert.equal(keywordRedundant("postgresql docs", words), true, "every word present");
  assert.equal(keywordRedundant("postgresql backup", words), false, "one new word keeps it");
  assert.equal(keywordRedundant("the", words), false, "no search words (stopword) — kept");
  assert.equal(keywordRedundant("포스트그레스", words), false);
  assert.deepEqual(normalizeKeywords(["k8s", "Postgres", "cluster", "kubernetes"], ["Cluster runs on k8s/", ""]), ["Postgres", "kubernetes"]);
  assert.deepEqual(normalizeKeywords(["k8s", "Postgres"]), ["k8s", "Postgres"], "no text, no filtering");
});

test("G-051: redundant keywords do not take the 16 slots", () => {
  const dup = Array.from({ length: 16 }, (_, i) => `word${i}`);
  const fresh = Array.from({ length: 4 }, (_, i) => `alias${i}`);
  const kept = normalizeKeywords([...dup, ...fresh], [dup.join(" "), ""]);
  assert.deepEqual(kept, fresh);
});

test("G-051: llm and agent writes drop keywords already in title/body; human writes keep them", () => {
  const input = { scope: "global" as const, title: "PostgreSQL 16 on k8s", body: "Runs in the db namespace.", keywords: ["PostgreSQL", "namespace", "Postgres", "포스트그레스", "k8s"] };
  for (const author of ["llm", "agent"] as const) {
    const e = createEntry({ ...input, title: `${input.title} ${author}` }, { author });
    assert.deepEqual(e.keywords, ["Postgres", "포스트그레스"], author);
  }
  const h = createEntry({ ...input, title: `${input.title} human` }, { author: "human" });
  assert.deepEqual(h.keywords, input.keywords, "human keywords are kept as written");
});

test("G-051: update filters against the new title/body, and a later body edit never drops stored keywords", () => {
  const e = createEntry({ scope: "global", title: "deploy target", body: "compose stack", keywords: ["kubernetes", "배포"] }, { author: "human" });
  // An LLM body edit that now contains a stored keyword leaves the stored list alone.
  const a = updateEntry(e.id, { body: "compose stack, later kubernetes" }, { author: "llm" });
  assert.deepEqual(a.keywords, ["kubernetes", "배포"]);
  // An LLM write that sets keywords is filtered against the title/body of that same write.
  const b = updateEntry(e.id, { body: "helm chart on the cluster", keywords: ["kubernetes", "helm", "chart", "클러스터"] }, { author: "llm" });
  assert.deepEqual(b.keywords, ["kubernetes", "클러스터"]);
  // A human PATCH keeps explicit keywords even when they repeat the body.
  const c = updateEntry(e.id, { keywords: ["helm", "kubernetes"] }, { author: "human" });
  assert.deepEqual(c.keywords, ["helm", "kubernetes"]);
});

test("G-051: curation op keeps only bridging keywords and the memory stays findable by them", () => {
  const { applied } = applyMemoryOps(
    [{ op: "add", scope: "global", title: "Cache layer uses Redis", body: "TTL 300s for sessions", keywords: ["Redis", "sessions", "레디스", "캐시"] }],
    null,
    new Set(),
    { author: "llm", origin: "turn" },
    "test",
  ) as any;
  assert.equal(applied.length, 1);
  const hits = searchEntries("레디스 캐시", { allProjects: true });
  const hit = hits.find((h) => h.entry.id === applied[0].entryId);
  assert.ok(hit, "found through a kept keyword");
  assert.deepEqual(hit.entry.keywords, ["레디스", "캐시"]);
  assert.ok(searchEntries("redis", { allProjects: true }).some((h) => h.entry.id === applied[0].entryId), "dropped keyword is still found via title");
});

test("G-051: an llm update resending stored keywords keeps a human keyword that repeats the text", () => {
  const e = createEntry({ scope: "global", title: "helm deploy", body: "uses helm chart", keywords: ["helm", "헬름"] }, { author: "human" });
  // Same list resent with a title fix.
  const a = updateEntry(e.id, { title: "helm deploy (prod)", keywords: ["helm", "헬름"] }, { author: "llm" });
  assert.deepEqual(a.keywords, ["helm", "헬름"]);
  // Stored list plus new words: only the new words are filtered (case-insensitive match on stored ones).
  const b = updateEntry(e.id, { keywords: ["HELM", "헬름", "chart", "클러스터"] }, { author: "llm" });
  assert.deepEqual(b.keywords, ["HELM", "헬름", "클러스터"]);
  assert.deepEqual(normalizeKeywords(["k8s", "cluster"], ["cluster on k8s", ""], ["K8S"]), ["k8s"]);
});

test("G-051: a human revert restores keywords that repeat the text exactly", () => {
  const original = ["helm", "chart", "헬름"];
  const e = createEntry({ scope: "global", title: "helm deploy revert", body: "uses helm chart", keywords: original }, { author: "human" });
  updateEntry(e.id, { keywords: ["다른키워드"] }, { author: "human" });
  const rev = listRevisions(e.id).find((r) => JSON.stringify(r.keywords) === JSON.stringify(original));
  assert.ok(rev, "a revision holds the original keywords");
  const r = revertEntry(e.id, rev.id, { author: "human" });
  assert.deepEqual(r.keywords, original);
});
