// Project ids are never reused (step 12): merging deletes the source project, and
// wiki_composed / curation_policies / graph job payloads name projects by id with no
// foreign key, so a reused id would inherit another project's state.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate, MIGRATIONS } from "../src/schema.ts";
import { db, ok, project } from "./helpers.ts";

const n = (d: DatabaseSync, sql: string) => Number((d.prepare(sql).get() as { n: number }).n);

test("G-058: a v11 database keeps its projects and children; the counter starts above ids still named elsewhere", () => {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA foreign_keys = ON");
  migrate(d, MIGRATIONS.filter((m) => m.version <= 11));
  d.exec(`
INSERT INTO projects (id, key, name) VALUES (1, 'github.com/a/one', 'one'), (2, 'github.com/a/two', 'two'), (5, 'github.com/a/five', 'five');
INSERT INTO entries (scope, project_id, title) VALUES ('project', 2, 'kept');
INSERT INTO turns (id, project_id, session_id, payload) VALUES (1, 2, 's', '{}');
INSERT INTO wiki_pages (project_id, slug, title) VALUES (2, 'p', 'P');
INSERT INTO project_aliases (key, project_id) VALUES ('github.com/a/old', 2);
INSERT INTO wiki_composed (scope, turn_id) VALUES (9, 1);
`);
  d.exec(`DELETE FROM projects WHERE id = 5`); // freed before the upgrade
  migrate(d);
  assert.equal(n(d, `SELECT COUNT(*) AS n FROM projects`), 2);
  assert.equal(n(d, `SELECT COUNT(*) AS n FROM entries WHERE project_id = 2`), 1);
  assert.equal(n(d, `SELECT COUNT(*) AS n FROM project_aliases WHERE project_id = 2`), 1);
  assert.equal(d.prepare(`PRAGMA foreign_key_check`).all().length, 0);
  assert.match(String((d.prepare(`SELECT sql FROM sqlite_master WHERE name = 'projects'`).get() as { sql: string }).sql), /AUTOINCREMENT/);
  const id = Number(d.prepare(`INSERT INTO projects (key, name) VALUES ('github.com/a/new', 'new')`).run().lastInsertRowid);
  assert.ok(id > 9, `got ${id}: above the deleted 5 and the wiki_composed scope 9`);
  // Deleting a project still cascades to its children.
  d.exec(`DELETE FROM projects WHERE id = 2`);
  assert.equal(n(d, `SELECT COUNT(*) AS n FROM entries`), 0);
  assert.equal(n(d, `SELECT COUNT(*) AS n FROM project_aliases`), 0);
});

test("G-058: deleting the newest project does not hand its id to the next one; its composed marks go too", async () => {
  const a = await project("github.com/test/pm2-a", "pm2-a");
  db.prepare(`INSERT INTO turns (project_id, session_id, payload) VALUES (?, 's', '{}')`).run(a.id);
  const turnId = Number((db.prepare(`SELECT max(id) AS n FROM turns`).get() as { n: number }).n);
  db.prepare(`INSERT INTO wiki_composed (scope, turn_id) VALUES (?, ?)`).run(a.id, turnId);
  db.prepare(`INSERT INTO turns (session_id, payload) VALUES ('s2', '{}')`).run();
  const other = Number((db.prepare(`SELECT max(id) AS n FROM turns`).get() as { n: number }).n);
  db.prepare(`INSERT INTO wiki_composed (scope, turn_id) VALUES (?, ?)`).run(a.id, other); // a global turn composed into a's wiki
  await ok("DELETE", `/projects/${a.id}`);
  assert.equal(n(db as unknown as DatabaseSync, `SELECT COUNT(*) AS n FROM wiki_composed WHERE scope = ${a.id}`), 0);
  const b = await project("github.com/test/pm2-b", "pm2-b");
  assert.ok(b.id > a.id, `got ${b.id} after deleting ${a.id}`);
});

test("G-058: seeing an existing project again does not use up project ids", async () => {
  const a = await project("github.com/test/pm2-seq", "pm2-seq");
  const seq = () => Number((db.prepare(`SELECT seq AS n FROM sqlite_sequence WHERE name = 'projects'`).get() as { n: number }).n);
  const before = seq();
  for (let i = 0; i < 3; i++) await ok("POST", "/context", { project: { key: "github.com/test/pm2-seq", name: "pm2-seq" }, prompt: "hi" });
  assert.equal(seq(), before, "no id consumed by repeated upserts");
  const b = await project("github.com/test/pm2-seq2", "pm2-seq2");
  assert.equal(b.id, a.id + 1);
});
