// Skill history, trash, lock and agent approval (ADR-0040, G-069): every write
// leaves a revision people can revert to; delete goes to the trash; a locked
// skill refuses the agent; with skillApproval an agent skill or edit waits for a
// person before any PC sees it.
import assert from "node:assert/strict";
import { after, test } from "node:test";

const { call, ok, project } = await import("./helpers.ts");

type Any = any;
const skill = (over: Record<string, unknown> = {}) => ({ name: "proc", description: "A procedure", body: "## Steps\n1. a", ...over });
const agent = (p: { key: string; name: string } | null, b: Record<string, unknown>) => call("POST", "/agent/skill", { ...b, project: p });
const ref = (p: { key: string; name: string }) => ({ key: p.key, name: p.name });
const syncNames = async (key: string) => {
  const r = await ok<Any>("GET", `/skills/sync?project=${encodeURIComponent(key)}`);
  return { global: r.global.map((s: Any) => s.name), project: (r.project?.skills ?? []).map((s: Any) => s.name), version: r.version as string };
};
const setApproval = (v: string) => ok<Any>("PUT", "/settings", { skillApproval: v });
/** Approve / reject what a person sees now (the versions on screen go along). */
const decide = async (id: number, what: "approve" | "reject") => {
  const s = await ok<Any>("GET", `/skills/${id}`);
  return call("POST", `/skills/${id}/${what}`, { updated_at: s.updated_at, draft_at: s.draft?.at });
};

after(async () => {
  await setApproval("global");
});

test("ADR-0040: every write leaves a revision; revert brings back a description and body", async () => {
  const s = await ok<Any>("POST", "/skills", skill({ name: "hist" }));
  await ok("PATCH", `/skills/${s.id}`, { body: "## Steps\n1. b" });
  const after1 = await ok<Any>("PATCH", `/skills/${s.id}`, { description: "Changed" });
  let revs = await ok<Any[]>("GET", `/skills/${s.id}/revisions`);
  assert.deepEqual(revs.map((r) => r.action), ["update", "update", "create"]);
  assert.equal(revs[2].body, "## Steps\n1. a");
  const back = await ok<Any>("POST", `/skills/${s.id}/revert`, { revision_id: revs[2].id });
  assert.equal(back.body, "## Steps\n1. a");
  assert.equal(back.description, "A procedure");
  assert.notEqual(back.updated_at, after1.updated_at);
  revs = await ok<Any[]>("GET", `/skills/${s.id}/revisions`);
  assert.equal(revs[0].action, "revert");
  assert.equal(revs[0].reason, `revision #${revs[3].id}`);
  assert.equal((await ok<Any>("POST", `/skills/${s.id}/revert`, { revision_id: revs[3].id })).updated_at, back.updated_at, "same content: no-op");
  assert.equal((await call("POST", `/skills/${s.id}/revert`, { revision_id: 999999 })).data.error, "revision not found");
});

test("ADR-0040: lock is people-only, not a content change, and refuses the agent (423)", async () => {
  const p = await project("github.com/test/sa-lock", "sa-lock");
  const s = await ok<Any>("POST", "/skills", skill({ name: "locked-one", project_id: p.id }));
  const l = await ok<Any>("PATCH", `/skills/${s.id}`, { locked: true });
  assert.equal(l.locked, true);
  assert.equal(l.updated_at, s.updated_at, "PCs are not told to sync for a lock");
  assert.equal((await ok<Any[]>("GET", `/skills/${s.id}/revisions`))[0].action, "lock");
  const r = await agent(ref(p), { action: "update", name: "locked-one", updated_at: s.updated_at, body: "x" });
  assert.equal(r.status, 423);
  assert.equal(r.data.error, 'skill "locked-one" is locked; only people can change it on the web');
  assert.equal((await agent(ref(p), { action: "view", name: "locked-one" })).data.skill.locked, true);
  assert.equal((await ok<Any>("PATCH", `/skills/${s.id}`, { body: "## by a person" })).body, "## by a person", "people still can");
  assert.equal((await call("PATCH", `/skills/${s.id}`, { locked: "yes" })).data.error, "locked must be true or false");
});

