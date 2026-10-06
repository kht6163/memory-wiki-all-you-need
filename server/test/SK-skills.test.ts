// Skills on the server (ADR-0039): written from the web, one name per scope,
// pi's name/description rules, no secrets; GET /api/skills/sync is what each PC
// mirrors and never creates anything (G-068); projects carry their skills
// through delete and merge.
import assert from "node:assert/strict";
import { test } from "node:test";

const { call, db, ok, project } = await import("./helpers.ts");

type Any = any;
const skill = (over: Record<string, unknown> = {}) => ({ name: "deploy-release", description: "Release a new version", body: "## Steps\n1. back up", ...over });
const projectCount = () => Number(db.prepare(`SELECT COUNT(*) AS n FROM projects`).get()!.n);

test("ADR-0039: create, read, list per scope, update, delete", async () => {
  const p = await project("github.com/test/sk-crud", "sk-crud");
  const g = await ok<Any>("POST", "/skills", skill({ project_id: null }));
  assert.equal(g.project_id, null);
  assert.equal(g.author, "human");
  const own = await ok<Any>("POST", "/skills", skill({ project_id: p.id, description: "Deploy  this\n app " }));
  assert.equal(own.description, "Deploy this app", "one line");
  assert.deepEqual((await ok<Any[]>("GET", "/skills?project_id=0")).map((s) => s.id), [g.id]);
  assert.deepEqual((await ok<Any[]>("GET", `/skills?project_id=${p.id}`)).map((s) => s.id), [own.id]);
  assert.equal((await ok<Any>("GET", `/skills/${own.id}`)).name, "deploy-release");

  const same = await ok<Any>("PATCH", `/skills/${own.id}`, { body: own.body });
  assert.equal(same.updated_at, own.updated_at, "no change → untouched");
  const up = await ok<Any>("PATCH", `/skills/${own.id}`, { name: "ship-it", body: "## New" });
  assert.equal(up.name, "ship-it");
  assert.equal(up.description, "Deploy this app");
  assert.equal(up.project_id, p.id, "scope never changes");

  assert.equal((await ok<Any>("DELETE", `/skills/${own.id}`)).id, own.id);
  assert.ok((await ok<Any>("GET", `/skills/${own.id}`)).deleted_at, "to the trash (ADR-0040)");
  assert.equal((await call("DELETE", `/skills/${own.id}`)).data.error, "skill is already in the trash");
  assert.equal((await call("GET", "/skills/999999")).data.error, "skill not found");
  const st = await ok<Any>("GET", "/stats");
  assert.ok(st.skills >= 1);
  assert.equal(st.globalSkills, Number(db.prepare(`SELECT COUNT(*) AS n FROM skills WHERE project_id IS NULL`).get()!.n));
});

test("ADR-0039: pi's rules — name, description and body are checked; secrets 422; one name per scope", async () => {
  const p = await project("github.com/test/sk-rules", "sk-rules");
  const err = async (body: unknown, status = 400) => {
    const r = await call("POST", "/skills", body);
    assert.equal(r.status, status, JSON.stringify(body));
    return r.data.error as string;
  };
  for (const name of ["Deploy", "a--b", "-a", "a-", "with space", "한글", "a".repeat(65), ""]) {
    assert.match(await err(skill({ name })), /^skill name must be lowercase letters, digits and single hyphens \(max 64\)$/, name);
  }
  assert.equal(await err(skill({ description: "  " })), "skill description is required");
  assert.equal(await err(skill({ description: "x".repeat(1025) })), "skill description is too long (max 1024 characters)");
  assert.equal(await err(skill({ body: "" })), "skill body is required");
  assert.equal(await err(skill({ body: "x".repeat(50_001) })), "skill body is too long (max 50000 characters)");
  assert.match(await err(skill({ body: "token sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" }), 422), /secrets/);
  assert.equal(await err(skill({ project_id: "x" })), "project_id must be a project id or null");
  assert.equal(await err(skill({ project_id: 999999 }), 404), "project not found");
  assert.equal(await err(null), "invalid JSON body");
  assert.equal(await err([]), "invalid JSON body");

  await ok("POST", "/skills", skill({ name: "dup", project_id: p.id }));
  assert.equal(await err(skill({ name: "dup", project_id: p.id }), 409), 'a skill named "dup" already exists here');
  await ok("POST", "/skills", skill({ name: "dup" })); // the same name in another scope is fine
  const other = await ok<Any>("POST", "/skills", skill({ name: "dup-2", project_id: p.id }));
  assert.equal((await call("PATCH", `/skills/${other.id}`, { name: "dup" })).status, 409);
  assert.equal((await call("PATCH", `/skills/${other.id}`, null)).status, 400);
});

