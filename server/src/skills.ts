import { createHash } from "node:crypto";
import { db, now, type Project } from "./db.ts";
import { findSecrets } from "./secrets.ts";
import { skillNeedsApproval } from "./settings.ts";
import { HttpError, getProject, getProjectByKey } from "./store.ts";

// Agent skills (ADR-0039, ADR-0040): kept here, written from the web, and
// mirrored one way to each PC by the pi extension (/skills-sync, and on every pi
// start): <agent dir>/extensions/memory-wiki-all-you-need/skills/{global,project/<key>}/<name>/SKILL.md.
// Nothing on a PC is ever uploaded (G-068). pi advertises each skill's name and
// description and reads the body when a task matches.
//  - Names and descriptions follow pi's rules, or pi would drop the file at load.
//  - One name per scope among live skills; a project skill may reuse a global
//    name and then wins in that project (the extension leaves the global one out).
//  - Every write leaves a revision (the content after it): people can look back
//    and revert. Deleting moves a skill to the trash; it can be restored while
//    its name is free, and purged for good.
//  - The agent writes too (skill_manage → POST /api/agent/skill): list, view,
//    create, update; never delete. An update must name the version it read
//    (updated_at) and a locked skill refuses it (423). `author` is whoever wrote
//    the current version.
//  - Approval (settings skillApproval, default "global"): an agent skill in a
//    scope that needs it is created as a candidate, and an agent edit of an
//    approved skill is kept as a draft; neither reaches a PC until a person
//    approves it on the web (G-069).
//  - skillsVersion: a short hash of what a PC would mirror; /context carries it
//    so the extension can tell the user the server's skills changed.

export type SkillStatus = "active" | "candidate";

export interface Skill {
  id: number;
  project_id: number | null;
  name: string;
  description: string;
  body: string;
  author: string;
  status: SkillStatus;
  locked: boolean;
  deleted_at: string | null;
  /** An agent edit waiting for approval (the skill keeps its approved content meanwhile). */
  draft: { description: string; body: string; at: string } | null;
  created_at: string;
  updated_at: string;
}

export interface SkillRevision {
  id: number;
  skill_id: number;
  action: string;
  name: string;
  description: string;
  body: string;
  author: string;
  reason: string | null;
  created_at: string;
}

export interface SyncSkill {
  name: string;
  description: string;
  body: string;
  updated_at: string;
}

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_BODY_MAX = 50_000;

const toSkill = (r: Record<string, unknown>): Skill => ({
  id: Number(r.id),
  project_id: r.project_id == null ? null : Number(r.project_id),
  name: String(r.name),
  description: String(r.description),
  body: String(r.body),
  author: String(r.author),
  status: r.status === "candidate" ? "candidate" : "active",
  locked: Boolean(r.locked),
  deleted_at: r.deleted_at == null ? null : String(r.deleted_at),
  draft: r.draft_at == null ? null : { description: String(r.draft_description), body: String(r.draft_body), at: String(r.draft_at) },
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
});

const toRevision = (r: Record<string, unknown>): SkillRevision => ({
  id: Number(r.id),
  skill_id: Number(r.skill_id),
  action: String(r.action),
  name: String(r.name),
  description: String(r.description),
  body: String(r.body),
  author: String(r.author),
  reason: r.reason == null ? null : String(r.reason),
  created_at: String(r.created_at),
});

function checkName(v: unknown): string {
  const name = typeof v === "string" ? v.trim() : "";
  if (!name || name.length > SKILL_NAME_MAX || !SKILL_NAME_RE.test(name)) throw new HttpError(400, `skill name must be lowercase letters, digits and single hyphens (max ${SKILL_NAME_MAX})`);
  return name;
}

function checkDescription(v: unknown): string {
  // One line: pi shows it in the system prompt's skill list.
  const d = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (!d) throw new HttpError(400, "skill description is required");
  if (d.length > SKILL_DESCRIPTION_MAX) throw new HttpError(400, `skill description is too long (max ${SKILL_DESCRIPTION_MAX} characters)`);
  return d;
}

function checkBody(v: unknown): string {
  const b = typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "";
  if (!b) throw new HttpError(400, "skill body is required");
  if (b.length > SKILL_BODY_MAX) throw new HttpError(400, `skill body is too long (max ${SKILL_BODY_MAX} characters)`);
  return b;
}

