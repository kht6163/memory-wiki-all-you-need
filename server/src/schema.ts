// Schema and numbered migrations. Kept free of side effects (it never opens a
// database) so tests can run migrate() on a hand-built old-shape database.
//
// The version lives in PRAGMA user_version. Each step runs in its own
// transaction and bumps the version only when it succeeds. Step 1 is the
// baseline: the whole schema as of v0.5.0 written with IF NOT EXISTS, so it
// also adopts databases created before versioning existed (user_version 0 with
// some or all tables already present). Never edit a released step — add a new
// one. A database newer than this code is refused instead of being opened.
import type { DatabaseSync } from "node:sqlite";

const BASELINE = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  remote TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','user','project')),
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'fact',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS entries_scope ON entries(scope, project_id, deleted_at);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, body, tags, content='entries', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO entries_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  author TEXT NOT NULL,
  turn_id INTEGER REFERENCES turns(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS revisions_entry ON revisions(entry_id, id);
CREATE INDEX IF NOT EXISTS revisions_recent ON revisions(id DESC);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  client TEXT,
  cwd TEXT,
  payload TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS turns_status ON turns(status, id);
CREATE INDEX IF NOT EXISTS turns_project ON turns(project_id, id DESC);

-- Wiki: long-form pages written by people, by the agent (wiki_write) and by the
-- LLM when asked to compose pages from turn records. Independent of memory.
-- project_id NULL = the global wiki.
CREATE TABLE IF NOT EXISTS wiki_pages (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  locked INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'llm',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_pages_slug ON wiki_pages(IFNULL(project_id, 0), slug);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  title, body, content='wiki_pages', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS wiki_ai AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO wiki_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS wiki_ad AFTER DELETE ON wiki_pages BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS wiki_au AFTER UPDATE ON wiki_pages BEGIN
  INSERT INTO wiki_fts(wiki_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO wiki_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TABLE IF NOT EXISTS wiki_revisions (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  job_id INTEGER REFERENCES wiki_jobs(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS wiki_revisions_page ON wiki_revisions(page_id, id);

-- Derived on every page write: outgoing [[slug]] links and [#id] memory citations.
CREATE TABLE IF NOT EXISTS wiki_links (
  page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  to_slug TEXT NOT NULL,
  PRIMARY KEY (page_id, to_slug)
);
CREATE TABLE IF NOT EXISTS wiki_citations (
  page_id INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  entry_id INTEGER NOT NULL,
  PRIMARY KEY (page_id, entry_id)
);
CREATE INDEX IF NOT EXISTS wiki_citations_entry ON wiki_citations(entry_id);

-- Wiki work queue. kind 'compose' = the LLM organizes selected turn records
-- into pages. Only started on request (web UI, /wiki-compose); never automatic.
-- (v0.2.0 'write'/'sync' rows are kept as history only.)
CREATE TABLE IF NOT EXISTS wiki_jobs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL DEFAULT '{}',
  first_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  run_after TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS wiki_jobs_status ON wiki_jobs(status, run_after);

-- Which turns have been composed into which wiki (scope 0 = global wiki).
CREATE TABLE IF NOT EXISTS wiki_composed (
  scope INTEGER NOT NULL,
  turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES wiki_jobs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope, turn_id)
);

-- Memory graph. Entities (tech, services, tools, files, concepts) are shared
-- across projects; memories mention them, and memories link to each other
-- with a small set of typed relations. Edges of deleted memories are kept
-- (they come back on restore) but every query filters them out.
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  norm TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'concept',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Other spellings that resolve to an entity (kept when entities are merged or renamed).
CREATE TABLE IF NOT EXISTS entity_aliases (
  norm TEXT PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS entry_entities (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, entity_id)
);
CREATE INDEX IF NOT EXISTS entry_entities_entity ON entry_entities(entity_id);
CREATE TABLE IF NOT EXISTS entry_links (
  from_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('depends_on','because','supersedes','related')),
  author TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (from_id, to_id, type),
  CHECK (from_id != to_id)
);
CREATE INDEX IF NOT EXISTS entry_links_to ON entry_links(to_id);
-- Backfill queue: attach entities/links to existing memories (on request).
CREATE TABLE IF NOT EXISTS graph_jobs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);

-- How often a memory actually helped: recalled into a prompt, or returned to
-- the agent by memory_search / memory_graph. Drives the stable block's order
-- (recently used memories stay in) and the review job's stale detection.
CREATE TABLE IF NOT EXISTS entry_usage (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  recalled INTEGER NOT NULL DEFAULT 0,
  searched INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  -- Last day of use BEFORE the day of last_used_at. Ordering uses this for
  -- memories used today, so today's uses only take effect tomorrow.
  rank_day TEXT,
  -- Last time it was part of the stable block (recorded at most once a day).
  shown_at TEXT
);
-- Memory review: the LLM reads memories cluster by cluster and proposes merges,
-- fixes, deletions and conflicts. Nothing changes until a person applies one.
CREATE TABLE IF NOT EXISTS review_jobs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);
CREATE TABLE IF NOT EXISTS review_proposals (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('merge','update','delete','conflict')),
  entry_ids TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed','stale')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS review_proposals_status ON review_proposals(status, job_id);

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  text, content='turns', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column));
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline (v0.5.0 schema)",
    up(db) {
      db.exec(BASELINE);
      // v0.4.0: revisions also snapshot the memory's entity names (NULL in older rows).
      if (!hasColumn(db, "revisions", "entities")) db.exec(`ALTER TABLE revisions ADD COLUMN entities TEXT`);
      // v0.2.0 memory→wiki write / wiki→memory sync jobs no longer exist.
      db.exec(`UPDATE wiki_jobs SET status = 'skipped', error = 'removed in v0.3.0' WHERE status = 'pending' AND kind IN ('write','sync')`);
    },
  },
  {
    version: 2,
    name: "memory keywords and valid_until",
    up(db) {
      // keywords: other words a memory should be found by (synonyms, translations,
      // spellings). Indexed for search, never injected. valid_until: last day a
      // temporary fact holds (YYYY-MM-DD); after it the memory leaves the prompt.
      db.exec(`
ALTER TABLE entries ADD COLUMN keywords TEXT NOT NULL DEFAULT '[]';
ALTER TABLE entries ADD COLUMN valid_until TEXT;
-- NULL in rows written before this step (revert then keeps the current values).
ALTER TABLE revisions ADD COLUMN keywords TEXT;
ALTER TABLE revisions ADD COLUMN valid_until TEXT;

DROP TRIGGER IF EXISTS entries_ai;
DROP TRIGGER IF EXISTS entries_ad;
DROP TRIGGER IF EXISTS entries_au;
DROP TABLE IF EXISTS entries_fts;
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, body, tags, keywords, content='entries', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body, tags, keywords) VALUES (new.id, new.title, new.body, new.tags, new.keywords);
END;
CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags, keywords) VALUES ('delete', old.id, old.title, old.body, old.tags, old.keywords);
END;
CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags, keywords) VALUES ('delete', old.id, old.title, old.body, old.tags, old.keywords);
  INSERT INTO entries_fts(rowid, title, body, tags, keywords) VALUES (new.id, new.title, new.body, new.tags, new.keywords);
END;
INSERT INTO entries_fts(entries_fts) VALUES ('rebuild');
CREATE INDEX IF NOT EXISTS entry_links_type_to ON entry_links(type, to_id);
`);
    },
  },
  {
    version: 3,
    name: "curation policies",
    up(db) {
      // Human-written rules for the server LLM (what to remember, how to word it).
      // project_id 0 = global policy; project rows are removed with the project.
      db.exec(`
CREATE TABLE curation_policies (
  project_id INTEGER PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
    },
  },
  {
    version: 4,
    name: "dismissed similar-entity pairs",
    up(db) {
      // Pairs a person said are NOT the same thing, so the merge suggestions
      // stop showing them. Stored once with a < b; gone when either entity is.
      db.exec(`
CREATE TABLE entity_pair_dismissed (
  a INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  b INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX entity_pair_dismissed_b ON entity_pair_dismissed(b);
`);
    },
  },
  {
    version: 5,
    name: "supersedes links retire their target",
    up(db) {
      // From v0.6.0 a "supersedes" link takes the old memory out of the prompt
      // (G-026). Before, it was only informational and the curator often kept
      // the old memory valid, so links that already exist do not retire
      // anything; making the link again (person or LLM) turns it on.
      db.exec(`
ALTER TABLE entry_links ADD COLUMN retires INTEGER NOT NULL DEFAULT 1;
UPDATE entry_links SET retires = 0 WHERE type = 'supersedes';
`);
    },
  },
  {
    version: 6,
    name: "turn provenance of memories",
    up(db) {
      // Which turns produced, changed, re-stated (exact duplicate) or confirmed
      // a memory. Rows go with the memory (purge) or the turn (turn delete).
      // Backfilled from revisions written by turns; rows whose turn or memory
      // no longer exists are left out (foreign keys are off during migration).
      db.exec(`
CREATE TABLE entry_turns (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('add','update','confirm','duplicate')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entry_id, turn_id, kind)
);
CREATE INDEX entry_turns_turn ON entry_turns(turn_id);
INSERT OR IGNORE INTO entry_turns (entry_id, turn_id, kind, created_at)
  SELECT entry_id, turn_id, CASE action WHEN 'create' THEN 'add' ELSE 'update' END, created_at
  FROM revisions
  WHERE turn_id IS NOT NULL AND action IN ('create','update')
    AND turn_id IN (SELECT id FROM turns) AND entry_id IN (SELECT id FROM entries)
  ORDER BY id;
`);
    },
  },
  {
    version: 7,
    name: "graph edit history",
    up(db) {
      // Link add/remove and entity update/merge/delete, with enough of the
      // previous state (JSON snapshot) to revert them. See graph-revisions.ts.
      db.exec(`
CREATE TABLE graph_revisions (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('link','entity')),
  action TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  author TEXT NOT NULL,
  reverted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX graph_revisions_created ON graph_revisions(created_at);
`);
    },
  },
  {
    version: 8,
    name: "entity ids are never reused",
    up(db) {
      // graph_revisions snapshots name entities by id, so an id must never be
      // handed to a new entity after its entity was deleted, merged away or
      // pruned (a revert would otherwise land on the wrong entity).
      // AUTOINCREMENT needs a table rebuild; foreign keys are off during
      // migration, and the children (entity_aliases, entry_entities,
      // entity_pair_dismissed) reference "entities" by name, so they follow the
      // renamed table. Copying the explicit ids seeds sqlite_sequence.
      db.exec(`
CREATE TABLE entities_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  norm TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'concept',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO entities_new (id, name, norm, kind, description, created_at, updated_at)
  SELECT id, name, norm, kind, description, created_at, updated_at FROM entities;
DROP TABLE entities;
ALTER TABLE entities_new RENAME TO entities;
`);
    },
  },
  {
    version: 9,
    name: "memory ids are never reused",
    up(db) {
      // Same reason as step 8, for memories: graph_revisions link snapshots,
      // wiki_citations and review proposals name memories by id, so a purged
      // memory's id must not go to a new one (a revert would link an unrelated
      // memory). Columns, checks and defaults are the effective entries DDL
      // after step 2. Dropping entries also drops its index and FTS triggers,
      // so they are made again (latest version, with keywords) and the
      // external-content FTS index is rebuilt. Children (revisions,
      // entry_entities, entry_links, entry_usage, entry_turns) reference
      // "entries" by name and follow the renamed table; foreign keys are off.
      db.exec(`
CREATE TABLE entries_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('global','user','project')),
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'fact',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  keywords TEXT NOT NULL DEFAULT '[]',
  valid_until TEXT,
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
);
INSERT INTO entries_new (id, scope, project_id, category, title, body, tags, pinned, source, created_at, updated_at, deleted_at, keywords, valid_until)
  SELECT id, scope, project_id, category, title, body, tags, pinned, source, created_at, updated_at, deleted_at, keywords, valid_until FROM entries;
DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;
CREATE INDEX entries_scope ON entries(scope, project_id, deleted_at);
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body, tags, keywords) VALUES (new.id, new.title, new.body, new.tags, new.keywords);
END;
CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags, keywords) VALUES ('delete', old.id, old.title, old.body, old.tags, old.keywords);
END;
CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags, keywords) VALUES ('delete', old.id, old.title, old.body, old.tags, old.keywords);
  INSERT INTO entries_fts(rowid, title, body, tags, keywords) VALUES (new.id, new.title, new.body, new.tags, new.keywords);
