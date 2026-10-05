import { config, llmEnabled } from "./config.ts";
import { db, type Project, type Turn } from "./db.ts";
import { chatJson } from "./llm.ts";
import { getEntry, getProject, policyPrompt, projectLabel } from "./store.ts";
import { getTurn, renderTurn } from "./turns.ts";
import {
  createPage,
  deletePage,
  finishJob,
  getPage,
  getPageBySlug,
  listPages,
  markComposed,
  saveJobProgress,
  searchWiki,
  slugify,
  updatePage,
  type WikiJob,
  type WikiPage,
  isJobCancelled,
  runningWikiJobs,
  movePage,
} from "./wiki.ts";

// Compose job: the LLM reads selected turn records (the real conversations and
// tool work, not the condensed memory) and writes what is worth keeping into
// wiki pages. Runs only when someone asks for it. Large selections are split
// into chunks of WIKI_COMPOSE_CHUNK_CHARS and processed in order, each chunk
// seeing the pages as the previous chunk left them, so the cost of one LLM call
// never depends on how big the wiki or the history has grown.

const COMPOSE_PROMPT = `You maintain a wiki for a software developer. You are given TRANSCRIPTS of coding-agent sessions (user prompts, assistant answers, tool calls and results). Write the knowledge in them that is worth keeping into wiki pages that a human browses and edits.

What to keep:
- How the system is built and why (architecture, components, data flow).
- Decisions and their reasons, including rejected alternatives.
- Procedures that worked (setup, deploy, migration, release steps) with the actual commands.
- Troubleshooting: symptom → cause → fix.
- Environment facts (hosts, ports, paths, versions) and conventions.
What to skip: chit-chat, one-off tasks with no reusable lesson, dead ends that teach nothing, anything only true for that moment.

Page set:
- Prefer extending existing pages. Typical slugs: overview, architecture, conventions, decisions, environment, workflows, troubleshooting, glossary. Create a new page only when a topic clearly deserves its own page.
- "overview" is the entry page: what this is, the big picture, and [[links]] to the other pages. Create it if the wiki has none.
- Pages form a tree ("(under x)" in ALL PAGES). A page you create may name a "parent": the slug of a broader existing page (or one you create in this response) it belongs under, e.g. one decision record under "decisions", or a second part under the first. On an update, add "parent" only to move a page that clearly sits in the wrong place; otherwise leave it out so the page stays where people put it. Never put a page under "overview", and never move "overview".

Writing rules:
- Write in the language the user speaks in the transcripts (Korean if they speak Korean). Keep technical identifiers, commands and paths as-is.
- Markdown with ## headings, short paragraphs, lists, tables and code blocks where they help. Explain the "why".
- Do not start the body with a "# Title" heading — the title is shown separately.
- State only what the transcripts support. Do not invent. When a transcript shows something was later changed or reverted, write the final state.
- Link related pages with [[slug]] or [[slug|label]]. Only link slugs that exist or that you create in this response.
- When you update a page you are given its CURRENT BODY. Return the full new body. Preserve existing structure and wording, especially text a human wrote, unless the transcripts show it is now wrong. Make the smallest change that integrates the new knowledge. Keep any existing [#123] references as they are; do not add new ones.
- Do not touch pages marked locked. Do not update a page whose current body you were not shown (create a new page or leave it).
- No secrets, tokens or passwords.
- An INSTRUCTION from the person who started this job takes priority on what to focus on.
- If nothing is worth keeping, return no pages.

Respond with ONLY a JSON object:
{"pages":[
  {"action":"create","slug":"kebab-or-korean-slug","title":"...","body":"...","parent":"optional-parent-slug","reason":"..."},
  {"action":"update","slug":"existing-slug","title":"...","body":"...","reason":"..."},
  {"action":"delete","slug":"existing-slug","reason":"..."}
],"note":"one short sentence"}`;

function scopeLabel(project: Project | null) {
  return project ? `project wiki: ${projectLabel(project)}` : "global wiki (cross-project knowledge, environment, the user's tools and habits)";
}

function turnBlock(t: Turn): string {
  const head = `=== turn #${t.id} · session ${t.session_id.slice(0, 8)} · ${t.created_at.slice(0, 16).replace("T", " ")} ===`;
  return `${head}\n${renderTurn(t.payload)}`;
}

