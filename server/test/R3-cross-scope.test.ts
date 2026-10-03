import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { CROSS_SCOPE_MAX, crossScopeBudget, crossScopeContext, scheduleDueReviews, versionOf } from "../src/review.ts";
import type { Entry } from "../src/db.ts";
import { getEntry, updateEntry } from "../src/store.ts";
import { call, db, entry, llmCalls, llmDefault, llmReply, llmReset, ok, project, runQueueOnce } from "./helpers.ts";

// Cross-scope review: a project review shows the most related global/user memories
// READ-ONLY, so a project copy of a global fact can be proposed away (delete/update
// with covered_by), while the global memories themselves are never proposed on.

type Any = any;
let pn = 0;
const freshProject = async () => {
  pn++;
  return project(`github.com/test/r3-cross-${pn}`, `r3-cross-${pn}`);
};
const REF_HEAD = "REFERENCE (";
/** The MEMORIES part and the REFERENCE part of a review prompt. */
const parts = (user: string) => {
  const at = user.indexOf(REF_HEAD);
  return { memories: at < 0 ? user : user.slice(0, at), refs: at < 0 ? "" : user.slice(at) };
};
const idsIn = (text: string) => [...text.matchAll(/\{"id":(\d+)/g)].map((m) => Number(m[1]));

async function runReview(pid: number | null, reply: unknown) {
  const job = await ok("POST", "/review", { project_id: pid });
  llmReply(reply);
  await runQueueOnce();
  const j = (await ok<Any[]>("GET", "/review/jobs?limit=100")).find((x) => x.id === job.id);
  const proposals = await ok<Any[]>("GET", `/review/proposals?job_id=${job.id}`);
  return { job: j, proposals, prompt: llmCalls.at(-1)!.user };
}

beforeEach(() => llmReset());

test("G-055: related global/user memories appear read-only; proposals on them are dropped with a reason", async () => {
  const p = await freshProject();
  const g = await entry({ scope: "global", title: "pnpm only", body: "Always use pnpm, never npm, in every repo.", entities: ["XsPnpmTool"] });
  const u = await entry({ scope: "user", title: "pnpm cache", body: "User keeps the pnpm store on /data.", entities: ["XsPnpmTool"] });
  const a = await entry({ project_id: p.id, title: "use pnpm here", body: "Use pnpm, never npm.", entities: ["XsPnpmTool"] });
  const b = await entry({ project_id: p.id, title: "pnpm workspace", body: "Workspaces live in packages/. Use pnpm, never npm.", entities: ["XsPnpmTool"] });
  const c = await entry({ project_id: p.id, title: "unrelated", body: "ports: 3000" });
  const gv = versionOf(g.id);
  const uv = versionOf(u.id);
  const { job, proposals, prompt } = await runReview(p.id, {
    proposals: [
      { kind: "update", ids: [g.id], title: "pnpm only (all repos)", reason: "clearer" },
      { kind: "delete", ids: [u.id], reason: "transient" },
      { kind: "merge", ids: [a.id, g.id], title: "pnpm", body: "Use pnpm.", reason: "same" },
      { kind: "conflict", ids: [b.id, u.id], note: "?", reason: "?" },
      { kind: "delete", ids: [a.id], covered_by: g.id, reason: "전역 메모리와 같은 내용" },
      { kind: "update", ids: [b.id], edits: [{ old: " Use pnpm, never npm.", new: "" }], covered_by: g.id, reason: "already in global #" + g.id },
      { kind: "delete", ids: [c.id], covered_by: 999_999, reason: "made up" },
    ],
  });
  const { memories, refs } = parts(prompt);
  assert.ok(refs, "the prompt has a REFERENCE section");
  assert.match(refs, /read-only/);
  assert.deepEqual(idsIn(refs).sort((x, y) => x - y), [g.id, u.id].sort((x, y) => x - y));
  assert.ok(!idsIn(memories).includes(g.id) && !idsIn(memories).includes(u.id), "never listed among the reviewed MEMORIES");
  assert.match(llmCalls.at(-1)!.system, /REFERENCE memories \(project reviews only\)/);

  const dropped = job.result.dropped as Any[];
  const why = (ids: number[]) => dropped.find((d) => JSON.stringify(d.ids) === JSON.stringify(ids))?.reason;
  assert.equal(why([g.id]), "cross_scope");
  assert.equal(why([u.id]), "cross_scope");
  assert.equal(why([a.id, g.id]), "mixed_scope");
  // A conflict that lists the REFERENCE memory in "ids" keeps it as the other side (covered_by), not a target.
  assert.equal(why([b.id, u.id]), undefined);
  const conf = proposals.find((x) => x.kind === "conflict")!;
  assert.deepEqual(conf.entry_ids, [b.id]);
  assert.equal(conf.data.covered_by, u.id);
  assert.equal(why([c.id]), "covered_by_not_shown");
  assert.equal(job.result.cross_scope, 2);
  // Global/user memories were not touched and nothing about them is pending.
  assert.equal(versionOf(g.id), gv);
  assert.equal(versionOf(u.id), uv);
  assert.ok(proposals.every((x) => !x.entry_ids.includes(g.id) && !x.entry_ids.includes(u.id)));

  const del = proposals.find((x) => x.kind === "delete")!;
  assert.deepEqual(del.entry_ids, [a.id]);
  assert.equal(del.data.covered_by, g.id);
  assert.equal(del.data.covered_snap, gv);
  assert.match(del.reason, new RegExp(`#${g.id}\\b`), "the reason cites the global memory");
  assert.equal(del.covered_by_entry.id, g.id);
  assert.equal(del.covered_by_entry.changed, false);
  const upd = proposals.find((x) => x.kind === "update")!;
  assert.equal(upd.data.covered_by, g.id);
  assert.equal(upd.reason.split(`#${g.id}`).length, 2, "an already cited id is not appended again");

  await ok("POST", `/review/proposals/${del.id}/apply`);
  assert.ok((await ok("GET", `/entries/${a.id}`)).entry.deleted_at, "the project copy is deleted");
  assert.equal((await ok("GET", `/entries/${g.id}`)).entry.deleted_at, null, "the global memory stays");
});

test("G-055: apply refuses (409 stale) when the cited global memory changed or vanished", async () => {
  const p = await freshProject();
  const g = await entry({ scope: "global", title: "tabs width", body: "Indent with 2 spaces.", entities: ["XsIndentRule"] });
  const a = await entry({ project_id: p.id, title: "indent", body: "Indent with 2 spaces.", entities: ["XsIndentRule"] });
  const b = await entry({ project_id: p.id, title: "indent 2", body: "2 spaces indent here too.", entities: ["XsIndentRule"] });
  const { proposals } = await runReview(p.id, {
    proposals: [
      { kind: "delete", ids: [a.id], covered_by: g.id, reason: "dup" },
      { kind: "delete", ids: [b.id], covered_by: g.id, reason: "dup" },
    ],
  });
  assert.equal(proposals.length, 2);
  await ok("PATCH", `/entries/${g.id}`, { body: "Indent with 4 spaces." });
  const listed = await ok<Any[]>("GET", `/review/proposals?job_id=${proposals[0].job_id}`);
  assert.equal(listed[0].covered_by_entry.changed, true, "the card can block apply");
  const r = await call("POST", `/review/proposals/${proposals[0].id}/apply`);
  assert.equal(r.status, 409);
  assert.equal((await ok("GET", `/entries/${a.id}`)).entry.deleted_at, null);
  await ok("DELETE", `/entries/${g.id}`);
  const r2 = await call("POST", `/review/proposals/${proposals[1].id}/apply`);
  assert.equal(r2.status, 409);
  const after = await ok<Any[]>("GET", `/review/proposals?job_id=${proposals[0].job_id}&status=stale`);
  assert.equal(after.length, 2);
});

test("G-055: keyword overlap finds a global memory without shared entities; expired, standing and unrelated ones are left out", async () => {
  const p = await freshProject();
  const kw = await entry({ scope: "global", title: "Zorblax deploy window", body: "Deploys only on Tuesdays." });
  const expired = await entry({ scope: "global", title: "Zorblax freeze", body: "No Zorblax deploys this week." });
  db.prepare(`UPDATE entries SET valid_until = '2020-01-01' WHERE id = ?`).run(expired.id);
  const standing = await entry({ scope: "global", category: "standing", title: "Zorblax standing rule", body: "Answer in Korean." });
  const other = await entry({ scope: "global", title: "Quuxfoo naming", body: "Use snake_case." });
  await entry({ project_id: p.id, title: "Zorblax deploy window", body: "Deploys only on Tuesdays here too." });
  await entry({ project_id: p.id, title: "build", body: "make build" });
  const { prompt } = await runReview(p.id, { proposals: [] });
  const ids = idsIn(parts(prompt).refs);
  assert.ok(ids.includes(kw.id));
  assert.ok(!ids.includes(expired.id), "expired: cannot justify deleting a project memory");
  assert.ok(!ids.includes(standing.id), "standing instructions are never shown to a review (G-002)");
  assert.ok(!ids.includes(other.id));
});

test("G-055: the context is capped; a global/user review gets none", async () => {
  const p = await freshProject();
  for (let i = 0; i < CROSS_SCOPE_MAX + 5; i++) await entry({ scope: "global", title: `cap fact ${i}`, body: `fact ${i}`, entities: ["XsCapEntity"] });
  await entry({ project_id: p.id, title: "cap a", body: "a", entities: ["XsCapEntity"] });
  await entry({ project_id: p.id, title: "cap b", body: "b", entities: ["XsCapEntity"] });
  const { job, prompt } = await runReview(p.id, { proposals: [] });
  const n = idsIn(parts(prompt).refs).length;
  assert.equal(n, CROSS_SCOPE_MAX);
  assert.equal(job.result.cross_scope, CROSS_SCOPE_MAX);

  const g = await runReview(null, { proposals: [] });
  assert.equal(parts(g.prompt).refs, "", "global/user review: no REFERENCE section");
  assert.equal(g.job.result.cross_scope, 0);
});

test("G-055: a scheduled project review (G-028) gets the same read-only context and still only proposes", async () => {
  const p = await freshProject();
  const g = await entry({ scope: "global", title: "lint rule", body: "Run eslint before commit.", entities: ["XsSchedLint"] });
  const a = await entry({ project_id: p.id, title: "lint here", body: "Run eslint before commit.", entities: ["XsSchedLint"] });
  await entry({ project_id: p.id, title: "lint config", body: "Config in eslint.config.js.", entities: ["XsSchedLint"] });
  llmDefault((c: { user: string }) =>
    c.user.includes(`r3-cross-${pn}`) ? { proposals: [{ kind: "delete", ids: [a.id], covered_by: g.id, reason: "dup" }] } : { proposals: [] },
  );
  const jobs = scheduleDueReviews(new Date(), 7).filter((j) => j.project_id === p.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.scheduled, true);
  await runQueueOnce();
  const call = llmCalls.find((c) => c.user.includes(`r3-cross-${pn}`))!;
  assert.ok(idsIn(parts(call.user).refs).includes(g.id));
  const proposals = await ok<Any[]>("GET", `/review/proposals?job_id=${jobs[0].id}`);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, "pending");
  assert.equal(proposals[0].data.covered_by, g.id);
  assert.equal((await ok("GET", `/entries/${a.id}`)).entry.deleted_at, null, "nothing applied by itself");
});

