import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { migrate, MIGRATIONS, SCHEMA_VERSION, schemaVersion, type Migration } from "../src/schema.ts";

function fresh(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function tables(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
}

/** The subset of the v0.3.0 schema an old install has: no graph, usage or review tables, no revisions.entities. */
function v03Shape(db: DatabaseSync) {
  db.exec(`
CREATE TABLE projects (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, remote TEXT,
  description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', last_seen_at TEXT);
CREATE TABLE entries (id INTEGER PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('global','user','project')),
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, category TEXT NOT NULL DEFAULT 'fact', title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', deleted_at TEXT, CHECK ((scope = 'project') = (project_id IS NOT NULL)));
CREATE TABLE revisions (id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE, action TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, category TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0,
  author TEXT NOT NULL, turn_id INTEGER, reason TEXT, created_at TEXT NOT NULL DEFAULT '');
CREATE TABLE wiki_jobs (id INTEGER PRIMARY KEY, project_id INTEGER, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL DEFAULT '{}', first_at TEXT NOT NULL DEFAULT '', run_after TEXT NOT NULL DEFAULT '', result TEXT, error TEXT,
  created_at TEXT NOT NULL DEFAULT '', processed_at TEXT);
INSERT INTO entries (id, scope, title, body) VALUES (1, 'global', 'old memory', 'kept across migration');
INSERT INTO revisions (entry_id, action, title, body, category, author) VALUES (1, 'create', 'old memory', 'kept across migration', 'fact', 'human');
INSERT INTO wiki_jobs (kind) VALUES ('sync');
`);
}

describe("schema migrations", () => {
  test("G-024: an empty database is created at the latest version", () => {
    const db = fresh();
    assert.deepEqual(migrate(db), MIGRATIONS.map((m) => m.version));
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    for (const t of ["entries", "revisions", "turns", "wiki_pages", "entities", "entry_links", "entry_usage", "review_jobs", "review_proposals"]) {
      assert.ok(tables(db).includes(t), t);
    }
  });

  test("G-024: running again is a no-op", () => {
    const db = fresh();
    migrate(db);
    assert.deepEqual(migrate(db), []);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
  });

  test("G-024: a pre-versioning (user_version 0) database is adopted and keeps its rows", () => {
    const db = fresh();
    v03Shape(db);
    assert.equal(schemaVersion(db), 0);
    migrate(db);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const e = db.prepare(`SELECT title, body FROM entries WHERE id = 1`).get() as { title: string; body: string };
    assert.equal(e.title, "old memory");
    assert.ok(db.prepare(`SELECT 1 FROM pragma_table_info('revisions') WHERE name = 'entities'`).get());
    assert.equal((db.prepare(`SELECT status FROM wiki_jobs`).get() as { status: string }).status, "skipped");
    assert.ok(tables(db).includes("entry_usage"));
    // FTS built by the baseline indexes rows inserted afterwards.
    db.prepare(`INSERT INTO entries (scope, title, body) VALUES ('global', 'trigram check', 'searchable body')`).run();
    assert.equal((db.prepare(`SELECT count(*) AS n FROM entries_fts WHERE entries_fts MATCH 'searchable'`).get() as { n: number }).n, 1);
    // v2: keywords are indexed (old rows get '[]'), and old rows are still found after the FTS rebuild.
    assert.equal((db.prepare(`SELECT keywords FROM entries WHERE id = 1`).get() as { keywords: string }).keywords, "[]");
    assert.equal((db.prepare(`SELECT count(*) AS n FROM entries_fts WHERE entries_fts MATCH 'migration'`).get() as { n: number }).n, 1);
    db.prepare(`INSERT INTO entries (scope, title, keywords) VALUES ('global', 'kw row', '["capybara"]')`).run();
    assert.equal((db.prepare(`SELECT count(*) AS n FROM entries_fts WHERE entries_fts MATCH 'capybara'`).get() as { n: number }).n, 1);
    // v3
    assert.ok(tables(db).includes("curation_policies"));
  });

  test("G-024: a database written by a newer server is refused, unchanged", () => {
    const db = fresh();
    migrate(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    assert.throws(() => migrate(db), /newer than this server/);
    assert.equal(schemaVersion(db), SCHEMA_VERSION + 1);
  });

  test("G-024: a failing step rolls back and leaves the previous version", () => {
    const db = fresh();
    migrate(db);
    const steps: Migration[] = [
      ...MIGRATIONS,
      { version: SCHEMA_VERSION + 1, name: "adds a table", up: (d) => d.exec(`CREATE TABLE extra_ok (id INTEGER PRIMARY KEY)`) },
      {
        version: SCHEMA_VERSION + 2,
        name: "breaks halfway",
        up: (d) => {
          d.exec(`CREATE TABLE extra_bad (id INTEGER PRIMARY KEY)`);
          throw new Error("boom");
        },
      },
    ];
    assert.throws(() => migrate(db, steps), /migration .* failed: boom/);
    assert.equal(schemaVersion(db), SCHEMA_VERSION + 1);
    assert.ok(tables(db).includes("extra_ok"));
    assert.ok(!tables(db).includes("extra_bad"));
    assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
  });

  test("G-024: a step that leaves broken foreign keys is rejected", () => {
    const db = fresh();
    migrate(db);
    const steps: Migration[] = [
      ...MIGRATIONS,
      { version: SCHEMA_VERSION + 1, name: "orphans", up: (d) => d.exec(`INSERT INTO revisions (entry_id, action, title, body, category, author) VALUES (999, 'create', 't', 'b', 'fact', 'human')`) },
    ];
    assert.throws(() => migrate(db, steps), /broken foreign keys/);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal((db.prepare(`SELECT count(*) AS n FROM revisions`).get() as { n: number }).n, 0);
  });

  test("v5: supersedes links from before the upgrade stop retiring their target; new ones do", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.filter((m) => m.version <= 4));
    db.exec(`INSERT INTO entries (id, scope, title) VALUES (1, 'global', 'old'), (2, 'global', 'new'), (3, 'global', 'x')`);
    db.exec(`INSERT INTO entry_links (from_id, to_id, type, author) VALUES (2, 1, 'supersedes', 'llm'), (3, 2, 'related', 'llm')`);
    migrate(db);
    const rows = db.prepare(`SELECT type, retires FROM entry_links ORDER BY type`).all() as { type: string; retires: number }[];
    assert.deepEqual(rows.map((r) => [r.type, r.retires]), [["related", 1], ["supersedes", 0]]);
    db.exec(`INSERT INTO entry_links (from_id, to_id, type, author) VALUES (3, 1, 'supersedes', 'human')`);
    assert.equal((db.prepare(`SELECT retires FROM entry_links WHERE from_id = 3 AND to_id = 1`).get() as { retires: number }).retires, 1);
  });

  test("v6: entry_turns is backfilled from turn revisions (create→add, update→update), skipping orphans", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.filter((m) => m.version <= 5));
    db.exec(`INSERT INTO entries (id, scope, title) VALUES (1, 'global', 'a'), (2, 'global', 'b')`);
    db.exec(`INSERT INTO turns (id, session_id, payload) VALUES (10, 's', '{}'), (11, 's', '{}')`);
    db.exec(`
INSERT INTO revisions (entry_id, action, title, body, category, author, turn_id, created_at) VALUES
  (1, 'create', 'a', '', 'fact', 'llm', 10, '2026-01-01T00:00:00.000Z'),
  (1, 'update', 'a', '', 'fact', 'llm', 11, '2026-01-02T00:00:00.000Z'),
  (1, 'update', 'a', '', 'fact', 'llm', 11, '2026-01-02T00:00:01.000Z'),
  (2, 'create', 'b', '', 'fact', 'human', NULL, '2026-01-03T00:00:00.000Z'),
  (2, 'delete', 'b', '', 'fact', 'llm', 11, '2026-01-04T00:00:00.000Z')`);
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`INSERT INTO revisions (entry_id, action, title, body, category, author, turn_id) VALUES (2, 'update', 'b', '', 'fact', 'llm', 999)`);
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const got = db.prepare(`SELECT entry_id, turn_id, kind, created_at FROM entry_turns ORDER BY entry_id, turn_id`).all() as Record<string, unknown>[];
    assert.deepEqual(
      got.map((r) => [r.entry_id, r.turn_id, r.kind, r.created_at]),
      [
        [1, 10, "add", "2026-01-01T00:00:00.000Z"],
        [1, 11, "update", "2026-01-02T00:00:00.000Z"],
      ],
    );
    db.exec(`DELETE FROM turns WHERE id = 10`);
    assert.equal((db.prepare(`SELECT count(*) AS n FROM entry_turns`).get() as { n: number }).n, 1, "rows go with the turn");
  });

  test("v8: entities keep their rows and children, and a deleted entity's id is never reused", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.filter((m) => m.version <= 7));
    db.exec(`INSERT INTO entries (id, scope, title) VALUES (1, 'global', 'a')`);
    db.exec(`INSERT INTO entities (id, name, norm, kind) VALUES (1, 'Keep', 'keep', 'tool'), (2, 'Gone', 'gone', 'concept'), (3, 'Top', 'top', 'concept')`);
    db.exec(`INSERT INTO entity_aliases (norm, entity_id) VALUES ('keepold', 1), ('topold', 3)`);
    db.exec(`INSERT INTO entry_entities (entry_id, entity_id) VALUES (1, 1), (1, 3)`);
    db.exec(`INSERT INTO entity_pair_dismissed (a, b) VALUES (1, 3)`);
    db.exec(`DELETE FROM entities WHERE id = 3`);
    migrate(db);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'entities'`).get() as { sql: string }).sql;
    assert.match(sql, /AUTOINCREMENT/);
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_check`).all(), []);
    const ents = db.prepare(`SELECT id, name, norm, kind FROM entities ORDER BY id`).all() as Record<string, unknown>[];
    assert.deepEqual(ents.map((r) => [r.id, r.name, r.norm, r.kind]), [[1, "Keep", "keep", "tool"], [2, "Gone", "gone", "concept"]]);
    assert.deepEqual(db.prepare(`SELECT norm, entity_id FROM entity_aliases`).all().map((r) => [r.norm, r.entity_id]), [["keepold", 1]]);
    db.exec(`DELETE FROM entities WHERE id = 2`);
    const id = Number(db.prepare(`INSERT INTO entities (name, norm) VALUES ('New', 'new')`).run().lastInsertRowid);
    assert.ok(id > 2, `got id ${id}`);
    // Foreign keys still point at the rebuilt table (cascade on delete).
    db.exec(`DELETE FROM entities WHERE id = 1`);
    assert.equal((db.prepare(`SELECT count(*) AS n FROM entity_aliases`).get() as { n: number }).n, 0);
    assert.equal((db.prepare(`SELECT count(*) AS n FROM entry_entities`).get() as { n: number }).n, 0);
  });

  test("G-024: rows orphaned before the upgrade do not block it", () => {
    const db = fresh();
    v03Shape(db);
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`INSERT INTO revisions (entry_id, action, title, body, category, author) VALUES (777, 'create', 'orphan', 'b', 'fact', 'human')`);
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
  });

  test("G-024: a step already applied by another process while waiting for the lock is skipped", () => {
    const db = fresh();
    migrate(db);
    let ran = 0;
    const steps: Migration[] = [
      ...MIGRATIONS,
      {
        version: SCHEMA_VERSION + 1,
        name: "raced",
        up: () => {
          ran++;
        },
      },
    ];
    // Simulate the other process: the version moved on after we computed the pending list.
    const real = db.exec.bind(db);
    let bumped = false;
    (db as unknown as { exec: (sql: string) => void }).exec = (sql: string) => {
      real(sql);
      if (sql === "BEGIN IMMEDIATE" && !bumped) {
        bumped = true;
        real(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      }
    };
    assert.deepEqual(migrate(db, steps), []);
    assert.equal(ran, 0);
  });

  test("v17: v16 skills keep their rows, get a 'create' revision, and the name index only covers live skills", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.filter((m) => m.version <= 16));
    db.exec(`INSERT INTO skills (id, name, description, body, author, updated_at) VALUES (1, 'deploy', 'Deploy', '## steps', 'human', '2026-10-06T00:00:00.000Z')`);
    migrate(db);
    const s = db.prepare(`SELECT status, locked, deleted_at, draft_at FROM skills WHERE id = 1`).get() as Record<string, unknown>;
    assert.deepEqual({ ...s }, { status: "active", locked: 0, deleted_at: null, draft_at: null });
    const revs = db.prepare(`SELECT skill_id, action, name, body, author, created_at FROM skill_revisions`).all().map((r) => ({ ...r }));
    assert.deepEqual(revs, [{ skill_id: 1, action: "create", name: "deploy", body: "## steps", author: "human", created_at: "2026-10-06T00:00:00.000Z" }]);
    db.exec(`UPDATE skills SET deleted_at = 'x' WHERE id = 1`);
    db.exec(`INSERT INTO skills (name, description, body) VALUES ('deploy', 'again', 'b')`); // a trashed name is free
    assert.throws(() => db.exec(`INSERT INTO skills (name, description, body) VALUES ('deploy', 'twice', 'b')`), /UNIQUE/);
  });

  test("G-024: released steps are numbered 1..N without gaps", () => {
    assert.deepEqual(MIGRATIONS.map((m) => m.version), MIGRATIONS.map((_, i) => i + 1));
  });
});