test("ADR-0040: the trash — leaves sync, frees the name, restores while the name is free, purges with its history", async () => {
  const p = await project("github.com/test/sa-trash", "sa-trash");
  const s = await ok<Any>("POST", "/skills", skill({ name: "binned", project_id: p.id }));
  const v1 = (await syncNames(p.key)).version;
  await ok("DELETE", `/skills/${s.id}`);
  assert.deepEqual((await syncNames(p.key)).project, []);
  assert.notEqual((await syncNames(p.key)).version, v1);
  assert.deepEqual((await ok<Any[]>("GET", `/skills?project_id=${p.id}`)).map((x) => x.name), []);
  assert.deepEqual((await ok<Any[]>("GET", `/skills?project_id=${p.id}&deleted=1`)).map((x) => x.id), [s.id]);
  assert.equal((await call("PATCH", `/skills/${s.id}`, { body: "x" })).data.error, "skill is in the trash; restore it first");
  // The name is free again; restoring then needs it back.
  const again = await ok<Any>("POST", "/skills", skill({ name: "binned", project_id: p.id }));
  assert.equal((await call("POST", `/skills/${s.id}/restore`)).data.error, 'a skill named "binned" already exists here');
  await ok("DELETE", `/skills/${again.id}`);
  const back = await ok<Any>("POST", `/skills/${s.id}/restore`);
  assert.equal(back.deleted_at, null);
  assert.deepEqual((await syncNames(p.key)).project, ["binned"]);
  assert.equal((await call("POST", `/skills/${s.id}/restore`)).data.error, "skill is not in the trash");
  assert.equal((await call("DELETE", `/skills/${s.id}/purge`)).data.error, "only skills in the trash can be purged");
  assert.deepEqual((await ok<Any[]>("GET", `/skills/${s.id}/revisions`)).map((r) => r.action), ["restore", "delete", "create"]);
  await ok("DELETE", `/skills/${again.id}/purge`);
  assert.equal((await call("GET", `/skills/${again.id}/revisions`)).status, 404, "history goes with it");
});

test("G-069: default approval 'global' — an agent's global skill is a candidate that no PC sees until approved; project skills go live", async () => {
  const p = await project("github.com/test/sa-appr", "sa-appr");
  const st = await ok<Any>("GET", "/settings");
  assert.deepEqual(st.skillApproval, { value: "global", source: "default" });
  const before = await syncNames(p.key);
  const made = await agent(ref(p), { action: "create", name: "agent-global", scope: "global", description: "d", body: "## b" });
  assert.equal(made.data.skill.status, "candidate");
  const now1 = await syncNames(p.key);
  assert.ok(!now1.global.includes("agent-global"), "not synced");
  assert.equal(now1.version, before.version, "PCs have nothing new");
  assert.ok((await ok<Any>("GET", "/stats")).skillsPending >= 1);
  const listed = (await agent(ref(p), { action: "list" })).data.skills.find((s: Any) => s.name === "agent-global");
  assert.equal(listed.status, "candidate", "the agent sees it, so it does not create it twice");
  // A candidate is still the agent's draft: it may keep editing it directly.
  const v = (await agent(ref(p), { action: "view", name: "agent-global" })).data.skill;
  const ed = await agent(ref(p), { action: "update", name: "agent-global", updated_at: v.updated_at, body: "## b2" });
  assert.equal(ed.data.proposed, undefined);
  assert.equal(ed.data.skill.body, "## b2");
  const id = (await ok<Any[]>("GET", "/skills?project_id=0")).find((s) => s.name === "agent-global").id;
  const ap = (await decide(id, "approve")).data;
  assert.equal(ap.status, "active");
  assert.ok((await syncNames(p.key)).global.includes("agent-global"));
  assert.equal((await decide(id, "approve")).data.error, "nothing to approve");
  // Project skills need no approval under "global".
  assert.equal((await agent(ref(p), { action: "create", name: "agent-proj", scope: "project", description: "d", body: "## b" })).data.skill.status, "active");
  // Rejecting a candidate puts it in the trash.
  await agent(ref(p), { action: "create", name: "agent-nope", scope: "global", description: "d", body: "## b" });
  const nope = (await ok<Any[]>("GET", "/skills?project_id=0")).find((s) => s.name === "agent-nope");
  assert.ok((await decide(nope.id, "reject")).data.deleted_at);
  assert.equal((await ok<Any[]>("GET", `/skills/${nope.id}/revisions`))[0].action, "reject");
});