test("G-056: memories longer than the LLM is shown are recorded on the job result", async () => {
  const p = await freshProject();
  const long = await entry({ project_id: p.id, title: "long notes", body: "x".repeat(4100) });
  await entry({ project_id: p.id, title: "short", body: "y" });
  const { job } = await runReview(p.id, { proposals: [] });
  assert.deepEqual(job.result.truncated, [long.id]);
  assert.equal(job.result.truncated_count, 1);
});

test("G-055: two edit updates of one project memory fold into one proposal that keeps covered_by", async () => {
  const p = await freshProject();
  const g = await entry({ scope: "global", title: "commit style", body: "Commit messages in Korean.", entities: ["XsFoldCommit"] });
  const a = await entry({ project_id: p.id, title: "commits", body: "Commit messages in Korean.\nSquash before merge.\nSign commits.", entities: ["XsFoldCommit"] });
  await entry({ project_id: p.id, title: "other", body: "z", entities: ["XsFoldCommit"] });
  const { proposals } = await runReview(p.id, {
    proposals: [
      { kind: "update", ids: [a.id], edits: [{ old: "Commit messages in Korean.\n", new: "" }], covered_by: g.id, reason: "global" },
      { kind: "update", ids: [a.id], edits: [{ old: "Sign commits.", new: "Sign commits (GPG)." }], reason: "clarify" },
    ],
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].data.edits.length, 2);
  assert.equal(proposals[0].data.covered_by, g.id);
});

