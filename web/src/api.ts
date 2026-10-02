export type Scope = "global" | "user" | "project";
export type Source = "agent" | "llm" | "human";

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
  pinned: boolean;
  source: Source;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
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
  result: { ops: unknown[]; applied: TurnSummary["applied"]; note?: string; model?: string; ms?: number } | null;
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
  status: "pending" | "processing" | "done" | "skipped" | "error";
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
  status: "pending" | "processing" | "done" | "skipped" | "error";
  payload: { entries: number[]; projectId?: number | null };
  result: { done?: number[]; chunks?: number; entities?: number; links?: number; ms?: number } | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
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
    request<{ entry: Entry; project: Project | null; revisions: Revision[]; citedBy: PageRef[]; entities: Entity[]; links: EntryLink[] }>("GET", `/entries/${id}`),
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
  graphJobs: () => request<GraphJob[]>("GET", "/graph/jobs"),
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
  search: (q: string, project_id?: number) => request<Entry[]>("GET", `/search${qs({ q, project_id, all: project_id ? undefined : 1, limit: 40 })}`),
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