test("G-069: an agent edit of an approved global skill waits as a draft; approve applies it, reject drops it", async () => {
  const p = await project("github.com/test/sa-draft", "sa-draft");
  const g = await ok<Any>("POST", "/skills", skill({ name: "human-global" }));
  const v0 = (await syncNames(p.key)).version;
  const r = await agent(ref(p), { action: "update", name: "human-global", updated_at: g.updated_at, body: "## agent idea" });
  assert.equal(r.data.proposed, true);
  assert.equal(r.data.changed, true);
  assert.equal(r.data.skill.body, g.body, "the approved content stays");
  assert.equal(r.data.skill.pending_edit.body, "## agent idea");
  assert.equal(r.data.version, r.data.previous_version);
  assert.equal((await syncNames(p.key)).version, v0, "nothing new for PCs");
  // Proposing the same again is a no-op; a newer proposal replaces the draft.
  assert.equal((await agent(ref(p), { action: "update", name: "human-global", updated_at: g.updated_at, body: "## agent idea" })).data.changed, false);
  await agent(ref(p), { action: "update", name: "human-global", updated_at: g.updated_at, body: "## agent idea 2" });
  const withDraft = await ok<Any>("GET", `/skills/${g.id}`);
  assert.equal(withDraft.draft.body, "## agent idea 2");
  const ap = (await decide(g.id, "approve")).data;
  assert.equal(ap.body, "## agent idea 2");
  assert.equal(ap.author, "agent");
  assert.equal(ap.draft, null);
  assert.notEqual((await syncNames(p.key)).version, v0);
  // Reject: the draft goes, the proposal stays in the history.
  await agent(ref(p), { action: "update", name: "human-global", updated_at: ap.updated_at, body: "## bad idea" });
  const rj = (await decide(g.id, "reject")).data;
  assert.equal(rj.draft, null);
  assert.equal(rj.body, "## agent idea 2");
  const revs = await ok<Any[]>("GET", `/skills/${g.id}/revisions`);
  assert.deepEqual(revs.slice(0, 2).map((x) => [x.action, x.body]), [["reject", "## bad idea"], ["propose", "## bad idea"]]);
  assert.equal((await decide(g.id, "reject")).data.error, "nothing to reject");
});

test("G-069: approval 'all' holds project skills too; 'off' lets the agent write straight through; bad values 400", async () => {
  const p = await project("github.com/test/sa-mode", "sa-mode");
  assert.deepEqual((await setApproval("all")).skillApproval, { value: "all", source: "file" });
  assert.equal((await agent(ref(p), { action: "create", name: "all-proj", scope: "project", description: "d", body: "## b" })).data.skill.status, "candidate");
  await setApproval("off");
  assert.equal((await agent(ref(p), { action: "create", name: "off-global", scope: "global", description: "d", body: "## b" })).data.skill.status, "active");
  const v = (await agent(ref(p), { action: "view", name: "off-global" })).data.skill;
  const up = await agent(ref(p), { action: "update", name: "off-global", updated_at: v.updated_at, body: "## direct" });
  assert.equal(up.data.proposed, undefined);
  assert.equal(up.data.skill.body, "## direct");
  assert.equal((await call("PUT", "/settings", { skillApproval: "sometimes" })).data.error, "skillApproval must be off, global or all");
  await setApproval("global");
});

