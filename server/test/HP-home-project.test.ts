// Outside any git repository the folder itself is the project, never global — in the pi
// extension and the Claude Code plugin alike: the home directory → "home/<user>", a folder
// under it → "home/<user>/<relative path>", anything else → "path/<absolute path>".
// A repo or a fixed project key wins.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { currentUser, folderProject, resolveProject } from "../../pi-extension/project.ts";
import { folderProject as ccFolderProject } from "../../claude-code-plugin/hooks/lib.ts";
import { sessionStart, startSession } from "./CC-harness.ts";
import { startMockServer, waitFor } from "./X-ext-harness.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mwayn-home-"));
const savedEnv = { HOME: process.env.HOME, USER: process.env.USER, USERNAME: process.env.USERNAME };
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const key = (cwd: string, home: string, user: string, win = false) => {
  const p = folderProject(cwd, home, user, win);
  return [p.key, p.name];
};

test("folderProject: home, folders under it and folders elsewhere each get their own key", () => {
  assert.deepEqual(key("/home/alice", "/home/alice", "Alice"), ["home/alice", "Alice"]);
  assert.deepEqual(key("/home/alice/", "/home/alice", "Alice"), ["home/alice", "Alice"]);
  assert.deepEqual(key("/home/alice/Downloads", "/home/alice", "Alice"), ["home/alice/Downloads", "Downloads"]);
  assert.deepEqual(key("/home/alice/work/notes/", "/home/alice", "Alice"), ["home/alice/work/notes", "notes"]);
  assert.deepEqual(key("/home/alicex", "/home/alice", "Alice"), ["path/home/alicex", "alicex"], "a sibling that only shares the prefix");
  assert.deepEqual(key("/tmp/scratch", "/home/alice", "Alice"), ["path/tmp/scratch", "scratch"]);
  assert.deepEqual(key("/", "/home/alice", "Alice"), ["path/", "/"]);
  assert.deepEqual(key("/root", "/home/alice", "Alice"), ["path/root", "root"], "the /root folder is not the filesystem root");
  assert.deepEqual(key("/srv/x", "", ""), ["path/srv/x", "x"], "no HOME: by path");
  // No user name: the home folder's name.
  assert.deepEqual(key("/home/bob/a", "/home/bob", ""), ["home/bob/a", "a"]);
  // Windows: case and separators do not matter.
  assert.deepEqual(key("c:/users/Alice/Proj", "C:\\Users\\Alice\\", "Alice", true), ["home/alice/proj", "proj"]);
  assert.deepEqual(key("D:\\data\\x", "C:\\Users\\Alice", "Alice", true), ["path/d:/data/x", "x"]);
});

test("the Claude Code plugin builds the same folder project as the pi extension", () => {
  for (const [cwd, home, user, win] of [
    ["/home/alice", "/home/alice", "Alice", false],
    ["/home/alice/x/y", "/home/alice", "Alice", false],
    ["/opt/tool", "/home/alice", "Alice", false],
    ["/", "/home/alice", "", false],
    ["C:\\Users\\Bob\\Desktop", "c:/users/bob/", "", true],
    ["/home/carol/", "/home/carol", "", false],
  ] as const) {
    const pi = folderProject(cwd, home, user, win);
    assert.deepEqual(ccFolderProject(cwd, home, user, win), { key: pi.key, name: pi.name, remote: null }, `${cwd} ${home}`);
  }
});

test("resolveProject: outside git → the folder's project; a repo or MEMORY_PROJECT wins; no USER → home folder name", () => {
  const home = path.join(tmp, "Alice");
  fs.mkdirSync(path.join(home, "notes"), { recursive: true });
  process.env.HOME = home; // os.homedir() reads HOME on POSIX
  process.env.USER = "Alice";
  delete process.env.USERNAME;
  assert.equal(os.homedir(), home);
  assert.deepEqual(resolveProject(home, ""), { key: "home/alice", name: "Alice", remote: null, root: home });
  assert.equal(resolveProject(path.join(home, "notes"), "").key, "home/alice/notes");
  assert.equal(resolveProject(home, "github.com/x/fixed").key, "github.com/x/fixed");
  // A dotfiles repo in the home directory is a repo like any other (its subfolders too).
  fs.mkdirSync(path.join(home, ".git"));
  fs.writeFileSync(path.join(home, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:alice/dotfiles.git\n');
  assert.equal(resolveProject(path.join(home, "notes"), "").key, "github.com/alice/dotfiles");
  fs.rmSync(path.join(home, ".git"), { recursive: true });
  // No USER/USERNAME (cron, systemd): the home folder's name, as in the Claude Code plugin.
  assert.equal(currentUser({ USERNAME: "winuser" }), "winuser");
  assert.equal(currentUser({}), "");
  delete process.env.USER;
  assert.equal(resolveProject(home, "").key, "home/alice");
});

test("Claude Code: sessions outside git send the folder's project to /context", async () => {
  const srv = await startMockServer();
  try {
    srv.routes.set("/api/context", () => ({ system: "S", recall: "" }));
    srv.routes.set("/api/skills/sync", () => ({ version: "v0", global: [], project: null }));
    const env = { MEMORY_SERVER_URL: srv.url, MEMORY_TIMEOUT_MS: "300", HOME: "/home/dana", USER: "dana" };
    const s = startSession({ env, repo: null, sessionId: "sess-home" });
    await s.emit("session.start", { cwd: "/home/dana", surface: "terminal", isInteractive: true }, (e: any) => ({ cwd: e.cwd }));
    assert.ok(await waitFor(() => srv.requests.some((r) => r.path === "/api/context")));
    assert.deepEqual(srv.requests.find((r) => r.path === "/api/context")!.body.project, { key: "home/dana", name: "dana", remote: null });

    srv.requests.length = 0;
    const elsewhere = startSession({ env, repo: null, sessionId: "sess-tmp" });
    await sessionStart(elsewhere); // cwd /work/app: not a repo, not under home
    assert.ok(await waitFor(() => srv.requests.some((r) => r.path === "/api/context")));
    assert.deepEqual(srv.requests.find((r) => r.path === "/api/context")!.body.project, { key: "path/work/app", name: "app", remote: null });
  } finally {
    await srv.close();
  }
});
