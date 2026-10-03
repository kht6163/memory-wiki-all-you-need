import { llmEnabled } from "./config.ts";
import { db, type Entry } from "./db.ts";
import { entityNamesOf } from "./entities.ts";
import { chatJson } from "./llm.ts";
import {
  DROPPED_KEPT, buildReviewBatches, combineUpdateProposals, crossScopeContext, finishReviewJob, inScope, isReviewJobCancelled, markReasonDeletes, runningReviewJobs, saveReviewProgress, tryAddProposal, versionOf,
  type DroppedProposal, type ReviewJob,
} from "./review.ts";
import { confirmTrackingSince, confirmedTurns, entryState, getEntry, getProject, policyPrompt, projectLabel, usageOf } from "./store.ts";

// Review job: one LLM call per batch of related memories (see buildReviewBatches).
// Only proposals come out; nothing is changed until a person applies one.

const REVIEW_PROMPT = `You audit a coding agent's long-term memory. Memories are short facts injected into the agent's prompt, so duplicates, contradictions and stale facts waste space and mislead it. Review the MEMORIES and propose fixes. Be conservative: propose only what you are confident about; most memories are fine.

Propose:
- "merge": two or more memories say the same thing or belong together → one memory. ids: the memories (the FIRST id is kept), title/body/category: the merged memory, keeping every still-true detail. Only memories with the same scope (and project).
- "update": one memory is unclear, too long, partly outdated or wrongly categorized → corrected title/body/category. Do not invent facts.
  For small changes to a long body, prefer "edits" instead of a full "body": [{"old":"...","new":"..."}, ...] where each "old" is copied verbatim from the body and occurs in it exactly once (include enough context to make it unique); only those passages are replaced, all together. Passages must not overlap. Put ALL changes to one memory in ONE "update" proposal (several entries in "edits"), never several updates for the same id. Give either "body" or "edits", not both.
  "entities" (optional): the memory's full entity list after the change. Only names from its current "entities" may appear (you can remove, never add); use it when your change removes the only mention of an entity. Omit it to keep the entities, except that an entity named only in a passage your edits remove is dropped; to keep such an entity, list it.
- Memories marked body_truncated were cut for this review: never send a full "body" for them, and never a "delete" with "covered_by" (you did not see the rest). "edits" whose "old" passages you can see are fine, as are title/category/entities changes and a plain delete.
- "delete": a memory is obsolete, transient (task progress, one-off), generic knowledge, or fully covered by another memory that stays. Never for pinned memories. Never delete a memory that records a decision or its reason (category decision, or one with "reason_for") just because another memory now states the outcome: the reason would be lost. Propose "merge" (keeps both texts) or leave it. A memory whose valid_until is before DATE has expired: propose delete unless it is still useful history.
- Multiple values are not a contradiction ("uses PostgreSQL" and "also uses Redis"); only report a conflict when both cannot be true at once.
- "conflict": memories contradict each other and you cannot tell which is right → ids + note for a human.
- REFERENCE memories (project reviews only) are global/user memories shown READ-ONLY for comparison; they belong to another review. Never put a REFERENCE id in "ids" (no merge, update, delete or conflict on them). If a MEMORY only repeats what a REFERENCE memory already states, propose "delete" of the MEMORY with "covered_by": that reference id; if only part of it is repeated, propose "update" with "edits" that remove that part, plus "covered_by". Cite the reference id in the reason (e.g. "already in global #7"). A project memory that adds project-specific detail is not a duplicate. If a MEMORY contradicts a REFERENCE memory (e.g. a project rule that overrides a global one without saying so), propose "conflict" with "ids": [that memory] and "covered_by": the reference id, and say in "note" what differs.

Signals: "used" = how often it was recalled into a prompt or returned by search, "last_used" = when, "in_prompt_block" = last day it was part of the always-injected block; a memory never used or injected for a long time and not updated is a stale candidate, but age alone is not a reason to delete conventions or preferences. "confirmed" (present only when tracked for the memory's whole current version) = how many conversation turns relied on it, re-stated it or corrected it; rarely confirmed + never used + old = stale candidate. A missing "confirmed" says nothing either way. "reason_for" = memories that exist because of this one (it holds their reason).
Write titles, bodies, reasons and notes in the memories' language (Korean memories → Korean reasons). Keep technical identifiers. No secrets.
Categories: fact, convention, preference, decision, failure, correction, insight, tool-quirk.

Respond with ONLY a JSON object:
{"proposals":[
  {"kind":"merge","ids":[12,15],"title":"...","body":"...","category":"...","reason":"..."},
  {"kind":"update","ids":[20],"title":"...","body":"...","category":"...","reason":"..."},
  {"kind":"update","ids":[20],"edits":[{"old":"...","new":"..."},{"old":"...","new":"..."}],"reason":"..."},
  {"kind":"update","ids":[22],"edits":[{"old":"...","new":"..."}],"entities":["..."],"reason":"... (entities only when the change drops one)"},
  {"kind":"delete","ids":[31],"reason":"..."},
  {"kind":"delete","ids":[33],"covered_by":7,"reason":"... (already in global #7)"},
  {"kind":"conflict","ids":[34],"covered_by":7,"note":"...","reason":"... (contradicts global #7)"},
  {"kind":"conflict","ids":[40,41],"note":"...","reason":"..."}
]}`;

