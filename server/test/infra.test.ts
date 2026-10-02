// Infrastructure guards: G-004 (serial LLM work, turns first), G-007 (project
// key normalization), G-008 (installer URL placeholder), G-011 (erasable TS only).
//
// A small compose chunk size makes a compose job run in several chunks so the
// "turns are curated between chunks" path is reachable. config.ts reads env on
// first import, so everything from the server is imported dynamically below.
process.env.WIKI_COMPOSE_CHUNK_CHARS = "400";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const { call, db, entry, llmCalls, llmDefault, llmReply, llmReset, ok, project, runQueueOnce, turn } = await import("./helpers.ts");
const { enqueueTurn } = await import("../src/turns.ts");
const { normalizeRemote } = await import("../../pi-extension/project.ts");

const here = import.meta.dirname;
const serverSrc = path.resolve(here, "../src");
const extensionDir = path.resolve(here, "../../pi-extension");

type Kind = "curate" | "compose" | "backfill" | "review" | "unknown";
function kindOf(system: string): Kind {
  if (system.startsWith("You are the memory curator")) return "curate";
  if (system.startsWith("You maintain a wiki")) return "compose";
  if (system.startsWith("You build a knowledge graph")) return "backfill";
  if (system.startsWith("You audit a coding agent's long-term memory")) return "review";
  return "unknown";
}

/** Fake LLM that answers every call with an empty result of the right shape. */
function emptyReplies() {
  llmDefault((c: { system: string }) => {
    switch (kindOf(c.system)) {
      case "curate":
        return { ops: [], note: "nothing" };
      case "compose":
        return { pages: [], note: "nothing" };
      case "backfill":
        return { memories: [] };
      case "review":
        return { proposals: [] };
      default:
        return new Error("unexpected LLM call");
    }
  });
}

const kinds = () => llmCalls.map((c) => kindOf(c.system));

// ------------------------------------------------------------------ G-004

test("G-004: a queued turn is curated before already-queued compose, backfill and review jobs", async () => {
  llmReset();
  emptyReplies();
  const p = await project("github.com/test/infra-order", "infra-order");
  // Memories without entities so backfill has work, and >= 2 so review makes a call.
  await entry({ project_id: p.id, title: "deploy uses docker compose", body: "compose file lives in the repo root" });
  await entry({ project_id: p.id, title: "tests run with node --test", body: "type stripping, no build step" });
  // A turn that already exists so compose has something to organize.
  const old = await turn([{ role: "user", text: "the deploy target is a small VM" }, { role: "assistant", text: "ok" }], p, "s-old");
  await runQueueOnce();
  assert.deepEqual(kinds(), ["curate"]);
  assert.equal((await ok("GET", `/turns/${old.id}`)).status, "done");
  llmCalls.length = 0;

  const wjob = await ok("POST", "/wiki/compose", { project_id: p.id, turn_ids: [old.id] });
  const gjob = await ok("POST", "/graph/backfill", { project_id: p.id });
  const rjob = await ok("POST", "/review", { project_id: p.id });
  // Queued last, but must be processed first.
  const fresh = await turn([{ role: "user", text: "remember that staging uses port 9000" }, { role: "assistant", text: "noted" }], p, "s-new");

  await runQueueOnce();
  assert.deepEqual(kinds(), ["curate", "compose", "backfill", "review"]);
  assert.match(llmCalls[0].user, /staging uses port 9000/);

  assert.equal((await ok("GET", `/turns/${fresh.id}`)).status, "done");
  const wstatus = db.prepare(`SELECT status FROM wiki_jobs WHERE id = ?`).get(wjob.id)?.status;
  const gstatus = db.prepare(`SELECT status FROM graph_jobs WHERE id = ?`).get(gjob.id)?.status;
  const rstatus = db.prepare(`SELECT status FROM review_jobs WHERE id = ?`).get(rjob.id)?.status;
  assert.deepEqual([wstatus, gstatus, rstatus], ["done", "done", "done"]);
});

test("G-004: queued turns are curated in id order, one LLM call each", async () => {
  llmReset();
  emptyReplies();
  const p = await project("github.com/test/infra-fifo", "infra-fifo");
  const ids: number[] = [];
  for (const n of [1, 2, 3]) {
    const t = await turn([{ role: "user", text: `ordered turn marker number ${n} please` }, { role: "assistant", text: "ok" }], p, `s-fifo-${n}`);
    ids.push(t.id);
  }
  await runQueueOnce();
  assert.deepEqual(kinds(), ["curate", "curate", "curate"]);
  llmCalls.forEach((c, i) => assert.match(c.user, new RegExp(`ordered turn marker number ${i + 1} please`)));
  const processed = ids.map((id) => String(db.prepare(`SELECT processed_at FROM turns WHERE id = ?`).get(id)?.processed_at));
  assert.deepEqual([...processed].sort(), processed, "processed_at increases with turn id");
});