test("G-068: GET /api/skills/sync returns global + the project's skills, resolves merged keys, and never creates a project", async () => {
  const p = await project("github.com/test/sk-sync", "sk-sync");
  await ok("POST", "/skills", skill({ name: "sync-global" }));
  await ok("POST", "/skills", skill({ name: "sync-own", project_id: p.id }));
  const r = await ok<Any>("GET", `/skills/sync?project=${encodeURIComponent(p.key)}`);
  assert.ok(r.global.some((s: Any) => s.name === "sync-global"));
  assert.equal(r.project.key, p.key);
  assert.deepEqual(Object.keys(r.project.skills[0]).sort(), ["body", "description", "name", "updated_at"]);
  assert.deepEqual(r.project.skills.map((s: Any) => s.name), ["sync-own"]);

  const before = projectCount();
  const unknown = await ok<Any>("GET", `/skills/sync?project=${encodeURIComponent("github.com/test/never-seen")}`);
  assert.equal(unknown.project, null);
  assert.ok(Array.isArray(unknown.global));
  assert.equal(projectCount(), before, "a GET from pi start never creates a project");
  assert.equal((await ok<Any>("GET", "/skills/sync")).project, null);
});

test("ADR-0039: deleting a project deletes its skills (global ones stay)", async () => {
  const p = await project("github.com/test/sk-del", "sk-del");
  const own = await ok<Any>("POST", "/skills", skill({ name: "gone-with-project", project_id: p.id }));
  const g = await ok<Any>("POST", "/skills", skill({ name: "stays-global" }));
  await ok("DELETE", `/projects/${p.id}`);
  assert.equal((await call("GET", `/skills/${own.id}`)).status, 404);
  assert.equal((await call("GET", `/skills/${g.id}`)).status, 200);
});

test("ADR-0039: a project merge moves skills; a name the target (or a global skill) already uses is renamed name-N", async () => {
  const src = await project("github.com/test/sk-src", "sk-src");
  const dst = await project("github.com/test/sk-dst", "sk-dst");
  const a = await ok<Any>("POST", "/skills", skill({ name: "shared", project_id: src.id }));
  const b = await ok<Any>("POST", "/skills", skill({ name: "only-src", project_id: src.id }));
  await ok("POST", "/skills", skill({ name: "shared", project_id: dst.id }));
  await ok("POST", "/skills", skill({ name: "shared-2", project_id: dst.id }));
  await ok("POST", "/skills", skill({ name: "shared-3" })); // global: a project "shared-3" would hide it in dst
  const pv = await ok<Any>("GET", `/projects/${src.id}/merge-preview?into=${dst.id}`);
  assert.equal(pv.counts.skills, 2);
  assert.deepEqual(pv.skill_conflicts, [{ name: "shared", source_skill_id: a.id, new_name: "shared-4" }]);
  const res = await ok<Any>("POST", `/projects/${src.id}/merge`, { into: dst.id });
  assert.equal(res.moved.skills, 2);
  const names = (await ok<Any[]>("GET", `/skills?project_id=${dst.id}`)).map((s) => s.name).sort();
  assert.deepEqual(names, ["only-src", "shared", "shared-2", "shared-4"]);
  assert.equal((await ok<Any>("GET", `/skills/${b.id}`)).project_id, dst.id);
  // The old key still finds the merged project's skills.
  const r = await ok<Any>("GET", `/skills/sync?project=${encodeURIComponent(src.key)}`);
  assert.equal(r.project.key, dst.key);
  assert.equal(r.project.skills.length, 4);
});

const agent = (p: { key: string; name: string } | null, b: Record<string, unknown>) => call("POST", "/agent/skill", { ...b, project: p });

test("ADR-0039: skill_manage — the agent lists, views, creates (scope required) and updates; author is the last writer", async () => {
  const p = await project("github.com/test/sk-agent", "sk-agent");
  const ref = { key: p.key, name: p.name };
  assert.equal((await agent(ref, { action: "create", name: "agent-proc", description: "d", body: "b" })).data.error, 'scope is required to create a skill: "global" or "project"');
  const made = await agent(ref, { action: "create", name: "agent-proc", scope: "project", description: "Run the agent proc", body: "## Procedure\n1. x" });
  assert.equal(made.status, 201);
  assert.equal(made.data.skill.scope, "project");
  assert.equal(made.data.skill.author, "agent");
  assert.match(made.data.version, /^[0-9a-f]{12}$/);
  await ok("POST", "/skills", skill({ name: "agent-proc" })); // a global one with the same name
  const list = (await agent(ref, { action: "list" })).data.skills;
  assert.deepEqual(
    list.filter((s: Any) => s.name === "agent-proc").map((s: Any) => s.scope),
    ["project", "global"],
  );
  assert.equal(list[0].body, undefined, "list has no bodies");
  // view picks this project's skill first, or the one asked for.
  const v = (await agent(ref, { action: "view", name: "agent-proc" })).data.skill;
  assert.equal(v.scope, "project");
  assert.equal(v.body, "## Procedure\n1. x");
  assert.equal((await agent(ref, { action: "view", name: "agent-proc", scope: "global" })).data.skill.scope, "global");

  const up = await agent(ref, { action: "update", name: "agent-proc", body: "## Procedure\n1. y", updated_at: v.updated_at });
  assert.equal(up.status, 200);
  assert.equal(up.data.skill.body, "## Procedure\n1. y");
  assert.equal(up.data.skill.description, "Run the agent proc", "what is not sent stays");
  assert.equal(up.data.changed, true);
  assert.notEqual(up.data.previous_version, up.data.version, "versions before and after the write");
  const same = await agent(ref, { action: "update", name: "agent-proc", body: "## Procedure\n1. y", updated_at: up.data.skill.updated_at });
  assert.equal(same.data.changed, false, "nothing to change → reported as such");
  assert.equal(same.data.version, same.data.previous_version);
  // A person's edit on the web makes the author human again.
  const row = (await ok<Any[]>("GET", `/skills?project_id=${p.id}`))[0];
  assert.equal(row.author, "agent");
  assert.equal((await ok<Any>("PATCH", `/skills/${row.id}`, { body: "## by hand" })).author, "human");
});