/** Split turn blocks into chunks of at most `budget` chars; an oversized turn is clipped to fit alone. */
function chunkTurns(turns: Turn[], budget: number): { ids: number[]; text: string }[] {
  const chunks: { ids: number[]; text: string }[] = [];
  let cur: { ids: number[]; text: string } = { ids: [], text: "" };
  for (const t of turns) {
    let block = turnBlock(t);
    if (block.length > budget) block = `${block.slice(0, budget - 40)}\n… [turn truncated]`;
    if (cur.ids.length && cur.text.length + block.length + 2 > budget) {
      chunks.push(cur);
      cur = { ids: [], text: "" };
    }
    cur.ids.push(t.id);
    cur.text += (cur.text ? "\n\n" : "") + block;
  }
  if (cur.ids.length) chunks.push(cur);
  return chunks;
}

interface Applied {
  action: string;
  slug: string;
  title: string;
  pageId: number;
}
interface ComposeProgress {
  done: number[];
  chunks: number;
  applied: Applied[];
  notes: string[];
}

async function composeChunk(job: WikiJob, project: Project | null, chunk: { ids: number[]; text: string }, touched: Set<number>, instruction?: string) {
  const pages = listPages(job.project_id);

  // Pages whose bodies the LLM sees (and may therefore rewrite): overview,
  // pages this job already touched, and pages matching this chunk's text.
  const shown = new Map<number, WikiPage>();
  const add = (p: WikiPage | null | undefined) => p && !p.deleted_at && shown.set(p.id, p);
  add(getPageBySlug(job.project_id, "overview"));
  for (const id of touched) add(getPage(id));
  const probe = `${instruction ?? ""}\n${chunk.text}`.slice(0, 4000);
  for (const h of searchWiki(probe, { projectId: job.project_id, limit: 6 })) if (h.page.project_id === job.project_id) add(h.page);

  let budget = config.wiki.writerBudget;
  const blocks: string[] = [];
  const editable = new Set<string>();
  for (const p of shown.values()) {
    if (budget - p.body.length < 0 && blocks.length) continue;
    budget -= p.body.length;
    if (!p.locked) editable.add(p.slug);
    blocks.push(`### [[${p.slug}]] ${p.title}${p.locked ? " (LOCKED — do not change)" : ""}\n${p.body}`);
  }

  const policy = policyPrompt(job.project_id);
  const userPrompt = [
    `WIKI: ${scopeLabel(project)}`,
    `DATE: ${new Date().toISOString().slice(0, 10)}`,
    instruction ? `INSTRUCTION: ${instruction}` : "",
    "",
    "ALL PAGES (slug — title, and the page each one sits under):",
    pages.length
      ? pages
          .map((p) => {
            const parent = p.parent_id == null ? undefined : pages.find((q) => q.id === p.parent_id);
            return `- ${p.slug} — ${p.title}${parent ? ` (under ${parent.slug})` : ""}${p.locked ? " (locked)" : ""}`;
          })
          .join("\n")
      : "(no pages yet)",
    "",
    "CURRENT BODIES of the pages you may update:",
    blocks.join("\n\n") || "(none)",
    "",
    "TRANSCRIPTS:",
    chunk.text,
    ...(policy ? ["", policy] : []),
  ].join("\n");

  const { data } = await chatJson([
    { role: "system", content: COMPOSE_PROMPT },
    { role: "user", content: userPrompt },
  ], "wiki-compose");
  // Cancelled while the LLM was answering: write nothing.
  if (isJobCancelled(job.id)) return null;
  const obj = (data ?? {}) as { pages?: unknown; note?: unknown };
  const ops = Array.isArray(obj.pages) ? (obj.pages as Record<string, unknown>[]) : [];

  // [#id] must point at an existing memory; drop anything else so a made-up id
  // never renders as a broken memory link.
  const cleanBody = (body: string) => body.replace(/\s?\[#(\d+)\]/g, (m, id) => (getEntry(Number(id)) ? m : ""));

  const applied: Applied[] = [];
  const meta = { author: "llm" as const, jobId: job.id };
  // "parent" is applied after every page op, so a parent created later in the same reply exists.
  const moves: { slug: string; parent: string }[] = [];
  for (const op of ops.slice(0, 10)) {
    try {
      const action = String(op.action ?? "");
      const slug = slugify(String(op.slug ?? op.title ?? ""));
      const reason = op.reason ? String(op.reason) : null;
      const existing = getPageBySlug(job.project_id, slug);
      if (action === "delete") {
        if (!existing || existing.deleted_at || !editable.has(slug)) continue;
        deletePage(existing.id, { ...meta, reason });
        applied.push({ action, slug, title: existing.title, pageId: existing.id });
        continue;
      }
      const title = String(op.title ?? existing?.title ?? slug);
      const body = cleanBody(String(op.body ?? ""));
      if (!body.trim()) continue;
      if (existing && !existing.deleted_at) {
        // Never overwrite a page the LLM did not see (it would drop content blindly) or a locked one.
        if (!editable.has(slug)) continue;
        const p = updatePage(existing.id, { title, body }, { ...meta, reason });
        touched.add(p.id);
        applied.push({ action: "update", slug, title: p.title, pageId: p.id });
        // An update may move a page under another one, never back to the top (that would undo a person's placement).
        if (typeof op.parent === "string" && op.parent.trim()) moves.push({ slug: p.slug, parent: op.parent });
      } else {
        const p = createPage(job.project_id, { slug, title, body }, { ...meta, reason });
        touched.add(p.id);
        applied.push({ action: "create", slug: p.slug, title: p.title, pageId: p.id });
        if (typeof op.parent === "string") moves.push({ slug: p.slug, parent: op.parent });
      }
    } catch (err) {
      console.warn(`[wiki] job ${job.id}: page op rejected: ${(err as Error).message}`);
    }
  }
  // Only pages written in this reply move; a bad parent (unknown, overview, a cycle) is ignored, never fatal.
  for (const m of moves) {
    try {
      const page = getPageBySlug(job.project_id, m.slug);
      if (!page || page.deleted_at || page.slug === "overview") continue;
      let parentId: number | null = null;
      if (m.parent.trim()) {
        const parent = getPageBySlug(job.project_id, m.parent);
        if (!parent || parent.deleted_at || parent.slug === "overview") continue;
        parentId = parent.id;
      }
      movePage(page.id, parentId, meta);
    } catch (err) {
      console.warn(`[wiki] job ${job.id}: parent of "${m.slug}" ignored: ${(err as Error).message}`);
    }
  }
  return { applied, note: typeof obj.note === "string" ? obj.note : "" };
}

async function runCompose(job: WikiJob, between: () => Promise<void>) {
  const project = job.project_id != null ? getProject(job.project_id) : null;
  if (job.project_id != null && !project) return finishJob(job.id, "skipped", { note: "project deleted" });

  // A retried job resumes after the chunks that already went through.
  const prev = (job.result ?? {}) as Partial<ComposeProgress>;
  const progress: ComposeProgress = { done: prev.done ?? [], chunks: prev.chunks ?? 0, applied: prev.applied ?? [], notes: prev.notes ?? [] };
  const done = new Set(progress.done);
  const turns = job.payload.turns
    .filter((id) => !done.has(id))
    .map((id) => getTurn(id))
    .filter((t): t is Turn => Boolean(t));
  if (!turns.length && !progress.done.length) return finishJob(job.id, "skipped", { note: "turns no longer exist" });

  const touched = new Set(progress.applied.filter((a) => a.action !== "delete").map((a) => a.pageId));
  const chunks = chunkTurns(turns, config.wiki.composeChunkChars);
  for (const [i, chunk] of chunks.entries()) {
    // Memory curation must not wait behind a long compose job.
    if (i > 0) await between();
    if (isJobCancelled(job.id)) return;
    try {
      const r = await composeChunk(job, project, chunk, touched, job.payload.instruction);
      if (!r) return;
      markComposed(job.project_id, chunk.ids, job.id);
      progress.done.push(...chunk.ids);
      progress.chunks++;
      progress.applied.push(...r.applied);
      if (r.note) progress.notes.push(r.note);
      saveJobProgress(job.id, progress);
      console.log(`[wiki] compose ${job.id} chunk ${i + 1}/${chunks.length} (${chunk.ids.length} turns): ${r.applied.length} page change(s)`);
    } catch (err) {
      return finishJob(job.id, "error", progress, `chunk ${i + 1}/${chunks.length}: ${(err as Error).message}`);
    }
  }
  finishJob(job.id, "done", progress);
}

/** `between` runs between chunks; the worker passes "curate queued turns". */
export async function processWikiJob(job: WikiJob, between: () => Promise<void> = async () => {}) {
  const started = Date.now();
  try {
    if (!llmEnabled()) return finishJob(job.id, "skipped", job.result, "LLM is not configured (LLM_BASE_URL)");
    if (job.kind !== "compose") return finishJob(job.id, "skipped", job.result, `job kind "${job.kind}" was removed in v0.3.0`);
    await runCompose(job, between);
  } catch (err) {
    console.error(`[wiki] job ${job.id} failed:`, (err as Error).message);
    finishJob(job.id, "error", job.result, (err as Error).message);
  } finally {
    runningWikiJobs.delete(job.id);
    db.prepare(`UPDATE wiki_jobs SET result = json_set(COALESCE(result, '{}'), '$.ms', ?) WHERE id = ? AND status IN ('done','error','skipped')`).run(
      Date.now() - started,
      job.id,
    );
  }
}
