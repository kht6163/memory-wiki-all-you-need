import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Skill mirror (server ADR-0039): the server's skills are written to
//   <agent dir>/extensions/memory-wiki-all-you-need/skills/global/<name>/SKILL.md
//   <agent dir>/extensions/memory-wiki-all-you-need/skills/project/<key>/<name>/SKILL.md
// One way only: each scope folder is made to match the server exactly (local
// edits are overwritten, local additions removed) and nothing local is ever
// sent back (G-068). When the server cannot be reached the folders stay as they
// were, so pi keeps the last synced skills.

export interface SyncSkill {
  name: string;
  description: string;
  body: string;
  updated_at?: string;
}

export interface SkillsPayload {
  /** Hash of this payload on the server; /context carries the current one (absent on servers before it). */
  version?: string;
  global: SyncSkill[];
  project: { key: string; name: string; skills: SyncSkill[] } | null;
}

/** pi's skill name rule (same as the server's): lowercase letters, digits, single hyphens, ≤64. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const skillsRoot = (agentDir: string) => path.join(agentDir, "extensions", "memory-wiki-all-you-need", "skills");
export const globalSkillsDir = (root: string) => path.join(root, "global");

/** A filesystem-safe folder per project key ("github.com/me/app" → "github.com_me_app-<hash>"); the hash keeps keys that clean up alike apart. */
export function projectSkillsDir(root: string, key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 80) || "project";
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  return path.join(root, "project", `${safe}-${hash}`);
}

const valid = (s: unknown): s is SyncSkill => {
  const k = s as SyncSkill;
  return (
    Boolean(k) &&
    typeof k.name === "string" &&
    k.name.length <= 64 &&
    SKILL_NAME_RE.test(k.name) &&
    typeof k.description === "string" &&
    k.description.trim() !== "" &&
    typeof k.body === "string"
  );
};

/** SKILL.md as pi reads it: YAML frontmatter (description JSON-quoted, so no newline or "---" can break it), a notice, the body. */
export function renderSkill(s: SyncSkill, server: string): string {
  return [
    "---",
    `name: ${s.name}`,
    `description: ${JSON.stringify(s.description.replace(/\s+/g, " ").trim())}`,
    "---",
    `<!-- Synced from the memory server (${server}). Local edits are overwritten on the next sync: change it on the server, then run /skills-sync. -->`,
    "",
    s.body.trim(),
    "",
  ].join("\n");
}

/** The files a scope folder should hold: name → SKILL.md text (invalid or repeated names left out). */
function planScope(skills: SyncSkill[], server: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of skills) if (valid(s) && !out.has(s.name)) out.set(s.name, renderSkill(s, server));
  return out;
}

/** True when the folder holds exactly these skills, byte for byte, and nothing else. */
function matches(dir: string, want: Map<string, string>): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return want.size === 0;
  }
  if (names.length !== want.size) return false;
  for (const name of names) {
    const text = want.get(name);
    if (text === undefined) return false;
    try {
      if (fs.readdirSync(path.join(dir, name)).length !== 1) return false;
      if (fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8") !== text) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Skill names currently in a scope folder (empty when there is none). */
export function localSkillNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Makes one scope folder match `want`: written to a temporary folder first and
 * swapped in, so pi never sees half a sync. Returns whether anything changed.
 */
function mirror(dir: string, want: Map<string, string>): boolean {
  if (matches(dir, want)) return false;
  const stamp = `${process.pid}-${Date.now()}`;
  const tmp = `${dir}.tmp-${stamp}`;
  const old = `${dir}.old-${stamp}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(tmp);
    for (const [name, text] of want) {
      fs.mkdirSync(path.join(tmp, name));
      fs.writeFileSync(path.join(tmp, name, "SKILL.md"), text);
    }
    const had = fs.existsSync(dir);
    if (had) fs.renameSync(dir, old);
    try {
      fs.renameSync(tmp, dir);
    } catch (err) {
      if (had && !fs.existsSync(dir)) fs.renameSync(old, dir); // put the previous skills back
      throw err;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
  }
  return true;
}

// The version last mirrored, per project key ("" = outside a project), in
// <root>/versions.json: the extension compares it with /context's skillsVersion.
const versionsFile = (root: string) => path.join(root, "versions.json");

function readVersions(root: string): Record<string, string> {
  try {
    const v = JSON.parse(fs.readFileSync(versionsFile(root), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The server version of the skills now on disk for this project, or null when unknown (never synced, old server). */
export function mirroredVersion(root: string, projectKey: string | null): string | null {
  const v = readVersions(root)[projectKey ?? ""];
  return typeof v === "string" ? v : null;
}

function writeVersion(root: string, projectKey: string | null, version: string | undefined, dropOthers: boolean) {
  const all = dropOthers ? {} : readVersions(root);
  if (version === undefined) delete all[projectKey ?? ""];
  else all[projectKey ?? ""] = version;
  const tmp = `${versionsFile(root)}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
  fs.renameSync(tmp, versionsFile(root));
}

export interface SyncResult {
  global: number;
  project: number;
  /** Local skills that the server no longer has (deleted by this sync). */
  removed: string[];
  changed: boolean;
  /** The server version now on disk for this project (null: a server without versions). */
  version: string | null;
}

/**
 * Writes the server's skills into the scope folders. `projectKey` is the key the
 * PC asked with (the folder name follows it, not the server's canonical key).
 * Throws on a write failure; the caller decides how loud to be.
 */
export function applySkills(root: string, payload: SkillsPayload, projectKey: string | null, server: string): SyncResult {
  // Only a well-formed answer may empty a folder; anything else (an old server, a proxy page) keeps the last sync.
  const p = payload as Partial<SkillsPayload> | null;
  if (!p || !Array.isArray(p.global) || (p.project != null && !Array.isArray(p.project.skills))) {
    throw new Error("unexpected answer from the server (no skill lists)");
  }
  const gDir = globalSkillsDir(root);
  const gWant = planScope(p.global, server);
  const removed = localSkillNames(gDir)
    .filter((n) => !gWant.has(n))
    .map((n) => `global:${n}`);
  const globalChanged = mirror(gDir, gWant);
  let changed = globalChanged;
  let project = 0;
  if (projectKey) {
    const pDir = projectSkillsDir(root, projectKey);
    const pWant = planScope(p.project?.skills ?? [], server);
    removed.push(...localSkillNames(pDir).filter((n) => !pWant.has(n)));
    changed = mirror(pDir, pWant) || changed;
    project = pWant.size;
  }
  const version = typeof p.version === "string" ? p.version : undefined;
  // Each entry hashes global + one project: a rewritten global/ makes the other projects' entries wrong.
  writeVersion(root, projectKey, version, globalChanged);
  return { global: gWant.size, project, removed, changed, version: version ?? null };
}

/**
 * SKILL.md paths to hand to pi for this project, from what is on disk: every
 * project skill, plus the global ones the project does not override (pi keeps
 * the first of two skills with one name and warns, so the loser is left out).
 */
export function skillPaths(root: string, projectKey: string | null): string[] {
  const projectNames = projectKey ? localSkillNames(projectSkillsDir(root, projectKey)) : [];
  const taken = new Set(projectNames);
  const pDir = projectKey ? projectSkillsDir(root, projectKey) : "";
  const gDir = globalSkillsDir(root);
  return [
    ...projectNames.map((n) => path.join(pDir, n, "SKILL.md")),
    ...localSkillNames(gDir)
      .filter((n) => !taken.has(n))
      .map((n) => path.join(gDir, n, "SKILL.md")),
  ];
}