test("ADR-0039: skill_manage never deletes, never overwrites an unseen edit, and keeps pi's rules", async () => {
  const p = await project("github.com/test/sk-agent2", "sk-agent2");
  const ref = { key: p.key, name: p.name };
  const err = async (b: Record<string, unknown>, status: number, r = ref as typeof ref | null) => {
    const res = await agent(r, b);
    assert.equal(res.status, status, JSON.stringify(b));
    return res.data.error as string;
  };
  const made = (await agent(ref, { action: "create", name: "guarded", scope: "project", description: "d", body: "b" })).data.skill;
  assert.match(await err({ action: "delete", name: "guarded" }, 400), /^action must be list, view, create or update/);
  assert.match(await err({ action: "update", name: "guarded", body: "x" }, 400), /^updated_at is required/);
  await ok("PATCH", `/skills/${(await ok<Any[]>("GET", `/skills?project_id=${p.id}`))[0].id}`, { body: "a person's edit" });
  assert.equal(await err({ action: "update", name: "guarded", body: "x", updated_at: made.updated_at }, 409), `skill "guarded" changed since you read it (now ${(await agent(ref, { action: "view", name: "guarded" })).data.skill.updated_at}); view it again`);
  assert.equal((await agent(ref, { action: "view", name: "guarded" })).data.skill.body, "a person's edit");
  assert.equal(await err({ action: "view", name: "nope" }, 404), 'no skill named "nope" here');
  assert.equal(await err({ action: "create", name: "x", scope: "project", description: "d", body: "b" }, 400, null), 'not inside a project; use scope "global"');
  assert.equal(await err({ action: "create", name: "x", scope: "team", description: "d", body: "b" }, 400), 'scope must be "global" or "project"');
  assert.match(await err({ action: "create", name: "Bad", scope: "global", description: "d", body: "b" }, 400), /^skill name must be/);
  assert.equal(await err({ action: "create", name: "guarded", scope: "project", description: "d", body: "b" }, 409), 'a skill named "guarded" already exists here');
  assert.match(await err({ action: "create", name: "leaky", scope: "global", description: "d", body: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" }, 422), /secrets/);
});

test("ADR-0039: skillsVersion — /context and /skills/sync carry the same value; any change in scope changes it, other projects do not", async () => {
  const p = await project("github.com/test/sk-ver", "sk-ver");
  const other = await project("github.com/test/sk-ver-other", "sk-ver-other");
  const ref = { key: p.key, name: p.name };
  const ctxVersion = async () => (await ok<Any>("POST", "/context", { project: ref, prompt: "x" })).skillsVersion as string;
  const syncVersion = async () => (await ok<Any>("GET", `/skills/sync?project=${encodeURIComponent(p.key)}`)).version as string;
  const v0 = await ctxVersion();
  assert.equal(v0, await syncVersion());
  const own = await ok<Any>("POST", "/skills", skill({ name: "ver-own", project_id: p.id }));
  const v1 = await ctxVersion();
  assert.notEqual(v1, v0);
  assert.equal(v1, await syncVersion());
  await ok("POST", "/skills", skill({ name: "ver-other", project_id: other.id }));
  assert.equal(await ctxVersion(), v1, "another project's skill is not this PC's business");
  await ok("PATCH", `/skills/${own.id}`, { description: "changed" });
  const v2 = await ctxVersion();
  assert.notEqual(v2, v1);
  await ok("DELETE", `/skills/${own.id}`);
  assert.notEqual(await ctxVersion(), v2);
  // Nothing at all to mirror → "" (a PC that never synced matches it).
  db.exec("DELETE FROM skills"); // last test in this file: the DB is this file's own
  assert.equal(await ctxVersion(), "");
});
