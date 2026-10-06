// Web UI pure logic, part 3: project merge dialog (web/src/project-merge.ts), its error texts
// (web/src/errors.ts) and source scans of the dialog wiring. No DOM or React involved.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { MergePreview, Project, SimilarProjectPair } from "../../web/src/api.ts";
import { ApiError, describeError } from "../../web/src/errors.ts";
import { mergeCandidates, mergeCountLines, mergeSummary, PROJECT_REASON_LABEL, rankMergeCandidates, similarPartners } from "../../web/src/project-merge.ts";

const webSrc = new URL("../../web/src/", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, webSrc), "utf8");

function preview(over: Partial<MergePreview> = {}): MergePreview {
  return {
    source: { id: 1, key: "local/old", name: "old" },
    target: { id: 2, key: "github.com/me/new", name: "new" },
    counts: { entries: 12, turns: 0, wiki_pages: 3, wiki_jobs: 0, review_jobs: 1, review_proposals_pending: 2, skills: 0 },
    wiki_conflicts: [{ slug: "setup", source_page_id: 10, target_page_id: 20, new_slug: "setup-old" }],
    skill_conflicts: [],
    policy: "target",
    description: "none",
    aliases: ["local/old", "local/older"],
    ...over,
  };
}

function project(id: number, name: string, key: string, last_seen_at: string | null): Project {
  return { id, name, key, last_seen_at, remote: null, description: "", created_at: "2026-01-01", updated_at: "2026-01-01" };
}

test("G-060: preview counts become Korean lines, zero counts left out", () => {
  assert.deepEqual(mergeCountLines(preview().counts), ["메모리 12개", "위키 페이지 3개", "점검 작업 1개", "대기 중인 점검 제안 2개"]);
  assert.deepEqual(mergeCountLines({ entries: 1234, turns: 0, wiki_pages: 0, wiki_jobs: 0, review_jobs: 0, review_proposals_pending: 0, skills: 0 }), ["메모리 1,234개"]);
  assert.deepEqual(mergeCountLines({ entries: 0, turns: 0, wiki_pages: 0, wiki_jobs: 0, review_jobs: 0, review_proposals_pending: 0, skills: 0 }), []);
});

test("G-060: wiki conflicts show old → new slug, aliases are listed as given", () => {
  const s = mergeSummary(preview());
  assert.deepEqual(s.renames, [{ from: "setup", to: "setup-old" }]);
  assert.deepEqual(s.aliases, ["local/old", "local/older"]);
  assert.deepEqual(mergeSummary(preview({ wiki_conflicts: [], aliases: [] })).renames, []);
});

test("G-060: every policy / description outcome has its own Korean sentence", () => {
  const policies = (["target", "source", "both", "none"] as const).map((policy) => mergeSummary(preview({ policy })).policy);
  assert.equal(new Set(policies).size, 4);
  assert.match(policies[0], /"new"의 정리 방침을 그대로/);
  assert.match(policies[1], /"new"에 정리 방침이 없어 "old"의 방침을 가져옵니다/);
  assert.match(policies[2], /"new"의 정리 방침을 두고, "old"의 방침을 그 아래에 덧붙입니다/);
  assert.match(policies[3], /모두 정리 방침이 없습니다/);
  const descs = (["target", "source", "none"] as const).map((description) => mergeSummary(preview({ description })).description);
  assert.equal(new Set(descs).size, 3);
  assert.match(descs[0], /"new"의 설명을 그대로/);
  assert.match(descs[1], /"old"의 설명을 가져옵니다/);
  assert.match(descs[2], /모두 설명이 없습니다/);
});

test("G-060: the target picker leaves out the source and filters by name or key", () => {
  const ps = [
    project(1, "old", "local/old", "2026-09-01"),
    project(2, "new", "github.com/me/new", "2026-10-01"),
    project(3, "Other", "github.com/me/other", null),
    project(4, "web", "github.com/me/web", "2026-09-15"),
  ];
  assert.deepEqual(mergeCandidates(ps, 1, "").map((p) => p.id), [2, 4, 3]);
  assert.deepEqual(mergeCandidates(ps, 1, "OTHER").map((p) => p.id), [3]);
  assert.deepEqual(mergeCandidates(ps, 1, "github.com/me/w").map((p) => p.id), [4]);
  assert.deepEqual(mergeCandidates(ps, 2, "old").map((p) => p.id), [1]);
  assert.deepEqual(mergeCandidates(ps, 1, "local/old"), []);
});