test("G-055: a covered_by delete of a truncated project memory is dropped (body_truncated); edits are still fine", async () => {
  const p = await freshProject();
  const g = await entry({ scope: "global", title: "deploy rule", body: "Deploy with make deploy.", entities: ["XsTruncDeploy"] });
  const long = await entry({ project_id: p.id, title: "deploy notes", body: "Deploy with make deploy.\n" + "project-only detail ".repeat(300), entities: ["XsTruncDeploy"] });
  const long2 = await entry({ project_id: p.id, title: "deploy notes 2", body: "Deploy with make deploy.\n" + "other detail ".repeat(400), entities: ["XsTruncDeploy"] });
  const { job, proposals } = await runReview(p.id, {
    proposals: [
      { kind: "delete", ids: [long.id], covered_by: g.id, reason: "already in global" },
      { kind: "update", ids: [long2.id], edits: [{ old: "Deploy with make deploy.\n", new: "" }], covered_by: g.id, reason: "already in global" },
    ],
  });
  assert.ok(job.result.truncated.includes(long.id));
  const d = (job.result.dropped as Any[]).find((x) => x.ids[0] === long.id);
  assert.equal(d?.reason, "body_truncated");
  assert.ok(!proposals.some((x) => x.kind === "delete"), "no delete built on a body the LLM did not fully see");
  const upd = proposals.find((x) => x.kind === "update");
  assert.equal(upd?.data.covered_by, g.id, "an exact edit of the seen part is still proposed");
});