test("G-004: a turn queued while a multi-chunk compose job runs is curated before the next chunk", async () => {
  llmReset();
  const p = await project("github.com/test/infra-chunks", "infra-chunks");
  emptyReplies();
  const long = "x".repeat(300);
  const a = await turn([{ role: "user", text: `first long turn ${long}` }, { role: "assistant", text: "ok" }], p, "s-chunk-a");
  const b = await turn([{ role: "user", text: `second long turn ${long}` }, { role: "assistant", text: "ok" }], p, "s-chunk-b");
  await runQueueOnce();
  llmCalls.length = 0;

  await ok("POST", "/wiki/compose", { project_id: p.id, turn_ids: [a.id, b.id] });
  let injected: number | null = null;
  // The first compose chunk enqueues a new turn (as the pi extension would mid-job).
  llmReply(() => {
    injected = enqueueTurn({
      sessionId: "s-mid",
      project: { key: p.key, name: p.name },
      client: "test",
      cwd: "/tmp",
      messages: [{ role: "user", text: "mid-compose turn: the cache TTL is 30s" }, { role: "assistant", text: "noted" }],
    } as Parameters<typeof enqueueTurn>[0]).id;
    return { pages: [], note: "chunk 1" };
  });
  await runQueueOnce();
  assert.deepEqual(kinds(), ["compose", "curate", "compose"]);
  assert.match(llmCalls[1].user, /cache TTL is 30s/);
  assert.ok(injected);
  assert.equal((await ok("GET", `/turns/${injected}`)).status, "done");
});

