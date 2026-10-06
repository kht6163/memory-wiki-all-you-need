import { ApiError } from "./errors.ts";

export type Scope = "global" | "user" | "project";
export type Source = "agent" | "llm" | "human";
/** Wiki compose / graph backfill / review job status. "cancelled" jobs can be resumed with retry. */
export type JobStatus = "pending" | "processing" | "done" | "skipped" | "error" | "cancelled";

export interface Project {
  id: number;
  key: string;
  name: string;
  remote: string | null;
  description: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  entry_count?: number;
  turn_count?: number;
  /** Older keys that now resolve to this project (merged-away projects). GET /projects/:id only. */
  aliases?: string[];
}

/** What a project merge moves (preview and result share the shape). */
export interface MergeCounts {
  entries: number;
  turns: number;
  wiki_pages: number;
  wiki_jobs: number;
  review_jobs: number;
  review_proposals_pending: number;
  skills: number;
}

/** Same skill name in both projects: the source skill is renamed to new_name. */
export interface SkillMergeConflict {
  name: string;
  source_skill_id: number;
  new_name: string;
}

/** Same slug in both wikis: the source page is renamed to new_slug. */
export interface MergeConflict {
  slug: string;
  source_page_id: number;
  target_page_id: number;
  new_slug: string;
}

export type ProjectRef = { id: number; key: string; name: string };

export interface MergePreview {
  source: ProjectRef;
  target: ProjectRef;
  counts: MergeCounts;
  wiki_conflicts: MergeConflict[];
  skill_conflicts: SkillMergeConflict[];
  /** Which curation policy the target keeps ("both": target's, with the source's appended). */
  policy: "target" | "source" | "both" | "none";
  description: "target" | "source" | "none";
  /** Keys that resolve to the target afterwards. */
  aliases: string[];
}

export interface MergeResult {
  target: Project;
  moved: MergeCounts;
  wiki_conflicts: MergeConflict[];
  skill_conflicts: SkillMergeConflict[];
  aliases: string[];
}

export interface Entry {
  id: number;
  scope: Scope;
  project_id: number | null;
  category: string;
  title: string;
  body: string;
  tags: string[];
  /** Search-only words (synonyms, translations). Never injected. */
  keywords: string[];
  /** Last day (YYYY-MM-DD) a temporary fact holds. */
  valid_until: string | null;
  pinned: boolean;
  source: Source;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** Live memory that replaced this one (it is history, not injected). Present on API lists/details. */
  superseded_by?: number | null;
  /** valid_until has passed (history, not injected). */
  expired?: boolean;
  score?: number;
}

export interface Revision {
  id: number;
  entry_id: number;
  action: "create" | "update" | "delete" | "restore";
  title: string;
  body: string;
  category: string;
  tags: string[];
  pinned: boolean;
  author: Source;
  turn_id: number | null;
  reason: string | null;
  /** Entity names at this revision (null before v0.4.0). */
  entities?: string[] | null;
  /** Null before v0.6.0. */
  keywords?: string[] | null;
  valid_until?: string | null;
  created_at: string;
}

export interface ActivityItem extends Revision {
  entry_scope: Scope;
  entry_project_id: number | null;
  project_name: string | null;
}

export interface TurnSummary {
  id: number;
  project_id: number | null;
  project_name: string | null;
  session_id: string;
  client: string | null;
  status: "pending" | "processing" | "done" | "skipped" | "error";
  error: string | null;
  created_at: string;
  processed_at: string | null;
  prompt: string;
  applied: { op: string; entryId: number; title: string }[];
  note: string | null;
}

export interface TurnMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: { name: string; args: string }[];
  name?: string;
  isError?: boolean;
}

export interface TurnDetail extends Omit<TurnSummary, "prompt" | "applied" | "note" | "project_name"> {
  cwd: string | null;
  payload: { messages: TurnMessage[] };
  result: {
    ops: unknown[];
    applied: TurnSummary["applied"];
    /** Ops dropped on purpose, e.g. an add identical to an existing memory. */
    skipped?: { op: string; title: string; reason: string; entryId?: number }[];
    /** valid_until the server took from a deadline in the body (the LLM left it empty). */
    inferred?: { op: string; entryId: number; title: string; valid_until: string; from: "body" }[];
    note?: string;
    model?: string;
    ms?: number;
  } | null;
  project: Project | null;
}

export interface SessionHit {
  id: number;
  project_id: number | null;
  project_name: string | null;
  session_id: string;
  created_at: string;
  snippet: string;
}