function checkSecrets(...parts: string[]) {
  const secrets = findSecrets(parts.join("\n"));
  if (secrets.length) throw new HttpError(422, `content looks like it contains secrets: ${secrets.join(", ")}`);
}

/** project_id from a request: a project id, or null/0/absent for global. */
export function skillScope(v: unknown): number | null {
  if (v == null || v === 0 || v === "0" || v === "") return null;
  const id = Number(v);
  if (!Number.isInteger(id) || id < 0) throw new HttpError(400, "project_id must be a project id or null");
  if (!getProject(id)) throw new HttpError(404, "project not found");
  return id;
}

function assertFree(projectId: number | null, name: string, exceptId?: number) {
  const r = db.prepare(`SELECT id FROM skills WHERE COALESCE(project_id, 0) = ? AND name = ? AND deleted_at IS NULL`).get(projectId ?? 0, name);
  if (r && Number(r.id) !== exceptId) throw new HttpError(409, `a skill named "${name}" already exists here`);
}

/** Records the skill's content after a write (or the given content: a proposed edit). */
function revise(skillId: number, action: string, author: string, reason: string | null = null, content?: { description: string; body: string }) {
  const s = getSkill(skillId)!;
  db.prepare(`INSERT INTO skill_revisions (skill_id, action, name, description, body, author, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    skillId,
    action,
    s.name,
    content?.description ?? s.description,
    content?.body ?? s.body,
    author,
    reason,
  );
}

/** A skill, in the trash or not. */
export function getSkill(id: number): Skill | null {
  const r = db.prepare(`SELECT * FROM skills WHERE id = ?`).get(id);
  return r ? toSkill(r) : null;
}

/** A skill that exists and is not in the trash. */
function liveSkill(id: number): Skill {
  const s = getSkill(id);
  if (!s) throw new HttpError(404, "skill not found");
  if (s.deleted_at) throw new HttpError(409, "skill is in the trash; restore it first");
  return s;
}

/**
 * One scope (a project id, or null = global), or every scope when `projectId`
 * is undefined. Live skills (candidates included) by name, or the trash.
 */
export function listSkills(projectId?: number | null, opts: { deleted?: boolean } = {}): Skill[] {
  const trash = opts.deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
  const rows =
    projectId === undefined
      ? db.prepare(`SELECT * FROM skills WHERE ${trash} ORDER BY COALESCE(project_id, 0), name`).all()
      : db.prepare(`SELECT * FROM skills WHERE COALESCE(project_id, 0) = ? AND ${trash} ORDER BY name`).all(projectId ?? 0);
  return rows.map(toSkill);
}

/** What PCs get: approved, live skills of one scope. */
const syncedSkills = (projectId: number | null) => listSkills(projectId).filter((s) => s.status === "active");

export function createSkill(
  input: { project_id?: unknown; name?: unknown; description?: unknown; body?: unknown },
  author = "human",
  status: SkillStatus = "active",
): Skill {
  const projectId = skillScope(input.project_id);
  const name = checkName(input.name);
  const description = checkDescription(input.description);
  const body = checkBody(input.body);
  checkSecrets(description, body);
  assertFree(projectId, name);
  const res = db
    .prepare(`INSERT INTO skills (project_id, name, description, body, author, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(projectId, name, description, body, author, status);
  const id = Number(res.lastInsertRowid);
  revise(id, "create", author);
  return getSkill(id)!;
}

/**
 * Changes what is given; the scope does not change (make a new skill in the
 * other scope instead). `locked` is for people only and does not count as a
 * content change (no new updated_at, so PCs are not told to sync).
 */
export function updateSkill(
  id: number,
  patch: { name?: unknown; description?: unknown; body?: unknown; locked?: unknown },
  author = "human",
  expectedUpdatedAt?: string,
): Skill {
  const cur = liveSkill(id);
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== cur.updated_at) {
    throw new HttpError(409, `skill "${cur.name}" changed since you read it (now ${cur.updated_at}); view it again`);
  }
  if (author !== "human" && cur.locked) throw new HttpError(423, `skill "${cur.name}" is locked; only people can change it on the web`);
  if (patch.locked !== undefined) {
    if (typeof patch.locked !== "boolean") throw new HttpError(400, "locked must be true or false");
    if (patch.locked !== cur.locked) {
      db.prepare(`UPDATE skills SET locked = ? WHERE id = ?`).run(patch.locked ? 1 : 0, id);
      revise(id, patch.locked ? "lock" : "unlock", author);
    }
  }
  const name = patch.name === undefined ? cur.name : checkName(patch.name);
  const description = patch.description === undefined ? cur.description : checkDescription(patch.description);
  const body = patch.body === undefined ? cur.body : checkBody(patch.body);
  if (name === cur.name && description === cur.description && body === cur.body) return getSkill(id)!;
  checkSecrets(description, body);
  assertFree(cur.project_id, name, id);
  db.prepare(`UPDATE skills SET name = ?, description = ?, body = ?, author = ?, updated_at = ? WHERE id = ?`).run(name, description, body, author, now(), id);
  revise(id, "update", author);
  dropDraft(cur, author);
  return getSkill(id)!;
}

/**
 * A waiting agent edit was a whole copy of the skill as it was: once the content
 * changes, approving it would undo that change. Dropped, kept in the history.
 */
function dropDraft(before: Skill, author: string) {
  if (!before.draft) return;
  db.prepare(`UPDATE skills SET draft_description = NULL, draft_body = NULL, draft_at = NULL WHERE id = ?`).run(before.id);
  revise(before.id, "reject", author, "edit waiting for approval dropped: the skill changed", before.draft);
}

/** To the trash: the next sync removes the file from every PC. Restorable while the name is free. */
export function deleteSkill(id: number, author = "human", action: "delete" | "reject" = "delete"): Skill {
  const cur = getSkill(id);
  if (!cur) throw new HttpError(404, "skill not found");
  if (cur.deleted_at) throw new HttpError(409, "skill is already in the trash");
  db.prepare(`UPDATE skills SET deleted_at = ?, draft_description = NULL, draft_body = NULL, draft_at = NULL WHERE id = ?`).run(now(), id);
  revise(id, action, author);
  return getSkill(id)!;
}

export function restoreSkill(id: number): Skill {
  const cur = getSkill(id);
  if (!cur) throw new HttpError(404, "skill not found");
  if (!cur.deleted_at) throw new HttpError(409, "skill is not in the trash");
  assertFree(cur.project_id, cur.name, id);
  db.prepare(`UPDATE skills SET deleted_at = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
  revise(id, "restore", "human");
  return getSkill(id)!;
}

/** Gone for good, with its history. Only from the trash. */
export function purgeSkill(id: number): Skill {
  const cur = getSkill(id);
  if (!cur) throw new HttpError(404, "skill not found");
  if (!cur.deleted_at) throw new HttpError(409, "only skills in the trash can be purged");
  db.prepare(`DELETE FROM skills WHERE id = ?`).run(id);
  return cur;
}

export function listSkillRevisions(id: number): SkillRevision[] {
  if (!getSkill(id)) throw new HttpError(404, "skill not found");
  return db.prepare(`SELECT * FROM skill_revisions WHERE skill_id = ? ORDER BY id DESC`).all(id).map(toRevision);
}

/** Back to a revision's description and body (the name stays). */
export function revertSkill(id: number, revisionId: unknown): Skill {
  const cur = liveSkill(id);
  const r = db.prepare(`SELECT * FROM skill_revisions WHERE id = ? AND skill_id = ?`).get(Number(revisionId), id);
  if (!r) throw new HttpError(404, "revision not found");
  const rev = toRevision(r);
  if (rev.description === cur.description && rev.body === cur.body) return cur;
  db.prepare(`UPDATE skills SET description = ?, body = ?, author = 'human', updated_at = ? WHERE id = ?`).run(rev.description, rev.body, now(), id);
  revise(id, "revert", "human", `revision #${rev.id}`);
  dropDraft(cur, "human");
  return getSkill(id)!;
}

/**
 * What the person approving or rejecting saw: the skill's updated_at, and the
 * waiting edit's draft_at. Anything newer (an agent edit of a candidate, a new
 * proposal) must be looked at first, or unseen content would reach every PC.
 */
function assertSeen(cur: Skill, seen: { updated_at?: unknown; draft_at?: unknown } | undefined) {
  if (typeof seen?.updated_at !== "string") throw new HttpError(400, "updated_at is required: send the version you reviewed");
  if (seen.updated_at !== cur.updated_at) throw new HttpError(409, `skill "${cur.name}" changed since you read it (now ${cur.updated_at}); view it again`);
  if (cur.draft && seen.draft_at !== cur.draft.at) throw new HttpError(409, `the edit waiting for approval on "${cur.name}" changed since you read it; view it again`);
}

/** A person approves an agent's candidate skill (it starts syncing) or its waiting edit (applied). */
export function approveSkill(id: number, seen?: { updated_at?: unknown; draft_at?: unknown }): Skill {
  const cur = liveSkill(id);
  assertSeen(cur, seen);
  if (cur.status === "candidate") {
    db.prepare(`UPDATE skills SET status = 'active', updated_at = ? WHERE id = ?`).run(now(), id);
    revise(id, "approve", "human");
    return getSkill(id)!;
  }
  if (cur.draft) {
    checkSecrets(cur.draft.description, cur.draft.body);
    db.prepare(
      `UPDATE skills SET description = draft_description, body = draft_body, author = 'agent', updated_at = ?,
         draft_description = NULL, draft_body = NULL, draft_at = NULL WHERE id = ?`,
    ).run(now(), id);
    revise(id, "approve", "human", "agent edit approved");
    return getSkill(id)!;
  }
  throw new HttpError(409, "nothing to approve");
}

/** A person turns down a candidate skill (to the trash) or a waiting edit (dropped; kept in the history). */
export function rejectSkill(id: number, seen?: { updated_at?: unknown; draft_at?: unknown }): Skill {
  const cur = liveSkill(id);
  assertSeen(cur, seen);
  if (cur.status === "candidate") return deleteSkill(id, "human", "reject");
  if (cur.draft) {
    db.prepare(`UPDATE skills SET draft_description = NULL, draft_body = NULL, draft_at = NULL WHERE id = ?`).run(id);
    revise(id, "reject", "human", "agent edit rejected", cur.draft);
    return getSkill(id)!;
  }
  throw new HttpError(409, "nothing to reject");
}

const forSync = (s: Skill): SyncSkill => ({ name: s.name, description: s.description, body: s.body, updated_at: s.updated_at });

/**
 * What a PC mirrors (GET /api/skills/sync): the global skills, and the skills of
 * the project whose key (or merged-away key) is given. Approved, live skills
 * only. Read only: an unknown key is project null, never a new project.
 */
export function skillsForSync(projectKey?: string) {
  const project = projectKey ? getProjectByKey(projectKey) : null;
  return {
    version: skillsVersion(project),
    global: syncedSkills(null).map(forSync),
    project: project ? { key: project.key, name: project.name, skills: syncedSkills(project.id).map(forSync) } : null,
  };
}

/**
 * A short hash of what GET /skills/sync gives this project (or a PC outside a
 * project): any create, edit, rename, approval or delete there changes it. ""
 * when there is none.
 */
export function skillsVersion(project: Pick<Project, "id"> | null): string {
  const all = [...syncedSkills(null), ...(project ? syncedSkills(project.id) : [])];
  if (!all.length) return ""; // nothing to mirror: matches a PC that has never synced
  const h = createHash("sha1");
  for (const s of all) {
    h.update(`${s.project_id ?? 0}\0${s.name}\0${s.description}\0${s.body}\0${s.updated_at}\n`);
  }
  return h.digest("hex").slice(0, 12);
}

/** skills: live in every scope; globalSkills: live global ones (the sidebar's "전역 스킬"); skillsPending: waiting for approval. */
export function skillStats() {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE project_id IS NULL) AS g,
         COUNT(*) FILTER (WHERE status = 'candidate' OR draft_at IS NOT NULL) AS p
       FROM skills WHERE deleted_at IS NULL`,
    )
    .get();
  return { skills: Number(r?.n ?? 0), globalSkills: Number(r?.g ?? 0), skillsPending: Number(r?.p ?? 0) };
}

// ----------------------------------------------------------- agent (skill_manage)

export interface AgentSkillRequest {
  action?: unknown;
  name?: unknown;
  scope?: unknown;
  description?: unknown;
  body?: unknown;
  updated_at?: unknown;
}

const agentView = (s: Skill) => ({
  scope: s.project_id == null ? ("global" as const) : ("project" as const),
  name: s.name,
  description: s.description,
  body: s.body,
  author: s.author,
  status: s.status,
  locked: s.locked,
  pending_edit: s.draft,
  updated_at: s.updated_at,
});

/** The skill the agent means by name: `scope` picks one; otherwise this project's, then the global one (what pi loads). */
function agentFind(project: Project | null, name: string, scope: unknown): Skill | null {
  const find = (projectId: number | null) => listSkills(projectId).find((s) => s.name === name) ?? null;
  if (scope === "global") return find(null);
  if (scope === "project") return project ? find(project.id) : null;
  return (project && find(project.id)) || find(null);
}

/**
 * skill_manage from the pi extension. list / view / create / update; never
 * delete (people do that on the web). The answer carries the versions before
 * and after, so the extension can re-mirror and not report its own write as an
 * outside change; `changed: false` = the update matched what was there;
 * `proposed: true` = the edit waits for approval.
 */
export function agentSkill(project: Project | null, b: AgentSkillRequest) {
  const action = b.action;
  if (action === "list") {
    const all = [...(project ? listSkills(project.id) : []), ...listSkills(null)];
    return {
      action,
      skills: all.map((s) => {
        const { body: _body, pending_edit, ...head } = agentView(s);
        return { ...head, pending_edit: Boolean(pending_edit) };
      }),
    };
  }
  if (action !== "view" && action !== "create" && action !== "update") {
    throw new HttpError(400, "action must be list, view, create or update (skills are deleted on the memory server's web UI)");
  }
  if (b.scope !== undefined && b.scope !== "global" && b.scope !== "project") throw new HttpError(400, 'scope must be "global" or "project"');
  if (b.scope === "project" && !project) throw new HttpError(400, 'not inside a project; use scope "global"');
  const name = checkName(b.name);
  // The version before this write: the extension treats its own write as loaded only when nothing else changed.
  const previous_version = skillsVersion(project);
  if (action === "create") {
    if (b.scope === undefined) throw new HttpError(400, 'scope is required to create a skill: "global" or "project"');
    const projectId = b.scope === "project" ? project!.id : null;
    const s = createSkill({ project_id: projectId, name, description: b.description, body: b.body }, "agent", skillNeedsApproval(projectId) ? "candidate" : "active");
    return { action, skill: agentView(s), version: skillsVersion(project), previous_version };
  }
  const cur = agentFind(project, name, b.scope);
  if (!cur) throw new HttpError(404, `no skill named "${name}" here`);
  if (action === "view") return { action, skill: agentView(cur) };
  if (typeof b.updated_at !== "string" || !b.updated_at) throw new HttpError(400, "updated_at is required to update a skill: view it first and pass its updated_at");
  if (cur.status === "active" && skillNeedsApproval(cur.project_id)) {
    // An approved skill in a scope that needs approval: keep the edit as a draft for a person.
    if (b.updated_at !== cur.updated_at) throw new HttpError(409, `skill "${cur.name}" changed since you read it (now ${cur.updated_at}); view it again`);
    if (cur.locked) throw new HttpError(423, `skill "${cur.name}" is locked; only people can change it on the web`);
    const description = b.description === undefined ? cur.description : checkDescription(b.description);
    const body = b.body === undefined ? cur.body : checkBody(b.body);
    const base = cur.draft ?? cur;
    if (description === base.description && body === base.body) return { action, skill: agentView(cur), version: previous_version, previous_version, changed: false };
    checkSecrets(description, body);
    db.prepare(`UPDATE skills SET draft_description = ?, draft_body = ?, draft_at = ? WHERE id = ?`).run(description, body, now(), cur.id);
    revise(cur.id, "propose", "agent", null, { description, body });
    return { action, skill: agentView(getSkill(cur.id)!), version: previous_version, previous_version, changed: true, proposed: true };
  }
  const s = updateSkill(cur.id, { description: b.description, body: b.body }, "agent", b.updated_at);
  return { action, skill: agentView(s), version: skillsVersion(project), previous_version, changed: s.updated_at !== cur.updated_at };
}