test("G-004: with nothing queued runQueueOnce makes no LLM call", async () => {
  llmReset();
  llmDefault(new Error("must not be called"));
  await runQueueOnce();
  assert.equal(llmCalls.length, 0);
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE status IN ('pending','processing')`).get();
  assert.equal(Number(pending?.n), 0);
});

// ------------------------------------------------------------------ G-007

test("G-007: ssh, scp-style, https, user, port, .git and case variants map to one key", () => {
  const variants = [
    "git@github.com:Foo/Bar.git",
    "git@github.com:foo/bar",
    "https://github.com/foo/bar",
    "https://github.com/Foo/Bar.git",
    "https://u@github.com/foo/bar",
    "https://user:tok@github.com/foo/bar.git",
    "ssh://git@github.com/foo/bar.git",
    "ssh://git@github.com:22/foo/bar.git",
    "git+ssh://git@github.com/foo/bar.git",
    "http://github.com/foo/bar/",
    "  https://github.com/foo/bar.git  \n",
    "github.com:foo/bar.git",
  ];
  for (const v of variants) assert.equal(normalizeRemote(v), "github.com/foo/bar", JSON.stringify(v));
});

test("G-007: nested group paths and non-GitHub hosts keep their full path", () => {
  assert.equal(normalizeRemote("git@gitlab.example.com:Group/Sub/Repo.git"), "gitlab.example.com/group/sub/repo");
  assert.equal(normalizeRemote("https://gitlab.example.com/group/sub/repo.git"), "gitlab.example.com/group/sub/repo");
  assert.equal(normalizeRemote("ssh://git@git.example.org:2222/team/app.git"), "git.example.org/team/app");
});

test("G-007: different repositories stay different keys", () => {
  const keys = new Set(
    ["git@github.com:foo/bar.git", "git@github.com:foo/baz.git", "git@github.com:other/bar.git", "git@gitlab.com:foo/bar.git"].map(normalizeRemote),
  );
  assert.equal(keys.size, 4);
});

test("G-007: a normalized key is stable (normalizing twice changes nothing)", () => {
  for (const v of ["git@github.com:Foo/Bar.git", "ssh://git@github.com:22/foo/bar.git", "https://u@gitlab.example.com/a/b/c.git"]) {
    const k = normalizeRemote(v);
    assert.equal(normalizeRemote(k), k);
  }
});

test("G-007: the server stores the client key as-is, so normalized variants share one project", async () => {
  const k1 = normalizeRemote("git@github.com:Infra/Same.git");
  const k2 = normalizeRemote("https://someone@github.com/infra/same");
  const p1 = await project(k1, "same");
  const p2 = await project(k2, "same");
  assert.equal(p1.id, p2.id);
  assert.equal(p1.key, "github.com/infra/same");
});

// ------------------------------------------------------------------ G-008

function extensionDefaultUrl(): string {
  const src = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf8");
  const m = src.match(/process\.env\.MEMORY_SERVER_URL\s*\?\?\s*"([^"]+)"/);
  assert.ok(m, "pi-extension/index.ts has a MEMORY_SERVER_URL ?? \"...\" default");
  return m[1];
}
function serverReplaceLiteral(): string {
  const src = fs.readFileSync(path.join(serverSrc, "index.ts"), "utf8");
  const m = src.match(/src\.replace\(\s*"([^"]+)"\s*,\s*origin\(/);
  assert.ok(m, "server/src/index.ts replaces a string literal with origin(...)");
  return m[1];
}

test("G-008: the extension's default server URL equals the literal the server replaces", () => {
  assert.equal(serverReplaceLiteral(), extensionDefaultUrl());
});

test("G-008: the placeholder is a plain origin and occurs exactly once in the extension", () => {
  const lit = extensionDefaultUrl();
  assert.equal(new URL(lit).origin, lit, "placeholder has no path or trailing slash");
  const src = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf8");
  assert.equal(src.split(lit).length - 1, 1, "String.replace only swaps the first occurrence");
});

test("G-008: replacing the placeholder like the server does yields the request origin as the default", () => {
  const src = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf8");
  const served = src.replace(serverReplaceLiteral(), new URL("http://memory.example.test:9999/pi-extension/index.ts").origin);
  assert.match(served, /process\.env\.MEMORY_SERVER_URL\s*\?\?\s*"http:\/\/memory\.example\.test:9999"/);
});

// ------------------------------------------------------------------ G-011

const sourceFiles = fs
  .readdirSync(serverSrc)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, src: fs.readFileSync(path.join(serverSrc, f), "utf8") }));

/** Line-based scan for TS syntax that type stripping cannot erase. */
function nonErasable(src: string): string[] {
  const hits: string[] = [];
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    const at = `line ${i + 1}: ${line.trim()}`;
    if (/^\s*(export\s+)?(declare\s+)?(const\s+)?enum\s+[A-Za-z_$][\w$]*\s*\{?/.test(line)) hits.push(`enum ${at}`);
    if (/^\s*(export\s+)?(declare\s+)?(namespace|module)\s+[A-Za-z_$][\w$.]*\s*\{/.test(line)) hits.push(`namespace ${at}`);
    if (/\bimport\s+(type\s+)?[A-Za-z_$][\w$]*\s*=\s*require\s*\(/.test(line)) hits.push(`import-require ${at}`);
    if (/^\s*export\s*=\s*/.test(line)) hits.push(`export= ${at}`);
  });
  // Parameter properties: constructor(private x ..., public readonly y ...)
  for (const m of src.matchAll(/\bconstructor\s*\(([^)]*)\)/g)) {
    if (/(^|[,(\s])(public|private|protected|readonly|override)\s+[A-Za-z_$]/.test(m[1])) hits.push(`parameter property: ${m[0].replace(/\s+/g, " ")}`);
  }
  return hits;
}

/** Relative module specifiers in static imports, re-exports, side-effect imports and dynamic import(). */
function relativeSpecifiers(src: string): string[] {
  const out: string[] = [];
  const res = [/\bfrom\s+["'](\.{1,2}\/[^"']*)["']/g, /\bimport\s+["'](\.{1,2}\/[^"']*)["']/g, /\bimport\s*\(\s*["'](\.{1,2}\/[^"']*)["']/g];
  for (const re of res) for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

test("G-011: the scanner itself flags every forbidden construct", () => {
  const bad = [
    "enum Color { Red }",
    "export const enum Mode { A }",
    "namespace Foo { export const x = 1; }",
    "export declare namespace Bar {",
    'import fs = require("fs");',
    "class A { constructor(private readonly db: Db) {} }",
    "class B { constructor(a: number, public b: string) {} }",
  ];
  for (const s of bad) assert.ok(nonErasable(s).length > 0, s);
  assert.deepEqual(relativeSpecifiers(`import { a } from "./a";\nexport * from "../b.ts";\nimport "./c";\nawait import("./d.js");`), ["./a", "../b.ts", "./c", "./d.js"]);
  assert.deepEqual(nonErasable("class C { constructor(db: Db) {} }\nconst x = { enum: 1 };"), []);
});

test("G-011: server/src has no enum, namespace, parameter property or import = require", () => {
  assert.ok(sourceFiles.length >= 5, "found server sources");
  const hits = sourceFiles.flatMap(({ file, src }) => nonErasable(src).map((h) => `${file} ${h}`));
  assert.deepEqual(hits, []);
});

test("G-011: every relative import in server/src uses a .ts extension and resolves to a file", () => {
  const bad: string[] = [];
  let count = 0;
  for (const { file, src } of sourceFiles) {
    for (const spec of relativeSpecifiers(src)) {
      count++;
      if (!spec.endsWith(".ts")) bad.push(`${file}: ${spec} (no .ts extension)`);
      else if (!fs.existsSync(path.resolve(serverSrc, spec))) bad.push(`${file}: ${spec} (missing file)`);
    }
  }
  assert.ok(count > 10, "relative imports were found");
  assert.deepEqual(bad, []);
});

test("G-011: tsconfig keeps the flags that enforce erasable syntax", () => {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(here, "../tsconfig.json"), "utf8"));
  const o = cfg.compilerOptions;
  assert.equal(o.erasableSyntaxOnly, true);
  assert.equal(o.verbatimModuleSyntax, true);
  assert.equal(o.allowImportingTsExtensions, true);
  assert.equal(o.noEmit, true);
});

test("G-011: the server package runs src/index.ts directly (no build step)", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(here, "../package.json"), "utf8"));
  assert.match(String(pkg.scripts?.start ?? ""), /node\s+.*src\/index\.ts/);
  // Sanity: the health endpoint is served by the in-process API built from these sources.
  assert.equal((await call("GET", "/health")).status, 200);
});