/** Debug mode (ADR-0035): the switch, where day files go and which exist. */
export interface DebugInfo {
  enabled: boolean;
  source: "env" | "file" | "default";
  dir: string;
  keepDays: number;
  maxMbPerDay: number;
  files: { date: string; bytes: number }[];
}

/** An agent skill (ADR-0039): mirrored one way to each PC by the pi extension. project_id null = global. */
export interface Skill {
  id: number;
  project_id: number | null;
  name: string;
  description: string;
  body: string;
  /** Who wrote the current version: human | agent. */
  author: string;
  /** candidate = an agent skill waiting for approval; PCs do not get it (ADR-0040). */
  status: "active" | "candidate";
  /** Only people may change it. */
  locked: boolean;
  /** In the trash. */
  deleted_at: string | null;
  /** An agent edit waiting for approval; the approved content stays in use meanwhile. */
  draft: { description: string; body: string; at: string } | null;
  created_at: string;
  updated_at: string;
}

/** A skill's content after one write (ADR-0040). */
export interface SkillRevision {
  id: number;
  skill_id: number;
  /** create | update | delete | restore | revert | lock | unlock | propose | approve | reject */
  action: string;
  name: string;
  description: string;
  body: string;
  author: string;
  reason: string | null;
  created_at: string;
}

/** Which agent skill writes wait for a person (ADR-0040). */
export type SkillApproval = "off" | "global" | "all";

/** Feature switches (ADR-0038): env-fixed ones cannot be changed from the web. */
export interface SwitchState {
  enabled: boolean;
  source: "env" | "file" | "default";
}
export interface Settings {
  /** The server LLM organizing turn records into wiki pages. */
  wikiCompose: SwitchState;
  /** Agent skill writes that wait for approval; set on the web only (default "global"). */
  skillApproval: { value: SkillApproval; source: "file" | "default" };
}

export interface Stats {
  /** Debug mode is on (the server is writing day files). */
  debug: boolean;
  /** Turn-record compose is on (off: compose entry points hidden, queued jobs wait). */
  wikiCompose: boolean;
  /** Skills on the server (all scopes). */
  skills: number;
  /** Global skills only. */
  globalSkills: number;
  /** Agent skills and edits waiting for approval (all scopes). */
  skillsPending: number;
  reviewProposals: number;
  reviewRunning: number;
  entities: number;
  links: number;
  unlinked: number;
  graphPending: number;
  entries: number;
  projects: number;
  turns: number;
  pending: number;
  errors: number;
  trash: number;
  pages: number;
  wikiPending: number;
  wikiErrors: number;
  /** Embedding model, or null when semantic search is off. */
  embed: string | null;
  /** Memories and wiki pages still waiting for a vector. */
  embedPending: number;
  /** Texts the embedding endpoint refused (skipped until they change). */
  embedSkipped: number;
  embedError: string | null;
}