test("G-069: approve and reject only what was reviewed — an agent change in between is 409, not approved unseen", async () => {
  const p = await project("github.com/test/sa-seen", "sa-seen");
  // A candidate the agent edits after the person opened it.
  const made = (await agent(ref(p), { action: "create", name: "seen-cand", scope: "global", description: "d", body: "## A" })).data.skill;
  const id = (await ok<Any[]>("GET", "/skills?project_id=0")).find((s) => s.name === "seen-cand").id;
  const onScreen = await ok<Any>("GET", `/skills/${id}`);
  await agent(ref(p), { action: "update", name: "seen-cand", updated_at: made.updated_at, body: "## B (unseen)" });
  const stale = await call("POST", `/skills/${id}/approve`, { updated_at: onScreen.updated_at });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /^skill "seen-cand" changed since you read it/);
  assert.equal((await ok<Any>("GET", `/skills/${id}`)).status, "candidate");
  assert.equal((await call("POST", `/skills/${id}/approve`, {})).data.error, "updated_at is required: send the version you reviewed");
  // A newer proposal replaces the one on screen.
  const g = await ok<Any>("POST", "/skills", skill({ name: "seen-draft" }));
  await agent(ref(p), { action: "update", name: "seen-draft", updated_at: g.updated_at, body: "## first idea" });
  const shown = await ok<Any>("GET", `/skills/${g.id}`);
  await new Promise((r) => setTimeout(r, 5));
  await agent(ref(p), { action: "update", name: "seen-draft", updated_at: g.updated_at, body: "## second idea (unseen)" });
  const r = await call("POST", `/skills/${g.id}/approve`, { updated_at: shown.updated_at, draft_at: shown.draft.at });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'the edit waiting for approval on "seen-draft" changed since you read it; view it again');
  assert.equal((await ok<Any>("GET", `/skills/${g.id}`)).body, g.body, "nothing applied");
});

test("G-069: a waiting agent edit is dropped when the skill changes (a person's edit or revert, or a direct agent write)", async () => {
  const p = await project("github.com/test/sa-drop", "sa-drop");
  const g = await ok<Any>("POST", "/skills", skill({ name: "drop-draft" }));
  await agent(ref(p), { action: "update", name: "drop-draft", updated_at: g.updated_at, body: "## stale idea" });
  const edited = await ok<Any>("PATCH", `/skills/${g.id}`, { description: "A person's newer description" });
  assert.equal(edited.draft, null, "approving it would have undone this edit");
  const revs = await ok<Any[]>("GET", `/skills/${g.id}/revisions`);
  assert.deepEqual([revs[0].action, revs[0].body, revs[0].reason], ["reject", "## stale idea", "edit waiting for approval dropped: the skill changed"]);
  // Revert drops it too.
  await agent(ref(p), { action: "update", name: "drop-draft", updated_at: edited.updated_at, body: "## another idea" });
  const first = revs.at(-1)!;
  assert.equal((await ok<Any>("POST", `/skills/${g.id}/revert`, { revision_id: first.id })).draft, null);
  // Approval switched off: the agent's next write goes straight in and the old draft goes.
  const cur = await ok<Any>("GET", `/skills/${g.id}`);
  await agent(ref(p), { action: "update", name: "drop-draft", updated_at: cur.updated_at, body: "## waiting" });
  await setApproval("off");
  const direct = await agent(ref(p), { action: "update", name: "drop-draft", updated_at: cur.updated_at, body: "## direct" });
  assert.equal(direct.data.skill.body, "## direct");
  assert.equal(direct.data.skill.pending_edit, null);
  await setApproval("global");
});
