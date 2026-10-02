import { llmEnabled } from "./config.ts";
import { db, type Entry } from "./db.ts";
import { entityNamesOf } from "./entities.ts";
import { chatJson } from "./llm.ts";
import { addProposal, buildReviewBatches, finishReviewJob, inScope, saveReviewProgress, versionOf, type ReviewJob } from "./review.ts";
import { getEntry, getProject, usageOf } from "./store.ts";

// Review job: one LLM call per batch of related memories (see buildReviewBatches).
// Only proposals come out; nothing is changed until a person applies one.

const REVIEW_PROMPT = `You audit a coding agent's long-term memory. Memories are short facts injected into the agent's prompt, so duplicates, contradictions and stale facts waste space and mislead it. Review the MEMORIES and propose fixes. Be conservative: propose only what you are confident about; most memories are fine.

Propose:
- "merge": two or more memories say the same thing or belong together → one memory. ids: the memories (the FIRST id is kept), title/body/category: the merged memory, keeping every still-true detail. Only memories with the same scope (and project).
- Memories marked body_truncated were cut for this review: never rewrite their body (title/category changes and delete are fine).
- "update": one memory is unclear, too long, partly outdated or wrongly categorized → corrected title/body/category. Do not invent facts.
- "delete": a memory is obsolete, transient (task progress, one-off), generic knowledge, or fully covered by another memory that stays. Never for pinned memories.
- "conflict": memories contradict each other and you cannot tell which is right → ids + note for a human.

Signals: "used" = how often it was recalled into a prompt or returned by search, "last_used" = when, "in_prompt_block" = last day it was part of the always-injected block; a memory never used or injected for a long time and not updated is a stale candidate, but age alone is not a reason to delete conventions or preferences.
Write titles, bodies, reasons and notes in the memories' language (Korean memories → Korean reasons). Keep technical identifiers. No secrets.
Categories: fact, convention, preference, decision, failure, correction, insight, tool-quirk.

Respond with ONLY a JSON object:
{"proposals":[
  {"kind":"merge","ids":[12,15],"title":"...","body":"...","category":"...","reason":"..."},
  {"kind":"update","ids":[20],"title":"...","body":"...","category":"...","reason":"..."},
  {"kind":"delete","ids":[31],"reason":"..."},
  {"kind":"conflict","ids":[40,41],"note":"...","reason":"..."}
]}`;

/** Body characters shown per memory. A rewrite of a longer body would drop its unseen tail, so those are protected below. */
const BODY_SHOWN = 4000;

function fmt(e: Entry): string {
  const u = usageOf(e.id);
  const p = e.project_id ? getProject(e.project_id) : null;
  return JSON.stringify({
    id: e.id, scope: e.scope, project: p?.name, category: e.category, pinned: e.pinned || undefined,
    title: e.title, body: e.body.slice(0, BODY_SHOWN), ...(e.body.length > BODY_SHOWN ? { body_truncated: true } : {}), entities: entityNamesOf(e.id),
    updated: e.updated_at.slice(0, 10), used: u.recalled + u.searched, last_used: u.last_used_at?.slice(0, 10) ?? "never",
    in_prompt_block: u.shown_at?.slice(0, 10) ?? "never",
  });
}

interface Progress {
  done: number[];
  chunks: number;
  proposals: number;
}

async function runReview(job: ReviewJob, between: () => Promise<void>) {
  const prev = (job.result ?? {}) as Partial<Progress>;
  const progress: Progress = { done: prev.done ?? [], chunks: prev.chunks ?? 0, proposals: prev.proposals ?? 0 };
  const done = new Set(progress.done);
  const entries = job.payload.entries
    .filter((id) => !done.has(id))
    .map((id) => getEntry(id))
    .filter((e): e is Entry => Boolean(e && !e.deleted_at && e.category !== "standing"));
  const batches = buildReviewBatches(entries, fmt);

  for (const [i, planned] of batches.entries()) {
    if (i > 0) await between();
    // Re-read right before the call (turns may have changed memories meanwhile) and remember
    // the version the LLM sees; a proposal on a memory that changes during the call is dropped.
    const batch = planned
      .map((e) => getEntry(e.id))
      .filter((e): e is Entry => Boolean(e && !e.deleted_at && e.category !== "standing" && inScope(e, job.project_id)));
    try {
      if (batch.length >= 2) {
        const seen = new Map(batch.map((e) => [e.id, versionOf(e.id)]));
        const { data } = await chatJson([
          { role: "system", content: REVIEW_PROMPT },
          { role: "user", content: `DATE: ${new Date().toISOString().slice(0, 10)}\n\nMEMORIES:\n${batch.map(fmt).join("\n")}` },
        ]);
        const raw = (data as { proposals?: unknown })?.proposals;
        const truncated = new Set(batch.filter((e) => e.body.length > BODY_SHOWN).map((e) => e.id));
        for (const p of (Array.isArray(raw) ? raw : []).slice(0, 30) as Record<string, unknown>[]) {
          // The LLM never saw the end of a truncated body: it may not rewrite that body.
          const ids = (Array.isArray(p.ids) ? p.ids : [p.id]).map(Number);
          if ((p.kind === "update" || p.kind === "merge") && p.body != null && String(p.body).trim() && ids.some((id) => truncated.has(id))) continue;
          if (addProposal(job.id, p, seen)) progress.proposals++;
        }
      }
      progress.done.push(...planned.map((e) => e.id));
      progress.chunks++;
      saveReviewProgress(job.id, progress);
      console.log(`[review] job ${job.id} batch ${i + 1}/${batches.length} (${batch.length} memories)`);
    } catch (err) {
      return finishReviewJob(job.id, "error", progress, `batch ${i + 1}/${batches.length}: ${(err as Error).message}`);
    }
  }
  finishReviewJob(job.id, "done", progress);
}

export async function processReviewJob(job: ReviewJob, between: () => Promise<void> = async () => {}) {
  const started = Date.now();
  try {
    if (!llmEnabled()) return finishReviewJob(job.id, "skipped", job.result, "LLM is not configured (LLM_BASE_URL)");
    await runReview(job, between);
  } catch (err) {
    console.error(`[review] job ${job.id} failed:`, (err as Error).message);
    finishReviewJob(job.id, "error", job.result, (err as Error).message);
  } finally {
    db.prepare(`UPDATE review_jobs SET result = json_set(COALESCE(result, '{}'), '$.ms', ?) WHERE id = ? AND status IN ('done','error','skipped')`).run(
      Date.now() - started,
      job.id,
    );
  }
}
