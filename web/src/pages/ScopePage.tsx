import { useState } from "react";
import { api, type Entry, type Project, type Scope } from "../api.ts";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  CategoryBadge,
  Empty,
  ErrorBox,
  Markdown,
  SourceBadge,
  Tags,
  Time,
  act,
  go,
  useData,
} from "../lib.tsx";
import { ScopeTabs } from "./WikiPages.tsx";

interface Props {
  scope: Scope;
  projectId?: number;
  /** Only show standing instructions (global "고정 지시" page). */
  standingOnly?: boolean;
}

export function ScopePage({ scope, projectId, standingOnly }: Props) {
  const entries = useData(() => api.entries({ scope, project_id: projectId }), [scope, projectId]);
  const project = useData(() => (projectId ? api.project(projectId) : Promise.resolve(null)), [projectId]);
  const [filter, setFilter] = useState("");

  let list = entries.data ?? [];
  if (standingOnly) list = list.filter((e) => e.category === "standing");
  if (filter.trim()) {
    const f = filter.trim().toLowerCase();
    list = list.filter((e) => `${e.title}\n${e.body}\n${e.tags.join(" ")}`.toLowerCase().includes(f));
  }
  const groups = CATEGORY_ORDER.map((c) => ({ category: c, items: list.filter((e) => e.category === c) })).filter((g) => g.items.length);

  const title = standingOnly ? "고정 지시" : scope === "global" ? "전역 메모리" : scope === "user" ? "사용자 프로필" : `${project.data?.name ?? "프로젝트"} 메모리`;
  const lead = standingOnly
    ? "모든 세션의 프롬프트에 항상 들어가는 사용자 지시입니다. LLM과 에이전트는 수정할 수 없습니다."
    : scope === "global"
      ? "모든 프로젝트에 공통으로 적용되는 기억입니다."
      : scope === "user"
        ? "사용자에 대한 기억 — 선호, 작업 방식, 교정 사항."
        : null;
  const newHref = `#/new?scope=${scope}${projectId ? `&project=${projectId}` : ""}${standingOnly ? "&category=standing" : ""}`;

  return (
    <div className="with-toc">
      <article className="page">
        <header className="page-head">
          <div className="crumbs">{scope === "project" ? <a href="#/projects">프로젝트</a> : <a href="#/">홈</a>}</div>
          <h1>{title}</h1>
          {project.data && <ProjectHeader project={project.data} />}
          {lead && <p className="lead">{lead}</p>}
          {!standingOnly && <ScopeTabs scope={projectId ?? 0} active={scope === "user" ? "user" : "memory"} />}
          <div className="toolbar">
            <a className="btn primary" href={newHref}>
              + 새 메모리
            </a>
            {scope === "project" && projectId && (
              <>
                <a className="btn" href={`#/preview?project=${projectId}`}>
                  주입 미리보기
                </a>
              </>
            )}
            <input className="filter" placeholder="이 페이지에서 찾기…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        </header>
        <ErrorBox error={entries.error} />
        {!entries.loading && !groups.length && <Empty>{filter ? "일치하는 메모리가 없습니다." : "아직 메모리가 없습니다."}</Empty>}
        {groups.map((g) => (
          <section key={g.category} id={`cat-${g.category}`} className="cat-section">
            <h2>
              {CATEGORY_LABEL[g.category] ?? g.category} <span className="count">{g.items.length}</span>
            </h2>
            {g.items.map((e) => (
              <EntryCard key={e.id} entry={e} />
            ))}
          </section>
        ))}
      </article>
      {groups.length > 1 && (
        <nav className="toc">
          <div className="toc-title">목차</div>
          {groups.map((g) => (
            <a
              key={g.category}
              href={`#cat-${g.category}`}
              onClick={(ev) => {
                ev.preventDefault();
                document.getElementById(`cat-${g.category}`)?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              {CATEGORY_LABEL[g.category] ?? g.category} <span className="count">{g.items.length}</span>
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}

function ProjectHeader({ project }: { project: Project }) {
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(project.description);
  return (
    <div className="project-meta">
      <code>{project.key}</code>
      {project.last_seen_at && (
        <span className="muted">
          · 마지막 사용 <Time iso={project.last_seen_at} />
        </span>
      )}
      {editing ? (
        <div className="desc-edit">
          <textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="프로젝트 설명 (사람이 보는 용도)" />
          <div className="row">
            <button className="btn primary" onClick={() => act(() => api.updateProject(project.id, { description: desc })).then(() => setEditing(false))}>
              저장
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              취소
            </button>
            <button
              className="btn danger ghost right"
              onClick={() => {
                if (confirm(`프로젝트 "${project.name}"와 모든 메모리·턴 기록을 영구 삭제할까요?`))
                  act(() => api.deleteProject(project.id)).then(() => go("/projects"));
              }}
            >
              프로젝트 삭제
            </button>
          </div>
        </div>
      ) : (
        <div className="desc" onClick={() => setEditing(true)} title="클릭해서 편집">
          {project.description ? <Markdown>{project.description}</Markdown> : <span className="muted">설명 추가…</span>}
        </div>
      )}
    </div>
  );
}

export function EntryCard({ entry: e, showScope }: { entry: Entry; showScope?: boolean }) {
  return (
    <div className={`entry-card${e.pinned ? " pinned" : ""}`}>
      <div className="entry-card-head">
        <a className="entry-title" href={`#/e/${e.id}`}>
          {e.pinned && <span title="고정됨">📌 </span>}
          {e.title}
        </a>
        <div className="entry-actions">
          <a className="icon-btn" href={`#/e/${e.id}/edit`} title="편집">
            ✎
          </a>
          <button
            className="icon-btn"
            title="삭제"
            onClick={() => {
              if (confirm(`"${e.title}" 를 삭제할까요? (휴지통에서 복원 가능)`)) act(() => api.deleteEntry(e.id));
            }}
          >
            🗑
          </button>
        </div>
      </div>
      {e.body && <Markdown>{e.body}</Markdown>}
      <div className="entry-meta">
        {showScope && <CategoryBadge category={e.category} />}
        <SourceBadge source={e.source} />
        <Tags tags={e.tags} />
        <span className="muted">
          <Time iso={e.updated_at} />
        </span>
      </div>
    </div>
  );
}
