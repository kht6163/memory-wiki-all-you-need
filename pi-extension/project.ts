import fs from "node:fs";
import path from "node:path";

// Client-side project resolution. A project is the git repository that
// contains the cwd (linked worktrees resolve to their main repo). Its key is
// the normalized `origin` remote so the same repo maps to one project on every
// machine; repos without a remote fall back to the repo directory name.
// Reads .git files directly so it never spawns git.

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

/** override: a fixed project key (MEMORY_PROJECT or the settings file's "project"). */
export function resolveProject(cwd: string, override = process.env.MEMORY_PROJECT?.trim()): ProjectRef | null {
  const repo = findRepo(cwd);
  if (override) {
    return { key: override, name: override.split("/").pop() || override, remote: null, root: repo?.[0] ?? cwd };
  }
  if (!repo) return null;
  const [root, gitDir] = repo;
  const remote = originUrl(gitDir);
  const name = path.basename(root);
  return { key: remote ? normalizeRemote(remote) : `local/${name}`, name, remote, root };
}
