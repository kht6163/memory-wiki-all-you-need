import { config, llmEnabled } from "./config.ts";
import { db, type Entry } from "./db.ts";
import { ENTITY_KINDS, type EntityInput } from "./entities.ts";
import { addLink, entitiesOf, finishGraphJob, isGraphJobCancelled, isLinkType, runningGraphJobs, listEntities, saveGraphProgress, type GraphJob } from "./graph.ts";
import { chatJson } from "./llm.ts";
import { getEntry, getProject, updateEntry } from "./store.ts";

// Backfill job: attach entities and links to memories that existed before the
// graph (or that the agent saved directly). Memories are processed in chunks
// of GRAPH_BACKFILL_CHUNK_CHARS, ordered by scope/project/category so related
// memories tend to share a chunk; links can only point inside the chunk.

const BACKFILL_PROMPT = `You build a knowledge graph over a coding agent's memory. For each MEMORY, list the entities it is about and its typed links to other memories in this batch.

- entities: the concrete things a memory is about — technologies, libraries, databases, services/containers, tools/CLIs, files/paths, named concepts, people. 1-6 per memory. Canonical names WITHOUT versions ("PostgreSQL", not "PostgreSQL 16"). Product, tool and file names as they are spelled officially; generic concepts in the language of the memory (Korean memory → "세션 캐시", not "session cache"). Reuse the exact spelling from KNOWN ENTITIES when it is the same thing. kind: ${ENTITY_KINDS.join(" | ")}.
- links (only to ids in this batch, only when real and useful; most memories have 0-2):
  - "because": this memory exists because of the other
  - "depends_on": this only holds / works if the other holds
  - "supersedes": this replaces the other (the same fact, newer or corrected — NOT a different fact on the same topic, NOT a plan replaced by its outcome in reverse; a person confirms it before the other is hidden)
  - "related": closely related, nothing more specific fits
- Keep entities a memory already has unless they are clearly wrong.

Respond with ONLY a JSON object:
{"memories":[{"id":123,"entities":[{"name":"...","kind":"tech"}],"links":[{"to":124,"type":"because"}]}]}`;

function fmt(e: Entry): string {
  const p = e.project_id ? getProject(e.project_id) : null;
  return JSON.stringify({
    id: e.id, scope: e.scope, project: p?.name, category: e.category, title: e.title, body: e.body.slice(0, 1500),
    entities: entitiesOf(e.id).map((n) => n.name),
  });
}

function chunk(entries: Entry[], budget: number): Entry[][] {
  const out: Entry[][] = [];
  let cur: Entry[] = [];
  let size = 0;
  for (const e of entries) {
    const n = fmt(e).length;
    if (cur.length && size + n > budget) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

interface Progress {
  done: number[];
  chunks: number;
  entities: number;
  links: number;
}

async function runBackfill(job: GraphJob, between: () => Promise<void>) {
  const prev = (job.result ?? {}) as Partial<Progress>;
  const progress: Progress = { done: prev.done ?? [], chunks: prev.chunks ?? 0, entities: prev.entities ?? 0, links: prev.links ?? 0 };
  const done = new Set(progress.done);
  const entries = job.payload.entries
    .filter((id) => !done.has(id))
    .map((id) => getEntry(id))
    .filter((e): e is Entry => Boolean(e && !e.deleted_at && e.category !== "standing"));
  const chunks = chunk(entries, config.graph.backfillChunkChars);

  for (const [i, batch] of chunks.entries()) {
    if (i > 0) await between();
    if (isGraphJobCancelled(job.id)) return;
    try {
      const known = listEntities({ limit: 150 }).map((n) => `${n.name} (${n.kind})`);
      const { data } = await chatJson([
        { role: "system", content: BACKFILL_PROMPT },
        {
          role: "user",
          content: ["KNOWN ENTITIES:", known.join(", ") || "(none yet)", "", "MEMORIES:", batch.map(fmt).join("\n")].join("\n"),
        },
      ], "graph-backfill");
      // Cancelled while the LLM was answering: write nothing.
      if (isGraphJobCancelled(job.id)) return;
      const items = Array.isArray((data as { memories?: unknown })?.memories) ? ((data as { memories: Record<string, unknown>[] }).memories) : [];
      const ids = new Set(batch.map((e) => e.id));
      for (const it of items) {
        const id = Number(it.id);
        if (!ids.has(id)) continue;
        try {
          if (Array.isArray(it.entities) && it.entities.length) {
            // Add to what the memory already has; a backfill never removes entities.
            const keep: EntityInput[] = entitiesOf(id).map((n) => n.name);
            updateEntry(id, { entities: [...keep, ...(it.entities as EntityInput[])] }, { author: "llm", reason: "그래프 백필" });
            progress.entities += Math.max(0, entitiesOf(id).length - keep.length);
          }
          for (const l of (Array.isArray(it.links) ? it.links : []).slice(0, 6) as Record<string, unknown>[]) {
            const to = Number(l?.to);
            if (!ids.has(to) || to === id || !isLinkType(l?.type)) continue;
            // A guessed "supersedes" would hide the older memory from every prompt: half of 18 were
            // wrong (G-084). It waits for a person on the review page instead.
            if (addLink(id, to, l.type, "llm", { pending: l.type === "supersedes" })) progress.links++;
          }
        } catch (err) {
          console.warn(`[graph] backfill ${job.id}: memory #${id}: ${(err as Error).message}`);
        }
      }
      progress.done.push(...batch.map((e) => e.id));
      progress.chunks++;
      saveGraphProgress(job.id, progress);
      console.log(`[graph] backfill ${job.id} chunk ${i + 1}/${chunks.length} (${batch.length} memories)`);
    } catch (err) {
      return finishGraphJob(job.id, "error", progress, `chunk ${i + 1}/${chunks.length}: ${(err as Error).message}`);
    }
  }
  finishGraphJob(job.id, "done", progress);
}

export async function processGraphJob(job: GraphJob, between: () => Promise<void> = async () => {}) {
  const started = Date.now();
  try {
    if (!llmEnabled()) return finishGraphJob(job.id, "skipped", job.result, "LLM is not configured (LLM_BASE_URL)");
    await runBackfill(job, between);
  } catch (err) {
    console.error(`[graph] job ${job.id} failed:`, (err as Error).message);
    finishGraphJob(job.id, "error", job.result, (err as Error).message);
  } finally {
    runningGraphJobs.delete(job.id);
    db.prepare(`UPDATE graph_jobs SET result = json_set(COALESCE(result, '{}'), '$.ms', ?) WHERE id = ? AND status IN ('done','error','skipped')`).run(
      Date.now() - started,
      job.id,
    );
  }
}
