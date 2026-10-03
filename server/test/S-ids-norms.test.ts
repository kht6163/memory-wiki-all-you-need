import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { entityNormV10, migrate, MIGRATIONS, SCHEMA_VERSION, schemaVersion } from "../src/schema.ts";
import { entityNorm, resolveEntityId, upsertEntity } from "../src/entities.ts";
import { createEntry, deleteEntry, purgeEntry } from "../src/store.ts";
import { deleteEntity, mergeEntities, revertGraphRevision, updateEntity } from "../src/graph.ts";
import { db as appDb } from "./helpers.ts";

function fresh(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
const n = (db: DatabaseSync, sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
const CHILDREN = ["entries", "revisions", "entry_entities", "entry_links", "entry_usage", "entry_turns", "wiki_citations", "entities", "entity_aliases"];

/** A v8 database (before steps 9 and 10) with a memory in every child table. */
function v8WithData(): DatabaseSync {
  const db = fresh();
  migrate(db, MIGRATIONS.filter((m) => m.version <= 8));
  db.exec(`
INSERT INTO turns (id, session_id, payload) VALUES (1, 's', '{}');
INSERT INTO entries (id, scope, title, body, keywords) VALUES
  (1, 'global', 'deploy freeze', 'no merges on friday', '["capybara"]'),
  (2, 'global', 'kubernetes base', 'manifests live in k8s/', '[]'),
  (3, 'global', 'gone soon', 'purged before the upgrade', '[]');
INSERT INTO revisions (entry_id, action, title, body, category, author, turn_id) VALUES (1, 'create', 'deploy freeze', '', 'fact', 'llm', 1);
INSERT INTO entities (id, name, norm, kind) VALUES (1, 'k8s/', 'k8s', 'file'), (2, 'PostgreSQL', 'postgresql', 'tech'), (3, 'src / api', 'srcapi', 'file');
INSERT INTO entity_aliases (norm, entity_id) VALUES ('postgres', 2);
INSERT INTO entry_entities (entry_id, entity_id) VALUES (1, 2), (2, 1), (2, 3);
INSERT INTO entry_links (from_id, to_id, type, author) VALUES (2, 1, 'related', 'llm'), (2, 3, 'depends_on', 'llm');
INSERT INTO entry_usage (entry_id, recalled) VALUES (1, 3);
INSERT INTO entry_turns (entry_id, turn_id, kind) VALUES (1, 1, 'add');
INSERT INTO wiki_pages (id, slug, title) VALUES (1, 'p', 'P');
INSERT INTO wiki_citations (page_id, entry_id) VALUES (1, 1);
INSERT INTO graph_revisions (target, action, snapshot, author) VALUES ('link', 'remove', '{"entity_ids":[],"entry_ids":[2,3]}', 'human');
`);
  // Purged before the upgrade: the largest id left is 2, but 3 is still named by the link revision.
  db.exec(`DELETE FROM entries WHERE id = 3`);
  return db;
}

describe("S: memory ids are never reused (step 9)", () => {
  test("G-039: a pre-migration database keeps its rows, FTS (with keywords) and foreign keys", () => {
    const db = v8WithData();
    const before = Object.fromEntries(CHILDREN.map((t) => [t, n(db, `SELECT count(*) AS n FROM ${t}`)]));
    migrate(db);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'entries'`).get() as { sql: string }).sql;
    assert.match(sql, /AUTOINCREMENT/);
    assert.match(sql, /keywords TEXT NOT NULL DEFAULT '\[\]'/);
    assert.match(sql, /valid_until TEXT/);
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_check`).all(), []);
    assert.deepEqual(Object.fromEntries(CHILDREN.map((t) => [t, n(db, `SELECT count(*) AS n FROM ${t}`)])), before);
    // Index and the three FTS triggers are back on the new table.
    const objs = db.prepare(`SELECT type, name FROM sqlite_master WHERE tbl_name = 'entries' AND type IN ('index','trigger') ORDER BY name`).all().map((r) => `${r.type}:${r.name}`);
    assert.deepEqual(objs, ["trigger:entries_ad", "trigger:entries_ai", "trigger:entries_au", "index:entries_scope"]);
    assert.ok(!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'entries_new'`).get());
    // Old rows are found by body and by keywords; FTS follows inserts, updates and deletes.
    const hits = (q: string) => db.prepare(`SELECT rowid AS id FROM entries_fts WHERE entries_fts MATCH ? ORDER BY rowid`).all(q).map((r) => Number(r.id));
    assert.deepEqual(hits("capybara"), [1]);
    assert.deepEqual(hits("manifests"), [2]);
    db.exec(`UPDATE entries SET keywords = '["wombat"]' WHERE id = 2`);
    assert.deepEqual(hits("wombat"), [2]);
    const id = Number(db.prepare(`INSERT INTO entries (scope, title, keywords) VALUES ('global', 'new one', '["quokka"]')`).run().lastInsertRowid);
    assert.deepEqual(hits("quokka"), [id]);
    db.exec(`DELETE FROM entries WHERE id = ${id}`);
    assert.deepEqual(hits("quokka"), []);
    db.exec(`INSERT INTO entries_fts(entries_fts) VALUES ('integrity-check')`);
    // Children still cascade from the rebuilt table.
    db.exec(`DELETE FROM entries WHERE id = 1`);
    for (const t of ["revisions", "entry_usage", "entry_turns"]) assert.equal(n(db, `SELECT count(*) AS n FROM ${t}`), 0, t);
    assert.equal(n(db, `SELECT count(*) AS n FROM entry_entities WHERE entry_id = 1`), 0);
  });

  test("G-039: the counter starts above ids that records still name after an earlier purge", () => {
    const db = v8WithData();
    migrate(db);
    // Entry 3 was purged before the upgrade but the link revision names it.
    const id = Number(db.prepare(`INSERT INTO entries (scope, title) VALUES ('global', 'after upgrade')`).run().lastInsertRowid);
    assert.ok(id > 3, `got id ${id}`);
  });

  test("G-039: the counter also starts above ids named only by wiki citations or review proposals", () => {
    const viaCitation = fresh();
    migrate(viaCitation, MIGRATIONS.filter((m) => m.version <= 8));
    viaCitation.exec(`
INSERT INTO entries (id, scope, title) VALUES (1, 'global', 'kept'), (9, 'global', 'cited then purged');
INSERT INTO wiki_pages (id, slug, title) VALUES (1, 'p', 'P');
INSERT INTO wiki_citations (page_id, entry_id) VALUES (1, 9);
DELETE FROM entries WHERE id = 9;
`);
    migrate(viaCitation);
    const a = Number(viaCitation.prepare(`INSERT INTO entries (scope, title) VALUES ('global', 'after')`).run().lastInsertRowid);
    assert.ok(a > 9, `citation: got id ${a}`);

    const viaProposal = fresh();
    migrate(viaProposal, MIGRATIONS.filter((m) => m.version <= 8));
    viaProposal.exec(`
INSERT INTO entries (id, scope, title) VALUES (1, 'global', 'kept'), (7, 'global', 'proposed then purged');
INSERT INTO review_jobs (id) VALUES (1);
INSERT INTO review_proposals (job_id, kind, entry_ids) VALUES (1, 'delete', '[1, 7]'), (1, 'update', 'not json');
DELETE FROM entries WHERE id = 7;
`);
    migrate(viaProposal);
    const b = Number(viaProposal.prepare(`INSERT INTO entries (scope, title) VALUES ('global', 'after')`).run().lastInsertRowid);
    assert.ok(b > 7, `proposal: got id ${b}`);
  });

  test("G-039: an empty database gets the AUTOINCREMENT table too", () => {
    const db = fresh();
    migrate(db);
    assert.match((db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'entries'`).get() as { sql: string }).sql, /AUTOINCREMENT/);
    const a = Number(db.prepare(`INSERT INTO entries (scope, title) VALUES ('global', 'a')`).run().lastInsertRowid);
    db.exec(`DELETE FROM entries WHERE id = ${a}`);
    const b = Number(db.prepare(`INSERT INTO entries (scope, title) VALUES ('global', 'b')`).run().lastInsertRowid);
    assert.ok(b > a);
  });

  test("G-039: purging the newest memory does not hand its id to the next one", () => {
    createEntry({ scope: "global", title: "first" }, { author: "human" });
    const top = createEntry({ scope: "global", title: "newest" }, { author: "human" });
    deleteEntry(top.id, { author: "human" });
    purgeEntry(top.id);
    assert.ok(!appDb.prepare(`SELECT 1 FROM entries WHERE id = ?`).get(top.id));
    const next = createEntry({ scope: "global", title: "unrelated" }, { author: "human" });
    assert.ok(next.id > top.id, `got ${next.id}, purged ${top.id}`);
  });
});

