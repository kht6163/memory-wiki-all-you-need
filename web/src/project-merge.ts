// Project merge (ScopePage "다른 프로젝트에 합치기…"): picker filter and the preview in Korean.
// Pure module (no DOM, no React) so server/test can import it.
import type { MergeCounts, MergePreview, Project } from "./api.ts";

/** Korean label of each moved kind, in display order. */
export const MERGE_COUNT_LABEL: [keyof MergeCounts, string][] = [
  ["entries", "메모리"],
  ["turns", "턴 기록"],
  ["wiki_pages", "위키 페이지"],
  ["wiki_jobs", "위키 정리 작업"],
  ["review_jobs", "점검 작업"],
  ["review_proposals_pending", "대기 중인 점검 제안"],
];

export interface MergeSummary {
  /** "메모리 12개" … (zero counts left out; empty when nothing moves). */
  moves: string[];
  /** Source wiki pages renamed because the target has the same slug. */
  renames: { from: string; to: string }[];
  policy: string;
  description: string;
  /** Keys that point to the target afterwards. */
  aliases: string[];
}

/** Count lines for what moves (or moved), zero counts left out. */
export function mergeCountLines(c: MergeCounts): string[] {
  return MERGE_COUNT_LABEL.filter(([k]) => (c[k] ?? 0) > 0).map(([k, label]) => `${label} ${c[k].toLocaleString("ko-KR")}개`);
}

/** The merge preview as Korean lines for the confirm dialog. */
export function mergeSummary(p: MergePreview): MergeSummary {
  const src = `"${p.source.name}"`;
  const dst = `"${p.target.name}"`;
  const policy =
    p.policy === "target"
      ? `${dst}의 정리 방침을 그대로 둡니다.`
      : p.policy === "source"
        ? `${dst}에 정리 방침이 없어 ${src}의 방침을 가져옵니다.`
        : p.policy === "both"
          ? `${dst}의 정리 방침을 두고, ${src}의 방침을 그 아래에 덧붙입니다.`
          : "두 프로젝트 모두 정리 방침이 없습니다.";
  const description =
    p.description === "target"
      ? `${dst}의 설명을 그대로 둡니다.`
      : p.description === "source"
        ? `${dst}에 설명이 없어 ${src}의 설명을 가져옵니다.`
        : "두 프로젝트 모두 설명이 없습니다.";
  return {
    moves: mergeCountLines(p.counts),
    renames: p.wiki_conflicts.map((c) => ({ from: c.slug, to: c.new_slug })),
    policy,
    description,
    aliases: [...p.aliases],
  };
}

/**
 * Merge targets for the picker: every project except the source, matching the query on name or key
 * (case-insensitive), most recently used first.
 */
export function mergeCandidates(projects: Project[], sourceId: number, q: string): Project[] {
  const needle = q.trim().toLowerCase();
  return projects
    .filter((p) => p.id !== sourceId)
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.key.toLowerCase().includes(needle))
    .sort((a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? "") || a.name.localeCompare(b.name, "ko"));
}