test("G-055: covered_by naming a memory of the same batch, or in a review without REFERENCE, is ignored (plain proposal)", async () => {
  const p = await freshProject();
  const a = await entry({ project_id: p.id, title: "dup a", body: "Run tests with npm test." });
  const b = await entry({ project_id: p.id, title: "dup b", body: "Run tests with npm test. Also lint." });
  const { job, proposals } = await runReview(p.id, { proposals: [{ kind: "delete", ids: [a.id], covered_by: b.id, reason: "same as #" + b.id }] });
  assert.equal(job.result.dropped_count, 0);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].data.covered_by, undefined, "not a cross-scope proposal");
  assert.equal(proposals[0].covered_by_entry, undefined);

  const ga = await entry({ scope: "global", title: "XsNoRef a", body: "q1" });
  await entry({ scope: "global", title: "XsNoRef b", body: "q2" });
  const g = await runReview(null, { proposals: [{ kind: "delete", ids: [ga.id], covered_by: 424_242, reason: "dup" }] });
  const mine = g.proposals.filter((x) => x.entry_ids.includes(ga.id));
  assert.equal(mine.length, 1, "a global review has no REFERENCE: covered_by is ignored, not a reason to drop");
  assert.equal(mine[0].data.covered_by, undefined);
});

test("G-055: entity-linked global memories that are expired, superseded or standing never become REFERENCE", async () => {
  const p = await freshProject();
  const live = await entry({ scope: "global", title: "Qq live", body: "live fact", entities: ["XsEntInactive"] });
  const expired = await entry({ scope: "global", title: "Qq gone by date", body: "old fact", entities: ["XsEntInactive"] });
  db.prepare(`UPDATE entries SET valid_until = '2020-01-01' WHERE id = ?`).run(expired.id);
  const old = await entry({ scope: "global", title: "Qq replaced", body: "replaced fact", entities: ["XsEntInactive"] });
  const repl = await entry({ scope: "global", title: "Qq replacement", body: "new fact" });
  await ok("POST", `/entries/${repl.id}/links`, { to: old.id, type: "supersedes" });
  const standing = await entry({ scope: "global", category: "standing", title: "Qq standing", body: "always", entities: ["XsEntInactive"] });
  await entry({ project_id: p.id, title: "proj one", body: "p1", entities: ["XsEntInactive"] });
  await entry({ project_id: p.id, title: "proj two", body: "p2", entities: ["XsEntInactive"] });
  const { prompt } = await runReview(p.id, { proposals: [] });
  const ids = idsIn(parts(prompt).refs);
  assert.ok(ids.includes(live.id));
  assert.ok(!ids.includes(expired.id), "expired");
  assert.ok(!ids.includes(old.id), "superseded");
  assert.ok(!ids.includes(standing.id), "standing (G-002)");
});