/** Body characters shown per memory. A rewrite of a longer body would drop its unseen tail, so those get only exact-substring edits (below). */
const BODY_SHOWN = 4000;

/** Body characters shown per REFERENCE memory (read-only cross-scope context): enough to see a duplicate. */
const REF_BODY_SHOWN = 1000;

/** A global/user memory shown read-only next to a project batch (no usage signals: nothing is proposed on it). */
function fmtRef(e: Entry): string {
  return JSON.stringify({
    id: e.id, scope: e.scope, category: e.category, title: e.title, body: e.body.slice(0, REF_BODY_SHOWN),
    ...(e.body.length > REF_BODY_SHOWN ? { body_truncated: true } : {}), entities: entityNamesOf(e.id),
  });
}

/** `trackedSince`: from confirmTrackingSince(); "confirmed" is shown only for memories last changed after it. */
function fmt(e: Entry, trackedSince: string | null): string {
  const u = usageOf(e.id);
  // Before tracking began nothing could confirm a memory, so a 0 there would read as "stale".
  const tracked = trackedSince != null && e.updated_at >= trackedSince;
  const p = e.project_id ? getProject(e.project_id) : null;
  // Memories that exist because of this one (a "because" link to it): deleting it loses their reason.
  const reasonFor = db
    // Live memories only (G-017): a deleted one's link must not resurface here.
    .prepare(`SELECT l.from_id FROM entry_links l JOIN entries f ON f.id = l.from_id WHERE l.to_id = ? AND l.type = 'because' AND f.deleted_at IS NULL ORDER BY l.from_id LIMIT 10`).all(e.id).map((r) => Number(r.from_id));
  return JSON.stringify({
    id: e.id, scope: e.scope, project: p?.name, category: e.category, pinned: e.pinned || undefined,
    title: e.title, body: e.body.slice(0, BODY_SHOWN), ...(e.valid_until ? { valid_until: e.valid_until } : {}), ...(e.body.length > BODY_SHOWN ? { body_truncated: true } : {}), entities: entityNamesOf(e.id),
    ...(reasonFor.length ? { reason_for: reasonFor } : {}),
    updated: e.updated_at.slice(0, 10), used: u.recalled + u.searched, last_used: u.last_used_at?.slice(0, 10) ?? "never",
    in_prompt_block: u.shown_at?.slice(0, 10) ?? "never", ...(tracked ? { confirmed: confirmedTurns(e.id) } : {}),
  });
}

interface Progress {
  done: number[];
  chunks: number;
  proposals: number;
  /** Proposals the LLM made that were not stored, with why (first DROPPED_KEPT kept; dropped_count counts all). */
  dropped: DroppedProposal[];
  dropped_count: number;
  /** Global/user memories shown read-only next to project batches (summed). */
  cross_scope: number;
  /** Memories whose body was cut at BODY_SHOWN for the LLM (first DROPPED_KEPT ids; truncated_count counts all). No silent cap. */
  truncated: number[];
  truncated_count: number;
}