test("G-060: merge errors from the server are shown in Korean", () => {
  const cases: [number, string, RegExp][] = [
    [409, "a job is running for one of these projects — try again when it finishes", /작업이 진행 중입니다.*다시 시도하세요/],
    [400, "cannot merge a project into itself", /프로젝트를 자기 자신에 합칠 수 없습니다/],
    [400, "into is required", /합칠 대상 프로젝트/],
    [404, "project not found", /^프로젝트를 찾을 수 없습니다$/],
    [400, "a and b must be different projects", /서로 다른 두 프로젝트/],
    [400, "a and b must be project ids", /프로젝트 id가 올바르지 않습니다/],
  ];
  for (const [status, msg, want] of cases) {
    const d = describeError(new ApiError(status, msg));
    assert.equal(d.known, true, msg);
    assert.match(d.text, want, msg);
  }
  // The entity rule must not swallow the project text (or the other way round).
  assert.match(describeError(new ApiError(400, "cannot merge an entity into itself")).text, /엔티티/);
});

test("G-060: the merge dialog is irreversible-guarded (type the source name) and calls the contract routes", () => {
  const scope = read("pages/ScopePage.tsx");
  assert.match(scope, /"다른 프로젝트에 합치기…"/);
  // G-036: the confirm button stays disabled until the source project's name is typed.
  assert.match(scope, /const typedOk = typed\.trim\(\) === source\.name;/);
  assert.match(scope, /const canMerge = [^;]*typedOk[^;]*;/);
  assert.match(scope, /disabled=\{!canMerge\}/);
  assert.match(scope, /success: "합쳤습니다"/);
  assert.match(scope, /go\(`\/p\/\$\{r\.target\.id\}`\)/);
  assert.match(scope, /이전 주소: /);
  const api = read("api.ts");
  assert.match(api, /`\/projects\/\$\{id\}\/merge-preview\$\{qs\(\{ into \}\)\}`/);
  assert.match(api, /request<MergeResult>\("POST", `\/projects\/\$\{id\}\/merge`, \{ into \}\)/);
});

test("ADR-0030: suggested merge partners float to the top of the picker in suggestion order, the rest keep theirs", () => {
  const ps = [
    project(1, "old", "local/old", "2026-09-01"),
    project(2, "new", "github.com/me/new", "2026-10-01"),
    project(3, "Other", "github.com/me/other", null),
    project(4, "web", "github.com/me/web", "2026-09-15"),
    project(5, "old", "github.com/me/old", "2026-08-01"),
  ];
  const side = (p: Project) => ({ id: p.id, key: p.key, name: p.name, last_seen_at: p.last_seen_at, entry_count: 0 });
  const pair = (a: Project, b: Project, score: number, reasons: SimilarProjectPair["reasons"]): SimilarProjectPair => ({
    a: side(a), b: side(b), score, reasons, shared_entities: 0, merge: { from: a.id, into: b.id },
  });
  const pairs = [pair(ps[0], ps[2], 0.4, ["entities"]), pair(ps[0], ps[4], 0.9, ["local"]), pair(ps[1], ps[3], 0.6, ["folder"])];
  const partners = similarPartners(pairs, 1);
  assert.deepEqual([...partners.entries()], [[5, ["local"]], [3, ["entities"]]]);
  assert.deepEqual(rankMergeCandidates(mergeCandidates(ps, 1, ""), partners).map((p) => p.id), [5, 3, 2, 4]);
  assert.deepEqual(rankMergeCandidates(mergeCandidates(ps, 1, "web"), partners).map((p) => p.id), [4]);
  assert.deepEqual(rankMergeCandidates(mergeCandidates(ps, 1, ""), new Map()).map((p) => p.id), [2, 4, 5, 3]);
  assert.equal(PROJECT_REASON_LABEL.local, "origin 추가");
});

test("ADR-0030: the suggestion list opens the same typed-name merge dialog and calls the contract routes", () => {
  const other = read("pages/OtherPages.tsx");
  assert.match(other, /<ProjectMergeDialog source=\{merging\.source\} initialTarget=\{merging\.target\}/);
  assert.match(other, /api\.dismissSimilarProjects\(p\.a\.id, p\.b\.id\)/);
  const api = read("api.ts");
  assert.match(api, /`\/projects\/similar\$\{qs\(\{ limit \}\)\}`/);
  assert.match(api, /"POST", "\/projects\/similar\/dismiss", \{ a, b \}/);
});