END;
INSERT INTO entries_fts(entries_fts) VALUES ('rebuild');
`);
      // The copy seeds sqlite_sequence with the largest id still present. A
      // memory purged before this upgrade may still be named elsewhere, so the
      // counter starts above every id any record mentions.
      const mentioned = Number(
        (
          db
            .prepare(
              `SELECT max(
                 IFNULL((SELECT max(id) FROM entries), 0),
                 IFNULL((SELECT max(entry_id) FROM wiki_citations), 0),
                 IFNULL((SELECT max(CAST(j.value AS INTEGER)) FROM graph_revisions g, json_each(g.snapshot, '$.entry_ids') j WHERE json_valid(g.snapshot)), 0),
                 IFNULL((SELECT max(CAST(j.value AS INTEGER)) FROM review_proposals p, json_each(p.entry_ids) j WHERE json_valid(p.entry_ids)), 0)
               ) AS n`,
            )
            .get() as { n: number }
        ).n,
      );
      if (mentioned > 0) {
        const res = db.prepare(`UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'entries'`).run(mentioned);
        if (!res.changes) db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('entries', ?)`).run(mentioned);
      }
    },
  },
  {
    version: 10,
    name: "entity norms keep slashes",
    up(db) {
      // entityNorm() stopped dropping "/" so a directory ("k8s/") and a tool
      // ("k8s") are two entities. The new key is finer than the old one (the
      // old key is the new one without slashes), so distinct rows cannot
      // collide; a row that would anyway keeps its old key and is logged.
      // Mentions already merged under one entity stay merged.
      recomputeEntityNorms(db);
      // Alias rows store only the old key, which never holds a "/" and so is
      // its own new key: nothing to recompute. The spellings behind merge and
      // rename aliases survive in graph_revisions, though, so those get their
      // new key added next to the old one (the old one stays).
      recoverSlashAliases(db);
      // Merge and delete snapshots carry the entity row with its old norm; a
      // revert recreates the entity from it, so it must hold the new key.
      rewriteEntitySnapshots(db);
    },
  },
  {
    version: 11,
    name: "project aliases",
    up(db) {
      // Keys of projects merged into another one (origin renamed or added, see
      // project-merge.ts). A key here resolves to its project and is never
      // created again as a separate project; gone when the project is deleted.
      db.exec(`
CREATE TABLE project_aliases (
  key TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX project_aliases_project ON project_aliases(project_id);
`);
    },
  },
  {
    version: 12,
    name: "project ids are never reused",
    up(db) {
      // Merging deletes the source project, so the largest id is freed far more
      // often than before. wiki_composed.scope, curation_policies and graph job
      // payloads name projects by id without a foreign key, and web links are
      // #/p/<id>: a reused id would inherit another project's "composed" marks or
      // point an old link at a different project. Same rebuild as steps 8 and 9;
      // children (entries, turns, wiki_pages, wiki_jobs, review_jobs,
      // project_aliases) reference "projects" by name; foreign keys are off.
      db.exec(`
CREATE TABLE projects_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  remote TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT
);
INSERT INTO projects_new (id, key, name, remote, description, created_at, updated_at, last_seen_at)
  SELECT id, key, name, remote, description, created_at, updated_at, last_seen_at FROM projects;
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
`);
      // Start above every id a record still names (a project deleted before the upgrade).
      const mentioned = Number(
        (
          db
            .prepare(
              `SELECT max(
                 IFNULL((SELECT max(id) FROM projects), 0),
                 IFNULL((SELECT max(scope) FROM wiki_composed), 0),
                 IFNULL((SELECT max(project_id) FROM curation_policies), 0),
                 IFNULL((SELECT max(CAST(json_extract(payload, '$.projectId') AS INTEGER)) FROM graph_jobs WHERE json_valid(payload)), 0)
               ) AS n`,
            )
            .get() as { n: number }
        ).n,
      );
      if (mentioned > 0) {
        const res = db.prepare(`UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'projects'`).run(mentioned);
        if (!res.changes) db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('projects', ?)`).run(mentioned);
      }
    },
  },
  {
    version: 13,
    name: "dismissed similar-project pairs",
    up(db) {
      // Pairs a person marked as different projects (project-similar.ts), so
      // they are not suggested for merging again. A merge re-points the
      // source's pairs at the target (project-merge.ts, G-060).
      db.exec(`
CREATE TABLE project_pair_dismissed (
  a INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  b INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX project_pair_dismissed_b ON project_pair_dismissed(b);
`);
    },
  },
  {
    version: 14,
    name: "embedding vectors",
    up(db) {
      // One vector per memory / wiki page for semantic search (embeddings.ts,
      // ADR-0034). text_hash covers model + embedded text: a row whose hash no
      // longer matches is re-embedded, and vectors of another model are never compared.
      db.exec(`
CREATE TABLE entry_embeddings (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE wiki_embeddings (
  page_id INTEGER PRIMARY KEY REFERENCES wiki_pages(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
    },
  },
  {
    version: 15,
    name: "wiki page tree",
    up(db) {
      // A page may sit under another page of the same wiki (wiki-tree.ts,
      // ADR-0036). NULL = top level. Deleting the parent row (never done by
      // the app: pages go to the trash) lifts the children to the top level.
      db.exec(`
ALTER TABLE wiki_pages ADD COLUMN parent_id INTEGER REFERENCES wiki_pages(id) ON DELETE SET NULL;
CREATE INDEX wiki_pages_parent ON wiki_pages(parent_id);
`);
    },
  },
];

/**
 * entityNorm() as of step 10, frozen here: schema.ts must not import
 * entities.ts (it opens the database), and a released step must keep
 * computing what it computed. If entityNorm() changes again, add a new step
 * with its own copy (a test checks this copy against entityNorm()).
 */
export function entityNormV10(name: string): string {
  const s = name.normalize("NFKC").replace(/\s+/g, " ").trim();
  const display = (s.replace(/\s+v?\d+(?:\.\d+)*[a-z]?$/i, "") || s).slice(0, 60);
  const norm = display
    .toLowerCase()
    .replace(/^\.\//, "")
    .replace(/[\s._\-]+/g, "")
    .replace(/\/+/g, "/");
  return /.\/.+\/$/.test(norm) ? norm.slice(0, -1) : norm;
}

/** The key entityNorm() made before step 10 (the same, without slashes). */
const entityNormV9 = (name: string) => entityNormV10(name).replace(/\//g, "");

/** Rewrite entities.norm from the name, skipping (and logging) rows whose new key is too short or taken. */
function recomputeEntityNorms(db: DatabaseSync) {
  const rows = db.prepare(`SELECT id, name, norm FROM entities ORDER BY id`).all() as { id: number; name: string; norm: string }[];
  let apply = rows
    .map((r) => ({ id: Number(r.id), norm: String(r.norm), next: entityNormV10(String(r.name)) }))
    .filter((c) => c.next !== c.norm);
  // A changed row may only take a key no kept row (or alias) holds and no
  // other changed row wants; a row that is skipped keeps its old key, which
  // may in turn block another, so repeat until nothing more is skipped.
  const aliases = new Set(db.prepare(`SELECT norm FROM entity_aliases`).all().map((r) => String(r.norm)));
  for (;;) {
    const moving = new Set(apply.map((c) => c.id));
    const kept = new Set(rows.filter((r) => !moving.has(Number(r.id))).map((r) => String(r.norm)));
    const wanted = new Map<string, number>();
    for (const c of apply) wanted.set(c.next, (wanted.get(c.next) ?? 0) + 1);
    const ok = apply.filter((c) => c.next.length >= 2 && !kept.has(c.next) && !aliases.has(c.next) && wanted.get(c.next) === 1);
    for (const c of apply) if (!ok.includes(c)) console.warn(`[db] entities: keeping norm "${c.norm}" (new norm "${c.next}" is too short or already used)`);
    if (ok.length === apply.length) break;
    apply = ok;
  }
  if (!apply.length) return;
  // Two passes so a key moving between rows never hits the UNIQUE index.
  const set = db.prepare(`UPDATE entities SET norm = ? WHERE id = ?`);
  for (const c of apply) set.run(`\u0000${c.norm}`, c.id);
  for (const c of apply) set.run(c.next, c.id);
  console.log(`[db] entities: recomputed ${apply.length} norm(s)`);
}

type Snapshot = Record<string, unknown> & { entity?: { name?: unknown; norm?: unknown }; before?: { name?: unknown }; after?: { name?: unknown } };

function entitySnapshots(db: DatabaseSync, actions: string[]) {
  return (
    db
      .prepare(`SELECT id, snapshot FROM graph_revisions WHERE target = 'entity' AND action IN (${actions.map(() => "?").join(",")}) AND json_valid(snapshot) ORDER BY id`)
      .all(...actions) as { id: number; snapshot: string }[]
  ).map((r) => ({ id: Number(r.id), s: JSON.parse(r.snapshot) as Snapshot }));
}

/**
 * Merges and renames left the old key of a name as an alias. Where that name
 * had a "/", its new key no longer matches the alias; give the entity that
 * owns the old alias now the new key too, unless something else holds it.
 */
function recoverSlashAliases(db: DatabaseSync) {
  const names = new Set<string>();
  for (const { s } of entitySnapshots(db, ["merge", "update"])) {
    for (const n of [s.entity?.name, s.before?.name, s.after?.name]) if (typeof n === "string") names.add(n);
  }
  const owner = db.prepare(`SELECT entity_id FROM entity_aliases WHERE norm = ?`);
  const taken = db.prepare(`SELECT 1 FROM entities WHERE norm = ? UNION ALL SELECT 1 FROM entity_aliases WHERE norm = ?`);
  const add = db.prepare(`INSERT INTO entity_aliases (norm, entity_id) VALUES (?, ?)`);
  let added = 0;
  for (const name of names) {
    const next = entityNormV10(name);
    const old = entityNormV9(name);
    if (next === old || next.length < 2) continue;
    const o = owner.get(old);
    if (!o) continue;
    if (taken.get(next, next)) {
      console.warn(`[db] entity_aliases: not adding "${next}" for entity #${o.entity_id} (already used)`);
      continue;
    }
    add.run(next, Number(o.entity_id));
    added++;
  }
  if (added) console.log(`[db] entity_aliases: added ${added} alias(es) for names with "/"`);
}

/** Put the new key into the entity rows (and merge name aliases) that reverts recreate from. */
function rewriteEntitySnapshots(db: DatabaseSync) {
  const set = db.prepare(`UPDATE graph_revisions SET snapshot = ? WHERE id = ?`);
  let n = 0;
  for (const { id, s } of entitySnapshots(db, ["merge", "delete"])) {
    const e = s.entity;
    if (!e || typeof e.name !== "string") continue;
    const next = entityNormV10(e.name);
    if (e.norm === next && (!("name_alias" in s) || s.name_alias === next)) continue;
    e.norm = next;
    if ("name_alias" in s) s.name_alias = next;
    set.run(JSON.stringify(s), id);
    n++;
  }
  if (n) console.log(`[db] graph_revisions: rewrote ${n} entity snapshot norm(s)`);
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function schemaVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

/**
 * Brings db up to SCHEMA_VERSION. Returns the versions applied. Throws (and
 * changes nothing) if the database was written by a newer server.
 */
export function migrate(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): number[] {
  const latest = migrations[migrations.length - 1].version;
  const current = schemaVersion(db);
  if (current > latest) {
    throw new Error(`database schema version ${current} is newer than this server supports (${latest}); upgrade the server or restore a backup`);
  }
  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return [];
  // Table rebuilds need foreign keys off, and that pragma is a no-op inside a
  // transaction, so it is switched around the whole run.
  const fk = Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys);
  db.exec("PRAGMA foreign_keys = OFF");
  const applied: number[] = [];
  // Rows that were already orphaned before (e.g. deleted by hand with the
  // sqlite3 CLI, where foreign keys are off) are not the step's fault: only
  // violations a step adds fail it.
  const fkKey = (r: Record<string, unknown>) => `${r.table}|${r.rowid}|${r.parent}|${r.fkid}`;
  const before = new Set(db.prepare("PRAGMA foreign_key_check").all().map(fkKey));
  if (before.size) console.warn(`[db] ${before.size} row(s) already have broken foreign keys; migrations leave them as they are`);
  try {
    for (const m of pending) {
      db.exec("BEGIN IMMEDIATE");
      try {
        // Another process may have migrated while we waited for the lock.
        if (schemaVersion(db) >= m.version) {
          db.exec("COMMIT");
          continue;
        }
        m.up(db);
        const broken = db.prepare("PRAGMA foreign_key_check").all().filter((r) => !before.has(fkKey(r)));
        if (broken.length) throw new Error(`migration ${m.version} (${m.name}) left ${broken.length} broken foreign keys`);
        db.exec(`PRAGMA user_version = ${m.version}`);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw new Error(`migration ${m.version} (${m.name}) failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(m.version);
    }
  } finally {
    if (fk) db.exec("PRAGMA foreign_keys = ON");
  }
  return applied;
}