test("G-055: the character budget skips a too-large candidate and keeps a smaller one after it", async () => {
  assert.equal(crossScopeBudget(4000), 1000);
  assert.equal(crossScopeBudget(1_000_000), 6000);
  const p = await freshProject();
  const small = await entry({ scope: "global", title: "Qb small", body: "s".repeat(20), entities: ["XsBudgetEnt"] });
  const big = await entry({ scope: "global", title: "Qb big", body: "b".repeat(500), entities: ["XsBudgetEnt"] });
  // big is newer: it ranks first (same shared-entity count) and does not fit.
  db.prepare(`UPDATE entries SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`).run(big.id);
  const a = await entry({ project_id: p.id, title: "Qb proj", body: "x", entities: ["XsBudgetEnt"] });
  const fmt = (e: Entry) => e.body;
  const out = crossScopeContext([getEntry(a.id)!], fmt, { chars: 100 });
  assert.deepEqual(out.map((e) => e.id), [small.id]);
  assert.ok(out.reduce((n, e) => n + fmt(e).length + 1, 0) <= 100);
  const all = crossScopeContext([getEntry(a.id)!], fmt, { chars: 10_000 });
  assert.deepEqual(all.map((e) => e.id), [big.id, small.id]);
});

test("G-055: a REFERENCE that changes during the call or is inactive drops the proposal; expiring after it blocks apply", async () => {
  const p = await freshProject();
  const g1 = await entry({ scope: "global", title: "Qc rule one", body: "Use tabs.", entities: ["XsChgEnt"] });
  const g2 = await entry({ scope: "global", title: "Qc rule two", body: "Use LF.", entities: ["XsChgEnt"] });
  const g3 = await entry({ scope: "global", title: "Qc rule three", body: "Use UTF-8.", entities: ["XsChgEnt"] });
  const a = await entry({ project_id: p.id, title: "Qc tabs", body: "Use tabs.", entities: ["XsChgEnt"] });
  const b = await entry({ project_id: p.id, title: "Qc lf", body: "Use LF.", entities: ["XsChgEnt"] });
  const c = await entry({ project_id: p.id, title: "Qc utf", body: "Use UTF-8.", entities: ["XsChgEnt"] });
  const job = await ok("POST", "/review", { project_id: p.id });
  llmReply(() => {
    updateEntry(g1.id, { body: "Use spaces." }, { author: "human" });
    db.prepare(`UPDATE entries SET valid_until = '2020-01-01' WHERE id = ?`).run(g2.id);
    return {
      proposals: [
        { kind: "delete", ids: [a.id], covered_by: g1.id, reason: "dup" },
        { kind: "delete", ids: [b.id], covered_by: g2.id, reason: "dup" },
        { kind: "delete", ids: [c.id], covered_by: g3.id, reason: "dup" },
      ],
    };
  });
  await runQueueOnce();
  const j = (await ok<Any[]>("GET", "/review/jobs?limit=100")).find((x) => x.id === job.id);
  const why = (id: number) => (j.result.dropped as Any[]).find((d) => d.ids[0] === id)?.reason;
  assert.equal(why(a.id), "changed_meanwhile");
  assert.equal(why(b.id), "covered_by_inactive");
  const proposals = await ok<Any[]>("GET", `/review/proposals?job_id=${job.id}`);
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].entry_ids, [c.id]);
  // Expiry writes no revision: apply must still notice it.
  db.prepare(`UPDATE entries SET valid_until = '2020-01-01' WHERE id = ?`).run(g3.id);
  const listed = await ok<Any[]>("GET", `/review/proposals?job_id=${job.id}`);
  assert.equal(listed[0].covered_by_entry.changed, true);
  const r = await call("POST", `/review/proposals/${proposals[0].id}/apply`);
  assert.equal(r.status, 409);
  assert.equal((await ok("GET", `/entries/${c.id}`)).entry.deleted_at, null);
});

