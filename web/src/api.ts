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

export interface Stats {
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
}

export interface WikiPage {
  id: number;
  project_id: number | null;
  slug: string;
  title: string;
  body: string;
  locked: boolean;
  source: Source;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
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
 * One memory-graph edit. link: add | remove; entity: update | merge | delete (revertible),
 * unmerge | restore (written by reverting a merge / delete). A revert's own row carries
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
  revertible: boolean;
}

export interface ReviewJob {
  id: number;
  project_id: number | null;
  project_name: string | null;
  status: JobStatus;
  payload: { entries: number[]; scheduled?: boolean };
  result: { done?: number[]; chunks?: number; proposals?: number; ms?: number } | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface Proposal {
  id: number;
  job_id: number;
  kind: "merge" | "update" | "delete" | "conflict";
  entry_ids: number[];
  data: { title?: string; body?: string; category?: string; note?: string; snap: Record<string, string>; /** Exact-substring edit of the body (update proposals). */ edit?: { old: string; new: string } };
  reason: string;
  status: "pending" | "applied" | "dismissed" | "stale";
  created_at: string;
  decided_at: string | null;
  entries: ((Entry & { entities: string[]; changed: boolean }) | null)[];
}

export type PageRef = { id: number; slug: string; title: string; project_id?: number | null };

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
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
  projects: () => request<Project[]>("GET", "/projects"),
  project: (id: number) => request<Project>("GET", `/projects/${id}`),
  updateProject: (id: number, patch: Partial<Pick<Project, "name" | "description">>) => request<Project>("PATCH", `/projects/${id}`, patch),
  deleteProject: (id: number) => request("DELETE", `/projects/${id}`),
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
  createWikiPage: (p: { project_id: number | null; slug?: string; title: string; body: string; locked?: boolean }) => request<WikiPage>("POST", "/wiki/pages", p),
  updateWikiPage: (id: number, patch: Partial<Pick<WikiPage, "title" | "body" | "locked">>) => request<WikiPage>("PATCH", `/wiki/pages/${id}`, patch),
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
