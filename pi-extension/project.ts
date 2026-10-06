import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Client-side project resolution. A project is the git repository that
// contains the cwd (linked worktrees resolve to their main repo). Its key is
// the normalized `origin` remote so the same repo maps to one project on every
// machine; repos without a remote fall back to the repo directory name.
// Reads .git files directly so it never spawns git. Outside git, the folder itself is the
// project (never global): "home/<user>[/<path>]" under the home directory, else "path/<path>".

export interface ProjectRef {
  key: string;
  name: string;
  remote: string | null;
  root: string;
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Returns [workTreeRoot, gitDir] of the main repository, or null outside git. */
function findRepo(start: string): [string, string] | null {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return [dir, dotGit];
    if (stat?.isFile()) {
      // Linked worktree or submodule: ".git" holds "gitdir: <path>".
      const m = readIfExists(dotGit)?.match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const gitDir = path.resolve(dir, m[1].trim());
        const common = readIfExists(path.join(gitDir, "commondir"))?.trim();
        if (common) {
          const commonDir = path.resolve(gitDir, common);
          return [path.basename(commonDir) === ".git" ? path.dirname(commonDir) : dir, commonDir];
        }
        return [dir, gitDir];
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function originUrl(gitDir: string): string | null {
  const cfg = readIfExists(path.join(gitDir, "config"));
  if (!cfg) return null;
  const section = cfg.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\n\s*\[|$)/);
  const url = section?.[1].match(/^\s*url\s*=\s*(.+)$/m)?.[1].trim();
  return url || null;
}

/** git@github.com:foo/bar.git, https://user@github.com/foo/bar -> github.com/foo/bar */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = u.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/);
  if (scp && !/^[a-z]+:\/\//i.test(u)) u = `${scp[1]}/${scp[2]}`;
  u = u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "").replace(/:\d+\//, "/");
  return u.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
}

/** A path in the form keys use: forward slashes, no trailing separator ("" for a root), lower-cased on Windows. */
export function keyPath(p: string, windows = process.platform === "win32"): string {
  let t = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (windows) t = t.toLowerCase();
  return t;
}

/**
 * The project for a folder outside any git repository — never global:
 * the home directory itself → "home/<user>" (named after the user), a folder under it →
 * "home/<user>/<relative path>", anything else → "path/<absolute path>" (a root → "path/", which no real folder gives),
 * named after the folder. The Claude Code plugin builds the same key (lib.ts folderProject).
 */
export function folderProject(cwd: string, home: string, user: string, windows = process.platform === "win32"): ProjectRef {
  const c = keyPath(cwd, windows);
  const h = keyPath(home, windows);
  const base = (x: string) => x.split("/").filter(Boolean).pop() ?? "";
  const who = user.trim() || base(keyPath(home, false));
  if (h && who && (c === h || c.startsWith(`${h}/`))) {
    const rel = c.slice(h.length).replace(/^\/+/, "");
    const userKey = `home/${who.toLowerCase()}`;
    return rel ? { key: `${userKey}/${rel}`, name: base(rel), remote: null, root: cwd } : { key: userKey, name: who, remote: null, root: cwd };
  }
  const abs = c.replace(/^\/+/, "");
  return abs ? { key: `path/${abs}`, name: base(abs), remote: null, root: cwd } : { key: "path/", name: "/", remote: null, root: cwd };
}

/**
 * USER / USERNAME; "" lets folderProject fall back to the home folder's name — the same chain
 * as the Claude Code plugin, which cannot ask the OS for the account name.
 */
export function currentUser(env: Record<string, string | undefined> = process.env): string {
  return env.USER?.trim() || env.USERNAME?.trim() || "";
}

/** override: a fixed project key (MEMORY_PROJECT or the settings file's "project"). */
export function resolveProject(cwd: string, override = process.env.MEMORY_PROJECT?.trim()): ProjectRef {
  const repo = findRepo(cwd);
  if (override) {
    return { key: override, name: override.split("/").pop() || override, remote: null, root: repo?.[0] ?? cwd };
  }
  if (!repo) return folderProject(cwd, os.homedir(), currentUser());
  const [root, gitDir] = repo;
  const remote = originUrl(gitDir);
  const name = path.basename(root);
  return { key: remote ? normalizeRemote(remote) : `local/${name}`, name, remote, root };
}