export interface WikiPage {
  id: number;
  project_id: number | null;
  slug: string;
  title: string;
  body: string;
  locked: boolean;
  source: Source;
  /** Page this one sits under (null = top level). */
  parent_id: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** A suggested parent for a flat page (ADR-0036). */
export interface TreeSuggestion {
  page: { id: number; slug: string; title: string };
  parent: { id: number; slug: string; title: string };
  reason: "continuation" | "index";
}

export interface WikiRevision {
  id: number;
  page_id: number;
  action: "create" | "update" | "delete" | "restore";
  title: string;
  body: string;
  author: Source;
  job_id: number | null;
  reason: string | null;
  created_at: string;
}

export interface WikiJob {
  id: number;
  project_id: number | null;
  project_name: string | null;
  /** write/sync: v0.2.0 history rows only. */
  kind: "compose" | "write" | "sync";
  status: JobStatus;
  payload: { turns?: number[]; instruction?: string; entries?: number[] };
  first_at: string;
  run_after: string;
  result: {
    applied?: { action?: string; op?: string; slug?: string; title: string; pageId?: number; entryId?: number }[];
    note?: string;
    notes?: string[];
    done?: number[];
    chunks?: number;
    ms?: number;
  } | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface WikiHit extends Omit<WikiPage, "body"> {
  snippet: string;
  score: number;
}

export interface ComposeTurn {
  id: number;
  project_id: number | null;
  project_name: string | null;
  session_id: string;
  created_at: string;
  prompt: string;
  chars: number;
  composed_at: string | null;
}

export type LinkType = "depends_on" | "because" | "supersedes" | "related";

export interface Entity {
  id: number;
  name: string;
  kind: string;
  description: string;
  created_at: string;
  updated_at: string;
  count?: number;
  aliases?: string[];
}

export interface EntryLink {
  from_id: number;
  to_id: number;
  type: LinkType;
  author: Source;
  created_at: string;
  dir: "out" | "in";
  other: { id: number; title: string; category: string; scope: string };
}

export type GraphNode =
  | { id: string; type: "memory"; entryId: number; label: string; category: string; scope: string; projectId: number | null }
  | { id: string; type: "entity"; entityId: number; label: string; kind: string; count: number };

export interface GraphData {
  nodes: GraphNode[];
  edges: { id: string; source: string; target: string; type: LinkType | "mentions" }[];
  truncated: boolean;
  unlinked: number;
}

export interface GraphJob {
  id: number;
  status: JobStatus;
  payload: { entries: number[]; projectId?: number | null };
  result: { done?: number[]; chunks?: number; entities?: number; links?: number; ms?: number } | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface Usage {
  recalled: number;
  searched: number;
  last_used_at: string | null;
  shown_at: string | null;
}

/** Turns whose curation added, changed or reaffirmed a memory (newest first). */
export interface Provenance {
  count: number;
  last_at: string | null;
  recent: { turn_id: number; kind: "add" | "update" | "confirm" | "duplicate"; created_at: string; session_id: string | null }[];
}

/**
 * One memory-graph edit. link: add | remove; entity: update | merge | delete, and
 * unmerge | restore (written by reverting a merge / delete; revertible too since v0.6.5).
 * Whether one can be reverted now is in revertible / blocked. A revert's own row carries
 * snapshot.revert_of. Snapshot shape depends on target/action (see server/src/graph.ts).
 */
export interface GraphRevision {
  id: number;
  target: "link" | "entity";
  action: string;
  snapshot: Record<string, any>;
  author: Source;
  created_at: string;
  reverted_at: string | null;
  /** False when already reverted, never revertible, or `blocked`. */
  revertible: boolean;
  /** Why a revert would fail now (a memory of the link purged, an entity name taken, …); the button is disabled. */
  blocked: {
    code:
      | "endpoint_purged"
      | "endpoint_replaced"
      | "endpoint_trashed"
      | "link_exists"
      | "link_gone"
      | "link_not_retiring"
      | "supersedes_cycle"
      | "cross_project"
      | "name_taken"
      | "name_moved"
      | "merge_target_gone"
      | "nothing_to_revert"
      | "entity_gone";
    entry_id?: number;
    entity_id?: number;
    /** HTTP status the revert answers with (default 409; cross_project 400; endpoint_trashed / entity_gone 404). */
    status?: number;
    message: string;
  } | null;
}

export interface ReviewJob {
  id: number;
  project_id: number | null;
  project_name: string | null;
  status: JobStatus;
  payload: { entries: number[]; scheduled?: boolean };
  result: {
    done?: number[];
    chunks?: number;
    proposals?: number;
    ms?: number;
    /** Global/user memories shown read-only to a project review (G-055). */
    cross_scope?: number;
    /** Memories longer than the review LLM is shown (first 50 ids, and the count) (G-056). */
    truncated?: number[];
    truncated_count?: number;
  } | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface ProposalEdit {
  old: string;
  new: string;
}

export interface Proposal {
  id: number;
  job_id: number;
  kind: "merge" | "update" | "delete" | "conflict";
  entry_ids: number[];
  data: {
    title?: string;
    body?: string;
    category?: string;
    note?: string;
    snap: Record<string, string>;
    /** Exact-substring edits of the body (update proposals), applied together; each `old` occurs once. */
    edits?: ProposalEdit[];
    /** Legacy single edit (proposals written before v0.6.1); still applied. */
    edit?: ProposalEdit;
    /** New full entity name list (update proposals), a subset of the memory's current names. Absent = keep. */
    entities?: string[];
    /** Server-side caution in Korean (e.g. a delete of a memory holding a decision's reason). */
    warning?: string;
    /** A REFERENCE (global/user) memory this proposal relies on or contradicts, and its version then (G-055). */
    covered_by?: number;
    covered_snap?: string;
  };
  reason: string;
  status: "pending" | "applied" | "dismissed" | "stale";
  created_at: string;
  decided_at: string | null;
  entries: ((Entry & { entities: string[]; changed: boolean }) | null)[];
  /** The memory data.covered_by names, as it is now (changed = no longer the version the LLM saw). */
  covered_by_entry?: (Entry & { changed: boolean }) | null;
}

export type PageRef = { id: number; slug: string; title: string; project_id?: number | null };

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export interface Policy {
  project_id: number | null;
  text: string;
  updated_at: string | null;
}

export interface SimilarPair {
  a: { id: number; name: string; kind: string; count: number };
  b: { id: number; name: string; kind: string; count: number };
  score: number;
  reasons: ("name" | "contains" | "cooccur")[];
  /** Suggested direction: merge `from` into `into` (the more-mentioned one). */
  merge: { from: number; into: number };
}

export type ProjectSimilarReason = "folder" | "local" | "name" | "entities";
export interface SimilarProjectPair {
  a: { id: number; key: string; name: string; last_seen_at: string | null; entry_count: number };
  b: { id: number; key: string; name: string; last_seen_at: string | null; entry_count: number };
  score: number;
  reasons: ProjectSimilarReason[];
  shared_entities: number;
  /** Suggested direction: merge `from` into `into` (the one seen most recently keeps its key). */
  merge: { from: number; into: number };
}

export interface WikiLint {
  orphans: { id: number; slug: string; title: string }[];
  missing: { slug: string; from: { id: number; slug: string; title: string }[] }[];
  citations: { page: { id: number; slug: string; title: string }; entry_id: number; state: "deleted" | "purged" | "superseded" | "expired"; superseded_by?: number }[];
  empty: { id: number; slug: string; title: string }[];
  counts: { orphans: number; missing: number; citations: number; empty: number };
}

export const api = {
  meta: () => request<{ categories: string[]; llm: string | null }>("GET", "/meta"),
  stats: () => request<Stats>("GET", "/stats"),
  debug: () => request<DebugInfo>("GET", "/debug"),
  setDebug: (enabled: boolean) => request<DebugInfo>("PUT", "/debug", { enabled }),
  settings: () => request<Settings>("GET", "/settings"),
  skills: (project_id: number | null, opts: { deleted?: boolean } = {}) =>
    request<Skill[]>("GET", `/skills${qs({ project_id: project_id ?? 0, deleted: opts.deleted ? 1 : undefined })}`),
  /** Live skills of every scope. */
  allSkills: () => request<Skill[]>("GET", "/skills"),
  skill: (id: number) => request<Skill>("GET", `/skills/${id}`),
  createSkill: (s: { project_id: number | null; name: string; description: string; body: string }) => request<Skill>("POST", "/skills", s),
  updateSkill: (id: number, patch: { name?: string; description?: string; body?: string; locked?: boolean }) => request<Skill>("PATCH", `/skills/${id}`, patch),
  deleteSkill: (id: number) => request<Skill>("DELETE", `/skills/${id}`),
  skillRevisions: (id: number) => request<SkillRevision[]>("GET", `/skills/${id}/revisions`),
  revertSkill: (id: number, revision_id: number) => request<Skill>("POST", `/skills/${id}/revert`, { revision_id }),
  restoreSkill: (id: number) => request<Skill>("POST", `/skills/${id}/restore`),
  purgeSkill: (id: number) => request<Skill>("DELETE", `/skills/${id}/purge`),
  /** `seen`: the versions on screen; anything newer is 409 (never approved unseen). */
  approveSkill: (id: number, seen: { updated_at: string; draft_at?: string }) => request<Skill>("POST", `/skills/${id}/approve`, seen),
  rejectSkill: (id: number, seen: { updated_at: string; draft_at?: string }) => request<Skill>("POST", `/skills/${id}/reject`, seen),
  setSettings: (patch: { wikiCompose?: boolean; skillApproval?: SkillApproval }) => request<Settings>("PUT", "/settings", patch),
  projects: () => request<Project[]>("GET", "/projects"),
  project: (id: number) => request<Project>("GET", `/projects/${id}`),
  updateProject: (id: number, patch: Partial<Pick<Project, "name" | "description">>) => request<Project>("PATCH", `/projects/${id}`, patch),
  deleteProject: (id: number) => request("DELETE", `/projects/${id}`),
  mergePreview: (id: number, into: number) => request<MergePreview>("GET", `/projects/${id}/merge-preview${qs({ into })}`),
  mergeProject: (id: number, into: number) => request<MergeResult>("POST", `/projects/${id}/merge`, { into }),
  similarProjects: (limit = 50) => request<SimilarProjectPair[]>("GET", `/projects/similar${qs({ limit })}`),
  dismissSimilarProjects: (a: number, b: number) => request<{ ok: true }>("POST", "/projects/similar/dismiss", { a, b }),
  entries: (f: { scope?: Scope; project_id?: number; category?: string; deleted?: boolean }) =>
    request<Entry[]>("GET", `/entries${qs({ ...f, deleted: f.deleted ? 1 : undefined })}`),
  entry: (id: number) =>
    request<{
      entry: Entry;
      project: Project | null;
      revisions: Revision[];
      citedBy: PageRef[];
      entities: Entity[];
      links: EntryLink[];
      usage: Usage;
      provenance: Provenance;
    }>(
      "GET",
      `/entries/${id}`,
    ),
  createEntry: (e: Partial<Entry> & { entities?: string[] }) => request<Entry>("POST", "/entries", e),
  updateEntry: (id: number, patch: Partial<Entry> & { entities?: string[] }) => request<Entry>("PATCH", `/entries/${id}`, patch),
  addLink: (id: number, to: number, type: LinkType) => request<EntryLink[]>("POST", `/entries/${id}/links`, { to, type }),
  removeLink: (id: number, to: number, type: LinkType) => request<EntryLink[]>("DELETE", `/entries/${id}/links${qs({ to, type })}`),
  graph: (project_id?: number) => request<GraphData>("GET", `/graph${qs({ project_id })}`),
  entities: (q?: string, project_id?: number) => request<Entity[]>("GET", `/entities${qs({ q, project_id })}`),
  entity: (id: number) => request<{ entity: Entity; memories: (Entry & { project_name: string | null })[] }>("GET", `/entities/${id}`),
  updateEntity: (id: number, patch: Partial<Pick<Entity, "name" | "kind" | "description">>) => request<Entity>("PATCH", `/entities/${id}`, patch),
  mergeEntity: (id: number, into: number) => request<Entity>("POST", `/entities/${id}/merge`, { into }),
  deleteEntity: (id: number) => request("DELETE", `/entities/${id}`),
  backfill: (project_id?: number, all = false) => request<GraphJob>("POST", "/graph/backfill", { project_id, all }),
  graphRevisions: (f: { entity_id?: number; entry_id?: number; limit?: number } = {}) => request<GraphRevision[]>("GET", `/graph/revisions${qs(f)}`),
  revertGraphRevision: (id: number) => request<{ revision: GraphRevision; revert: GraphRevision | null }>("POST", `/graph/revisions/${id}/revert`),
  graphJobs: () => request<GraphJob[]>("GET", "/graph/jobs"),
  startReview: (project_id?: number) => request<ReviewJob>("POST", "/review", { project_id }),
  reviewJobs: (project_id?: number) => request<ReviewJob[]>("GET", `/review/jobs${qs({ project_id: project_id ?? 0 })}`),
  reviewScope: (project_id?: number) => request<{ entries: number; unlinked: number; staleDays: number; maxEntries: number }>("GET", `/review/scope${qs({ project_id })}`),
  retryReviewJob: (id: number) => request<ReviewJob>("POST", `/review/jobs/${id}/retry`),
  proposals: (project_id: number | undefined, status = "pending") =>
    request<Proposal[]>("GET", `/review/proposals${qs({ project_id: project_id ?? 0, status })}`),
  applyProposal: (id: number) => request<Proposal>("POST", `/review/proposals/${id}/apply`),
  dismissProposal: (id: number) => request<Proposal>("POST", `/review/proposals/${id}/dismiss`),
  staleEntries: (project_id?: number, days?: number) => request<(Entry & { last_used_at: string | null })[]>("GET", `/review/stale${qs({ project_id, days })}`),
  retryGraphJob: (id: number) => request<GraphJob>("POST", `/graph/jobs/${id}/retry`),
  deleteEntry: (id: number) => request<Entry>("DELETE", `/entries/${id}`),
  restoreEntry: (id: number) => request<Entry>("POST", `/entries/${id}/restore`),
  purgeEntry: (id: number) => request("DELETE", `/entries/${id}/purge`),
  revertEntry: (id: number, revisionId: number) => request<Entry>("POST", `/entries/${id}/revert`, { revisionId }),
  activity: (before?: number) => request<ActivityItem[]>("GET", `/activity${qs({ before, limit: 60 })}`),
  turns: (f: { project_id?: number; status?: string; before?: number }) => request<TurnSummary[]>("GET", `/turns${qs({ ...f, limit: 50 })}`),
  turn: (id: number) => request<TurnDetail>("GET", `/turns/${id}`),
  retryTurn: (id: number) => request("POST", `/turns/${id}/retry`),
  deleteTurn: (id: number) => request("DELETE", `/turns/${id}`),
  search: (q: string, project_id?: number, inactive = false) =>
    request<Entry[]>("GET", `/search${qs({ q, project_id, all: project_id ? undefined : 1, limit: 40, inactive: inactive ? 1 : undefined })}`),
  policy: (project_id?: number | null) => request<Policy>("GET", `/policy${qs({ project_id: project_id ?? undefined })}`),
  setPolicy: (project_id: number | null, text: string) => request<Policy>("PUT", "/policy", { project_id, text }),
  similarEntities: (limit = 50) => request<SimilarPair[]>("GET", `/entities/similar${qs({ limit })}`),
  dismissSimilar: (a: number, b: number) => request<{ ok: true }>("POST", "/entities/similar/dismiss", { a, b }),
  wikiLint: (project_id: number | null) => request<WikiLint>("GET", `/wiki/lint${qs({ project_id: project_id ?? 0 })}`),
  cancelWikiJob: (id: number) => request<WikiJob>("POST", `/wiki/jobs/${id}/cancel`),
  cancelGraphJob: (id: number) => request<GraphJob>("POST", `/graph/jobs/${id}/cancel`),
  cancelReviewJob: (id: number) => request<ReviewJob>("POST", `/review/jobs/${id}/cancel`),
  sessionSearch: (q: string, project_id?: number) => request<SessionHit[]>("GET", `/session-search${qs({ q, project_id, limit: 20 })}`),
  wikiPages: (project_id: number | null, deleted = false) => request<WikiPage[]>("GET", `/wiki/pages${qs({ project_id: project_id ?? 0, deleted: deleted ? 1 : undefined })}`),
  wikiMissing: (project_id: number | null) => request<{ from: string; to: string }[]>("GET", `/wiki/missing${qs({ project_id: project_id ?? 0 })}`),
  wikiBySlug: (project_id: number | null, slug: string) => request<WikiPage>("GET", `/wiki/by-slug${qs({ project_id: project_id ?? 0, slug })}`),
  wikiPage: (id: number) =>
    request<{ page: WikiPage; project: Project | null; revisions: WikiRevision[]; backlinks: PageRef[]; cites: Entry[] }>("GET", `/wiki/pages/${id}`),
  createWikiPage: (p: { project_id: number | null; slug?: string; title: string; body: string; locked?: boolean; parent_id?: number | null }) =>
    request<WikiPage>("POST", "/wiki/pages", p),
  updateWikiPage: (id: number, patch: Partial<Pick<WikiPage, "title" | "body" | "locked" | "parent_id">>) => request<WikiPage>("PATCH", `/wiki/pages/${id}`, patch),
  wikiTreeSuggest: (project_id: number | null) => request<TreeSuggestion[]>("GET", `/wiki/tree/suggest${qs({ project_id: project_id ?? 0 })}`),
  applyWikiTree: (moves: { id: number; parent_id: number | null }[]) => request<WikiPage[]>("POST", "/wiki/tree/apply", { moves }),
  deleteWikiPage: (id: number) => request<WikiPage>("DELETE", `/wiki/pages/${id}`),
  restoreWikiPage: (id: number) => request<WikiPage>("POST", `/wiki/pages/${id}/restore`),
  revertWikiPage: (id: number, revisionId: number) => request<WikiPage>("POST", `/wiki/pages/${id}/revert`, { revisionId }),
  wikiSearch: (q: string) => request<WikiHit[]>("GET", `/wiki/search${qs({ q, all: 1, limit: 30 })}`),
  wikiJobs: (project_id?: number | null, status?: string) =>
    request<WikiJob[]>("GET", `/wiki/jobs${qs({ project_id: project_id === undefined ? undefined : project_id ?? 0, status })}`),
  composeTurns: (project_id: number | null) => request<ComposeTurn[]>("GET", `/wiki/compose/turns${qs({ project_id: project_id ?? 0, limit: 300 })}`),
  compose: (project_id: number | null, turn_ids: number[], instruction?: string) =>
    request<WikiJob>("POST", "/wiki/compose", { project_id, turn_ids, instruction }),
  retryWikiJob: (id: number) => request<WikiJob>("POST", `/wiki/jobs/${id}/retry`),
  preview: (project_id: number | undefined, prompt: string) =>
    request<{ system: string; recall: string; included: number[]; recalled: number[] }>("GET", `/context/preview${qs({ project_id, prompt })}`),
};