async function runReview(job: ReviewJob, between: () => Promise<void>) {
  const prev = (job.result ?? {}) as Partial<Progress>;
  const progress: Progress = {
    done: prev.done ?? [], chunks: prev.chunks ?? 0, proposals: prev.proposals ?? 0, dropped: prev.dropped ?? [], dropped_count: prev.dropped_count ?? 0,
    cross_scope: prev.cross_scope ?? 0, truncated: prev.truncated ?? [], truncated_count: prev.truncated_count ?? 0,
  };
  // No silent drops: every proposal not stored is logged and counted on the job result.
  const drop = (d: DroppedProposal) => {
    progress.dropped_count++;
    if (progress.dropped.length < DROPPED_KEPT) progress.dropped.push(d);
    console.log(`[review] job ${job.id} dropped ${d.kind} [${d.ids.join(",")}]: ${d.reason}`);
  };
  const done = new Set(progress.done);
  const entries = job.payload.entries
    .filter((id) => !done.has(id))
    .map((id) => getEntry(id))
    .filter((e): e is Entry => Boolean(e && !e.deleted_at && e.category !== "standing"));
  const trackedSince = confirmTrackingSince();
  const show = (e: Entry) => fmt(e, trackedSince);
  const batches = buildReviewBatches(entries, show);
  const policy = policyPrompt(job.project_id);
  const project = job.project_id != null ? getProject(job.project_id) : null;

  for (const [i, planned] of batches.entries()) {
    if (i > 0) await between();
    if (isReviewJobCancelled(job.id)) return;
    // Re-read right before the call (turns may have changed memories meanwhile) and remember
    // the version the LLM sees; a proposal on a memory that changes during the call is dropped.
    const batch = planned
      .map((e) => getEntry(e.id))
      // Superseded since the job was queued: history now, not shown (addProposal rejects it too).
      .filter((e): e is Entry => Boolean(e && !e.deleted_at && e.category !== "standing" && inScope(e, job.project_id) && !entryState(e).superseded_by));
    // Counted once the batch is done (a batch re-run after a cancel is not counted twice).
    let shownRefs = 0;
    let cut: number[] = [];
    try {
      if (batch.length >= 2) {
        const seen = new Map(batch.map((e) => [e.id, versionOf(e.id)]));
        // Project review: the most related global/user memories, read-only, so a project copy
        // of something already stated globally can be seen (and only the copy proposed away).
        const refs = job.project_id != null ? crossScopeContext(batch, fmtRef) : [];
        const context = new Map(refs.map((e) => [e.id, versionOf(e.id)]));
        shownRefs = refs.length;
        cut = batch.filter((e) => e.body.length > BODY_SHOWN).map((e) => e.id);
        const { data } = await chatJson([
          { role: "system", content: REVIEW_PROMPT },
          {
            role: "user",
            content: [
              `DATE: ${new Date().toISOString().slice(0, 10)}`, ...(project ? [`PROJECT: ${projectLabel(project)}`] : []), "", "MEMORIES:", batch.map(show).join("\n"),
              ...(refs.length ? ["", "REFERENCE (global/user memories, read-only: never in \"ids\"; cite in \"covered_by\"):", refs.map(fmtRef).join("\n")] : []),
              ...(policy ? ["", policy] : []),
            ].join("\n"),
          },
        ]);
        // Cancelled while the LLM was answering: keep nothing from this batch.
        if (isReviewJobCancelled(job.id)) return;
        const raw = (data as { proposals?: unknown })?.proposals;
        const all = (Array.isArray(raw) ? raw : []).filter((p): p is Record<string, unknown> => p != null && typeof p === "object");
        const idsOf = (p: Record<string, unknown>) => (Array.isArray(p.ids) ? p.ids : [p.id]).map(Number);
        for (const p of all.slice(30)) drop({ kind: String(p.kind ?? ""), ids: idsOf(p), reason: "over_limit" });
        const truncated = new Set(cut);
        // Several updates of one memory (e.g. one edit each) become one proposal with all their edits.
        const bodies = new Map(batch.map((e) => [e.id, e.body]));
        const combined = combineUpdateProposals(all.slice(0, 30), (id) => (seen.has(id) ? bodies.get(id) : undefined), (id) => context.has(id));
        combined.dropped.forEach(drop);
        for (const p of combined.proposals) {
          // The LLM never saw the end of a truncated body: it may not rewrite that body. Exact-substring
          // edits are fine (addProposal checks them against the full body, and edits replace any "body").
          const ids = idsOf(p);
          const isEdit = p.kind === "update" && (p.edit != null || (Array.isArray(p.edits) && p.edits.length > 0));
          if ((p.kind === "update" || p.kind === "merge") && !isEdit && p.body != null && String(p.body).trim() && ids.some((id) => truncated.has(id))) {
            drop({ kind: String(p.kind), ids, reason: "body_truncated" });
            continue;
          }
          // "Only repeats another memory" needs the whole body: the unseen tail may say more.
          if (p.kind === "delete" && p.covered_by != null && String(p.covered_by).trim() !== "" && ids.some((id) => truncated.has(id))) {
            drop({ kind: "delete", ids, reason: "body_truncated" });
            continue;
          }
          const r = tryAddProposal(job.id, p, seen, context);
          if ("proposal" in r) progress.proposals++;
          else drop({ kind: String(p.kind ?? p.op ?? ""), ids, reason: r.reason });
        }
        // After the whole batch: the delete and the update it would undercut may come in either order.
        markReasonDeletes(job.id);
      }
      progress.done.push(...planned.map((e) => e.id));
      progress.chunks++;
      progress.cross_scope += shownRefs;
      progress.truncated_count += cut.length;
      progress.truncated.push(...cut.slice(0, Math.max(0, DROPPED_KEPT - progress.truncated.length)));
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
    runningReviewJobs.delete(job.id);
    db.prepare(`UPDATE review_jobs SET result = json_set(COALESCE(result, '{}'), '$.ms', ?) WHERE id = ? AND status IN ('done','error','skipped')`).run(
      Date.now() - started,
      job.id,
    );
  }
}