describe("S: entity norms keep slashes (step 10)", () => {
  test("G-040: a path and a name with the same letters are two entities", () => {
    assert.equal(entityNorm("k8s/"), "k8s/");
    assert.equal(entityNorm("k8s"), "k8s");
    assert.equal(entityNorm("src / api"), entityNorm("src/api"));
    assert.equal(entityNorm("./src//api"), "src/api");
    // A trailing "/" only tells a one-part path from a name; on longer paths it is dropped.
    assert.equal(entityNorm("src/api/"), entityNorm("src/api"));
    assert.equal(entityNorm("server/src//"), "server/src");
    assert.equal(entityNorm("/etc/"), "/etc/");
    assert.equal(entityNorm("Docker-Compose"), entityNorm("docker compose"));
    const dir = upsertEntity({ name: "k8s/", kind: "file" });
    const tool = upsertEntity({ name: "k8s", kind: "tech" });
    assert.ok(dir && tool);
    assert.notEqual(dir, tool);
    assert.equal(resolveEntityId("K8s/"), dir);
    assert.equal(resolveEntityId("k8s"), tool);
  });

  test("G-040: the step's frozen copy matches entityNorm()", () => {
    for (const s of ["k8s/", "k8s", "src / api", "./src//api/", "src/api/", "k8s//", "/etc/", "a/b/c/", "PostgreSQL 16", "Docker-Compose", "server/src/db.ts", "CI/CD", " a ", "세션 캐시", "Ｋ８Ｓ／"]) {
      assert.equal(entityNormV10(s), entityNorm(s), s);
    }
  });

  test("G-040: migration recomputes entity norms and leaves plain aliases alone; old path entities still resolve", () => {
    const db = v8WithData();
    db.exec(`INSERT INTO entity_aliases (norm, entity_id) VALUES ('kube', 1)`);
    db.exec(`INSERT INTO entities (id, name, norm, kind) VALUES (4, 'server/src/', 'serversrc', 'file')`);
    migrate(db);
    const norms = db.prepare(`SELECT id, norm FROM entities ORDER BY id`).all().map((r) => [Number(r.id), String(r.norm)]);
    assert.deepEqual(norms, [[1, "k8s/"], [2, "postgresql"], [3, "src/api"], [4, "server/src"]]);
    assert.deepEqual(db.prepare(`SELECT norm, entity_id FROM entity_aliases ORDER BY norm`).all().map((r) => [r.norm, r.entity_id]), [["kube", 1], ["postgres", 2]]);
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_check`).all(), []);
    // The path entity is found by its path spelling, and "k8s" is free for a new entity.
    const resolve = (name: string) => db.prepare(`SELECT id FROM entities WHERE norm = ?`).get(entityNorm(name))?.id;
    assert.equal(resolve("k8s/"), 1);
    assert.equal(resolve("src/api"), 3);
    assert.equal(resolve("server/src"), 4);
    assert.equal(resolve("server/src/"), 4);
    assert.equal(resolve("k8s"), undefined);
    db.prepare(`INSERT INTO entities (name, norm, kind) VALUES ('k8s', ?, 'tech')`).run(entityNorm("k8s"));
  });

  test("G-040: a row whose new norm is taken keeps its old one instead of failing", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.filter((m) => m.version <= 9));
    // Not reachable through entityNorm (old norms never contain "/"), written by hand.
    db.exec(`INSERT INTO entities (id, name, norm) VALUES (1, 'a/b', 'a/b'), (2, 'a/ b', 'ab')`);
    const warn = console.warn;
    console.warn = () => {};
    try {
      migrate(db);
    } finally {
      console.warn = warn;
    }
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.deepEqual(db.prepare(`SELECT id, norm FROM entities ORDER BY id`).all().map((r) => [r.id, r.norm]), [[1, "a/b"], [2, "ab"]]);
  });

  // The cases below run step 10 on the app database after putting rows back
  // in their pre-upgrade shape (old norms without "/"), then revert through graph.ts.
  const step10 = MIGRATIONS.find((m) => m.version === 10)!;
  const quiet = (fn: () => void) => {
    const [log, warn] = [console.log, console.warn];
    console.log = console.warn = () => {};
    try {
      fn();
    } finally {
      [console.log, console.warn] = [log, warn];
    }
  };
  const lastRevision = () => appDb.prepare(`SELECT id, snapshot FROM graph_revisions ORDER BY id DESC LIMIT 1`).get() as { id: number; snapshot: string };
  /** Make a revision snapshot look like one written before step 10. */
  const oldSnapshot = (id: number, edit: (s: any) => void) => {
    const s = JSON.parse(String((appDb.prepare(`SELECT snapshot FROM graph_revisions WHERE id = ?`).get(id) as { snapshot: string }).snapshot));
    edit(s);
    appDb.prepare(`UPDATE graph_revisions SET snapshot = ? WHERE id = ?`).run(JSON.stringify(s), id);
  };

  test("G-040: restoring an entity deleted before the upgrade uses the new key", () => {
    const dir = upsertEntity({ name: "helm/", kind: "file" })!;
    deleteEntity(dir);
    const rev = lastRevision().id;
    oldSnapshot(rev, (s) => (s.entity.norm = "helm"));
    quiet(() => step10.up(appDb));
    assert.equal(JSON.parse(lastRevision().snapshot).entity.norm, "helm/");
    // A tool with the plain name, made after the upgrade, is a different entity.
    const tool = upsertEntity({ name: "helm", kind: "tech" })!;
    revertGraphRevision(rev);
    assert.equal(resolveEntityId("helm/"), dir);
    assert.equal(resolveEntityId("helm"), tool);
    assert.equal(upsertEntity({ name: "helm/", kind: "file" }), dir);
  });

  test("G-040: a merge made before the upgrade still resolves the merged path, and reverts", () => {
    const from = upsertEntity({ name: "lib/core", kind: "file" })!;
    const into = upsertEntity({ name: "core-lib", kind: "tech" })!;
    mergeEntities(from, into);
    const rev = lastRevision().id;
    // Before the upgrade the merge stored the slashless key.
    appDb.prepare(`UPDATE entity_aliases SET norm = 'libcore' WHERE norm = 'lib/core'`).run();
    oldSnapshot(rev, (s) => {
      s.entity.norm = "libcore";
      s.name_alias = "libcore";
    });
    quiet(() => step10.up(appDb));
    assert.equal(resolveEntityId("lib/core"), into, "merged path resolves to the target");
    assert.equal(resolveEntityId("lib core"), into, "old alias kept");
    const s = JSON.parse(lastRevision().snapshot);
    assert.equal(s.entity.norm, "lib/core");
    assert.equal(s.name_alias, "lib/core");
    revertGraphRevision(rev);
    assert.equal(resolveEntityId("lib/core"), from);
  });

  test("G-040: a rename made before the upgrade still resolves the old path; taken keys are skipped", () => {
    const id = upsertEntity({ name: "web/app", kind: "file" })!;
    updateEntity(id, { name: "frontend" });
    appDb.prepare(`UPDATE entity_aliases SET norm = 'webapp' WHERE norm = 'web/app'`).run();
    // Another renamed path whose new key already belongs to a different entity.
    const other = upsertEntity({ name: "web/api", kind: "file" })!;
    const renamed = upsertEntity({ name: "old/name", kind: "file" })!;
    updateEntity(renamed, { name: "new-name" });
    appDb.prepare(`UPDATE entity_aliases SET norm = 'oldname' WHERE norm = 'old/name'`).run();
    appDb.prepare(`UPDATE entities SET name = 'old/name', norm = 'old/name' WHERE id = ?`).run(other);
    quiet(() => step10.up(appDb));
    assert.equal(resolveEntityId("web/app"), id);
    assert.equal(resolveEntityId("web app"), id);
    assert.equal(resolveEntityId("old/name"), other, "a key another entity holds is not taken over");
    assert.equal(resolveEntityId("old name"), renamed);
  });
});