test("G-055: a conflict with a REFERENCE memory is kept; a reason citing it fills covered_by; whitespace-only edits are no change", async () => {
  const p = await freshProject();
  const g = await entry({ scope: "global", title: "commit language", body: "Commit messages are written in Korean in every repo.", entities: ["XsCommitLang"] });
  const en = await entry({ project_id: p.id, title: "commit language here", body: "Commit messages in this repo are in English (open source).", entities: ["XsCommitLang"] });
  const dup = await entry({ project_id: p.id, title: "korean commits", body: "Commit messages are written in Korean.", entities: ["XsCommitLang"] });
  const sp = await entry({ project_id: p.id, title: "release steps", body: "1. tag\n2. push", entities: ["XsCommitLang"] });
  const gv = versionOf(g.id);
  const { job, proposals } = await runReview(p.id, {
    proposals: [
      { kind: "conflict", ids: [en.id], covered_by: g.id, note: "English here vs Korean globally", reason: "contradicts global #" + g.id },
      { kind: "delete", ids: [dup.id], reason: "이미 전역 메모리 #" + g.id + "에 있음" },
      { kind: "update", ids: [sp.id], edits: [{ old: "1. tag", new: "1.  tag" }], reason: "spacing" },
    ],
  });
  const conf = proposals.find((x) => x.kind === "conflict")!;
  assert.deepEqual(conf.entry_ids, [en.id]);
  assert.equal(conf.data.covered_by, g.id);
  assert.equal(conf.data.covered_snap, gv);
  const del = proposals.find((x) => x.kind === "delete")!;
  assert.equal(del.data.covered_by, g.id, "covered_by taken from the reason");
  const dropped = job.result.dropped as Any[];
  assert.equal(dropped.find((d) => JSON.stringify(d.ids) === JSON.stringify([sp.id]))?.reason, "no_change");
  // The cited memory changes → both proposals are stale on apply.
  updateEntry(g.id, { body: "Commit messages are written in Korean (changed)." }, { author: "human" });
  assert.equal((await call("POST", `/review/proposals/${del.id}/apply`)).status, 409);
  assert.equal((await call("POST", `/review/proposals/${conf.id}/apply`)).status, 409);
  assert.equal((await ok("GET", `/entries/${dup.id}`)).entry.deleted_at, null);
});
