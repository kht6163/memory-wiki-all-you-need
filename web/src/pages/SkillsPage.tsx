import "./skills.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Skill, type SkillRevision } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SkeletonList } from "../components/Skeleton.tsx";
import { Diff, Empty, ErrorBox, MOD_LABEL, SOURCE_LABEL, Time, act, changed, confirmDialog, errorText, leaveTo, useData, useLeaveGuard } from "../lib.tsx";
import { ScopeTabs } from "./WikiPages.tsx";

// Agent skills (ADR-0039, ADR-0040). Written here; each PC mirrors them one way
// with the pi extension (on every pi start and on /skills-sync) into
// ~/.pi/agent/extensions/memory-wiki-all-you-need/skills/. Edits made on a PC
// are overwritten by the next sync, so this is the only place to change them.
// The pi agent writes too (skill_manage): depending on the "skill approval"
// setting its skill or edit waits here for approval. Every write is in the
// history; deleting goes to the trash.

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;

const skillsHref = (scope: number) => `#/skills/${scope}`;
const pending = (s: Skill) => s.status === "candidate" || Boolean(s.draft);

const ACTION: Record<string, string> = {
  create: "만듦",
  update: "고침",
  delete: "휴지통으로 옮김",
  restore: "복원",
  revert: "되돌림",
  lock: "잠금",
  unlock: "잠금 풂",
  propose: "수정 제안",
  approve: "승인",
  reject: "거절",
};

function useScopeName(scope: number) {
  const project = useData(() => (scope ? api.project(scope) : Promise.resolve(null)), [scope]);
  return { project: project.data, name: scope ? project.data?.name ?? "프로젝트" : "전역" };
}

function SyncNote() {
  return (
    <p className="hint skills-sync-note">
      <Icon name="info" size={14} />
      <span>
        pi가 시작할 때와 <code>/skills-sync</code> 명령으로 각 PC에 내려갑니다(서버 → PC 한 방향). PC에서 고친 내용은 다음 동기화 때 이 내용으로
        덮어씁니다. pi 에이전트도 <code>skill_manage</code>로 만들고 고치며, <a href="#/settings">설정</a>에 따라 승인을 기다립니다(지우기는 여기서만).
      </span>
    </p>
  );
}

function SkillPills({ s }: { s: Skill }) {
  return (
    <>
      {s.status === "candidate" && (
        <span className="pill warn" title="에이전트가 만든 후보입니다. 승인해야 PC로 내려갑니다">
          승인 대기
        </span>
      )}
      {s.draft && (
        <span className="pill warn" title="에이전트가 고친 내용이 승인을 기다립니다. 그동안 지금 내용이 쓰입니다">
          수정 제안
        </span>
      )}
      {s.locked && (
        <span className="pill" title="사람만 고칠 수 있습니다">
          <Icon name="lock" size={11} />
          잠김
        </span>
      )}
      {s.author === "agent" && (
        <span className="pill" title="pi 에이전트가 마지막에 고쳤습니다">
          에이전트
        </span>
      )}
    </>
  );
}

function SkillRow({ s, scope, note }: { s: Skill; scope: number; note?: string }) {
  return (
    <a className="list-row skill-row" href={`${skillsHref(scope)}/${s.id}`}>
      <div className="skill-row-head">
        <span className="skill-name mono">{s.name}</span>
        {note && <span className="pill">{note}</span>}
        <SkillPills s={s} />
        <span className="faint small">
          <Time iso={s.updated_at} />
        </span>
      </div>
      <div className="skill-desc muted small">{s.description}</div>
    </a>
  );
}

function TrashRow({ s }: { s: Skill }) {
  const purge = async () => {
    const ok = await confirmDialog({
      title: `"${s.name}" 스킬을 완전히 지울까요?`,
      body: <p>수정 이력도 함께 지워지고 되돌릴 수 없습니다.</p>,
      confirmLabel: "완전히 지우기",
      danger: true,
    });
    if (ok) await act(() => api.purgeSkill(s.id), { success: "완전히 지웠습니다" });
  };
  return (
    <div className="list-row skill-row">
      <div className="skill-row-head">
        <span className="skill-name mono strike">{s.name}</span>
        <span className="faint small">
          <Time iso={s.deleted_at!} /> 지움
        </span>
      </div>
      <div className="skill-desc muted small">{s.description}</div>
      <div className="skill-trash-actions">
        <button className="btn small" onClick={() => act(() => api.restoreSkill(s.id), { success: "복원했습니다" })}>
          <Icon name="rotate-ccw" size={14} />
          복원
        </button>
        <button className="btn small ghost danger" onClick={purge}>
          <Icon name="trash-2" size={14} />
          완전히 지우기
        </button>
      </div>
    </div>
  );
}

export function SkillsList({ scope }: { scope: number }) {
  const { project, name } = useScopeName(scope);
  const skills = useData(() => api.skills(scope || null), [scope]);
  const trash = useData(() => api.skills(scope || null, { deleted: true }), [scope]);
  // A project also gets the global skills; one with the same name as a project skill is left out there.
  const globals = useData(() => (scope ? api.skills(null) : Promise.resolve([] as Skill[])), [scope]);
  const own = useMemo(() => new Set((skills.data ?? []).filter((s) => s.status === "active").map((s) => s.name)), [skills.data]);
  const waiting = (skills.data ?? []).filter(pending);
  const rest = (skills.data ?? []).filter((s) => !pending(s));
  const syncedGlobals = (globals.data ?? []).filter((g) => g.status === "active");
  // The global page also gathers what projects have waiting (the sidebar's "승인" count covers every scope).
  const everywhere = useData(() => (scope ? Promise.resolve([] as Skill[]) : api.allSkills()), [scope]);
  const projectWaiting = (everywhere.data ?? []).filter((s) => s.project_id != null && pending(s));
  const projects = useData(() => (projectWaiting.length ? api.projects() : Promise.resolve([])), [projectWaiting.length > 0]);
  const projectName = (id: number) => projects.data?.find((p) => p.id === id)?.name ?? `프로젝트 #${id}`;
  return (
    <article className="page">
      <PageHeader
        crumbs={scope ? <a href="#/projects">프로젝트</a> : <a href="#/">홈</a>}
        title={`${name} 스킬`}
        lead={
          scope
            ? "이 프로젝트에서만 쓰는 절차입니다. pi는 이름과 설명을 보고 작업이 맞을 때 본문을 읽어 따릅니다."
            : "모든 프로젝트에서 쓰는 절차입니다. pi는 이름과 설명을 보고 작업이 맞을 때 본문을 읽어 따릅니다."
        }
        busy={skills.loading && Boolean(skills.data)}
        actions={
          <a className="btn primary" href={`${skillsHref(scope)}/~new`}>
            <Icon name="plus" />새 스킬
          </a>
        }
        tabs={<ScopeTabs scope={scope} active="skills" />}
      >
        {project && <code className="key">{project.key}</code>}
      </PageHeader>
      <SyncNote />
      <ErrorBox error={skills.error} />
      {skills.loading && !skills.data && <SkeletonList rows={3} />}
      {waiting.length > 0 && (
        <>
          <div className="section-head">
            <h2>승인 대기</h2>
            <span className="count">{waiting.length}</span>
          </div>
          <p className="hint">에이전트가 만들거나 고친 것입니다. 열어서 내용을 보고 승인하거나 거절하세요. 승인 전에는 어느 PC에도 내려가지 않습니다.</p>
          <div className="list">
            {waiting.map((s) => (
              <SkillRow key={s.id} s={s} scope={scope} />
            ))}
          </div>
        </>
      )}
      {projectWaiting.length > 0 && (
        <>
          <div className="section-head">
            <h2>프로젝트 스킬 승인 대기</h2>
            <span className="count">{projectWaiting.length}</span>
          </div>
          <div className="list">
            {projectWaiting.map((s) => (
              <SkillRow key={s.id} s={s} scope={s.project_id!} note={projectName(s.project_id!)} />
            ))}
          </div>
        </>
      )}
      {skills.data?.length === 0 && (
        <Empty
          icon="lightbulb"
          title="아직 스킬이 없습니다"
          action={
            <a className="btn primary" href={`${skillsHref(scope)}/~new`}>
              <Icon name="plus" />새 스킬
            </a>
          }
        >
          반복하는 작업 절차(배포, 릴리스, 점검 순서 등)를 스킬로 적어 두면 pi가 필요할 때 읽고 따릅니다.
        </Empty>
      )}
      {rest.length > 0 && (
        <>
          {(waiting.length > 0 || projectWaiting.length > 0) && (
            <div className="section-head">
              <h2>스킬</h2>
              <span className="count">{rest.length}</span>
            </div>
          )}
          <div className="list">
            {rest.map((s) => (
              <SkillRow key={s.id} s={s} scope={scope} />
            ))}
          </div>
        </>
      )}
      {scope > 0 && syncedGlobals.length > 0 && (
        <>
          <div className="section-head">
            <h2>함께 내려가는 전역 스킬</h2>
            <span className="count">{syncedGlobals.filter((g) => !own.has(g.name)).length}</span>
          </div>
          <div className="list">
            {syncedGlobals.map((g) => (
              <SkillRow key={g.id} s={g} scope={0} note={own.has(g.name) ? "이 프로젝트 스킬로 대체됨" : undefined} />
            ))}
          </div>
        </>
      )}
      {trash.data && trash.data.length > 0 && (
        <details className="skills-trash">
          <summary>
            휴지통 <span className="count">{trash.data.length}</span>
          </summary>
          <p className="hint">PC에서는 이미 지워졌습니다. 같은 이름의 스킬이 없을 때 복원할 수 있습니다.</p>
          <div className="list">
            {trash.data.map((s) => (
              <TrashRow key={s.id} s={s} />
            ))}
          </div>
        </details>
      )}
    </article>
  );
}

interface Form {
  name: string;
  description: string;
  body: string;
}

const EMPTY: Form = { name: "", description: "", body: "" };

/** Problems shown under the fields before saving (the server checks the same rules). */
function formProblems(f: Form): { name?: string; description?: string } {
  const name = f.name.trim();
  const out: { name?: string; description?: string } = {};
  if (name && (name.length > NAME_MAX || !NAME_RE.test(name))) out.name = `영어 소문자·숫자와 하이픈(-)만, 최대 ${NAME_MAX}자 (예: deploy-release)`;
  if (f.description.trim().length > DESCRIPTION_MAX) out.description = `최대 ${DESCRIPTION_MAX}자`;
  return out;
}

/** Before an action that replaces the content: an unsaved edit in the form would be lost (the form then follows the server). */
async function okToDiscard(dirty: boolean): Promise<boolean> {
  if (!dirty) return true;
  return confirmDialog({ title: "저장하지 않은 편집이 있습니다", body: <p>계속하면 편집기에 쓴 내용은 버리고 서버의 새 내용을 보여 줍니다.</p>, confirmLabel: "버리고 계속", danger: true });
}

/** An agent's candidate skill or waiting edit, with approve / reject. `seen` = the versions on screen (anything newer is refused). */
function ApprovalCard({ s, dirty, onApplied }: { s: Skill; dirty: boolean; onApplied: () => void }) {
  const seen = { updated_at: s.updated_at, draft_at: s.draft?.at };
  const approve = async () => {
    if (!(await okToDiscard(dirty))) return;
    onApplied();
    await act(() => api.approveSkill(s.id, seen), { success: s.draft ? "수정 제안을 적용했습니다" : "승인했습니다. 다음 동기화부터 PC로 내려갑니다" });
  };
  const reject = async () => {
    const ok = await confirmDialog({
      title: s.draft ? "수정 제안을 거절할까요?" : `"${s.name}" 후보를 거절할까요?`,
      body: <p>{s.draft ? "지금 내용은 그대로 쓰이고, 제안은 수정 이력에 남습니다." : "스킬이 휴지통으로 갑니다. 휴지통에서 복원할 수 있습니다."}</p>,
      confirmLabel: "거절",
      danger: true,
    });
    if (ok) await act(() => api.rejectSkill(s.id, seen), { success: "거절했습니다" });
  };
  return (
    <section className="card skill-approval" aria-label="승인 대기">
      <div className="skill-approval-head">
        <Icon name="alert-triangle" size={16} />
        {s.draft ? (
          <strong>
            에이전트의 수정 제안 · <Time iso={s.draft.at} />
          </strong>
        ) : (
          <strong>에이전트가 만든 후보 스킬입니다. 승인해야 PC로 내려갑니다.</strong>
        )}
      </div>
      {s.draft && (
        <div className="skill-approval-diff">
          {s.draft.description !== s.description && (
            <>
              <div className="muted small">설명</div>
              <Diff a={s.description} b={s.draft.description} />
            </>
          )}
          <div className="muted small">본문 (지금 → 제안)</div>
          <Diff a={s.body} b={s.draft.body} />
        </div>
      )}
      {!s.draft && <p className="muted small">아래 내용을 확인하세요. 고친 뒤 승인해도 됩니다.</p>}
      <div className="skill-approval-actions">
        <button className="btn primary" onClick={approve}>
          <Icon name="check" />
          {s.draft ? "제안 적용" : "승인"}
        </button>
        <button className="btn ghost danger" onClick={reject}>
          <Icon name="x" />
          거절
        </button>
      </div>
    </section>
  );
}

function SkillHistory({ skill, dirty, onApplied }: { skill: Skill; dirty: boolean; onApplied: () => void }) {
  const revs = useData(() => api.skillRevisions(skill.id), [skill.id]);
  if (!revs.data?.length) return null;
  return (
    <>
      <h2>수정 이력</h2>
      <ol className="history">
        {revs.data.map((r, i) => (
          <SkillRevisionItem
            key={r.id}
            rev={r}
            prev={revs.data!.slice(i + 1).find((x) => x.action !== "propose" && x.action !== "reject")}
            skill={skill}
            dirty={dirty}
            onApplied={onApplied}
          />
        ))}
      </ol>
    </>
  );
}

function SkillRevisionItem({ rev, prev, skill, dirty, onApplied }: { rev: SkillRevision; prev?: SkillRevision; skill: Skill; dirty: boolean; onApplied: () => void }) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen(!open);
  const differs = rev.description !== skill.description || rev.body !== skill.body;
  // A proposal is applied with "제안 적용", not by reverting to it.
  const canRevert = differs && !skill.deleted_at && !["delete", "propose", "reject"].includes(rev.action);
  return (
    <li className="rev">
      <div
        className="rev-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className={`dot src-${rev.author}`} />
        <strong>{SOURCE_LABEL[rev.author as keyof typeof SOURCE_LABEL] ?? rev.author}</strong> {ACTION[rev.action] ?? rev.action}
        <span className="muted">
          {" "}
          · <Time iso={rev.created_at} />
        </span>
        {canRevert && (
          <button
            className="btn small right"
            onClick={async (e) => {
              e.stopPropagation();
              const ok = await confirmDialog({ title: "이 내용으로 되돌릴까요?", body: <p>설명과 본문이 이 판으로 바뀌고, 지금 내용은 수정 이력에 남습니다.</p>, confirmLabel: "되돌리기" });
              if (!ok || !(await okToDiscard(dirty))) return;
              onApplied();
              await act(() => api.revertSkill(skill.id, rev.id), { success: "되돌렸습니다" });
            }}
          >
            <Icon name="rotate-ccw" size={14} />이 내용으로 되돌리기
          </button>
        )}
      </div>
      {rev.reason && <div className="rev-reason">{rev.reason}</div>}
      {open && (
        <div className="rev-body">
          {prev ? <Diff a={`${prev.description}\n\n${prev.body}`} b={`${rev.description}\n\n${rev.body}`} /> : <pre className="diff">{`${rev.description}\n\n${rev.body}`}</pre>}
        </div>
      )}
    </li>
  );
}

export function SkillEdit({ scope, id }: { scope: number; id?: number }) {
  const { name: scopeName } = useScopeName(scope);
  const existing = useData(() => (id ? api.skill(id) : Promise.resolve(null)), [id]);
  const [form, setForm] = useState<Form | null>(id ? null : EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState<Form>(EMPTY);
  const dirty = Boolean(form) && (form!.name !== base.name || form!.description !== base.description || form!.body !== base.body);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Approve / revert from this page replaced the content: follow the server even over an edit (already confirmed).
  const resync = useRef(false);
  // Follow the server (an agent edit, another tab…) only while nothing is being typed:
  // a refetch (any act() fires "memory:changed") must not wipe an edit in progress.
  useEffect(() => {
    const d = existing.data;
    if (!d || (dirtyRef.current && !resync.current)) return;
    resync.current = false;
    const f = { name: d.name, description: d.description, body: d.body };
    setBase(f);
    setForm(f);
  }, [existing.data]);

  useLeaveGuard(id ? `/skills/${scope}/${id}` : `/skills/${scope}/~new`, dirty && !saving);
  const problems = form ? formProblems(form) : {};
  const ready = Boolean(form && form.name.trim() && form.description.trim() && form.body.trim() && !problems.name && !problems.description);
  // A skill opened from another scope's link (e.g. a global one from a project list) is edited where it lives.
  const home = existing.data ? existing.data.project_id ?? 0 : scope;
  const s = existing.data;

  const save = async () => {
    if (!form || saving || !ready || s?.deleted_at) return;
    setSaving(true);
    setError(null);
    try {
      const body = { name: form.name.trim(), description: form.description.trim(), body: form.body };
      if (id) await api.updateSkill(id, body);
      else await api.createSkill({ project_id: scope || null, ...body });
      changed();
      leaveTo(`/skills/${home}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || document.querySelector("dialog[open]")) return;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const remove = async () => {
    if (!s) return;
    const ok = await confirmDialog({
      title: `"${s.name}" 스킬을 휴지통으로 옮길까요?`,
      body: <p>각 PC에서는 다음 동기화 때 이 스킬 파일이 지워집니다. 휴지통에서 복원할 수 있습니다.</p>,
      confirmLabel: "휴지통으로",
      danger: true,
    });
    if (!ok) return;
    const done = await act(() => api.deleteSkill(s.id), { success: "휴지통으로 옮겼습니다" });
    if (done) leaveTo(`/skills/${home}`);
  };

  const toggleLock = () =>
    s && act(() => api.updateSkill(s.id, { locked: !s.locked }), { success: s.locked ? "잠금을 풀었습니다" : "잠갔습니다. 이제 에이전트는 고칠 수 없습니다" });

  const set = (k: keyof Form, v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <article className="page edit-page">
      <PageHeader
        crumbs={<a href={skillsHref(home)}>{home === scope ? scopeName : "전역"} 스킬</a>}
        title={id ? s?.name ?? "스킬" : "새 스킬"}
        lead={
          s?.author === "agent" && !s.deleted_at ? (
            <>
              pi 에이전트가 <Time iso={s.updated_at} />에 마지막으로 고쳤습니다. 저장하면 사람이 고친 것으로 바뀝니다.
            </>
          ) : undefined
        }
        actions={
          s &&
          !s.deleted_at && (
            <>
              <button className="btn ghost" onClick={toggleLock} title={s.locked ? "에이전트도 고칠 수 있게 합니다" : "사람만 고칠 수 있게 합니다"}>
                <Icon name="lock" />
                {s.locked ? "잠금 풀기" : "잠그기"}
              </button>
              <button className="btn ghost danger" onClick={remove}>
                <Icon name="trash-2" />
                지우기
              </button>
            </>
          )
        }
      >
        {s && <SkillPills s={s} />}
      </PageHeader>
      <ErrorBox error={error ?? existing.error} />
      {id && !form && !existing.error && <SkeletonList rows={3} />}
      {s?.deleted_at && (
        <div className="notice">
          휴지통에 있는 스킬입니다(<Time iso={s.deleted_at} /> 지움).{" "}
          <button className="btn small" onClick={() => act(() => api.restoreSkill(s.id), { success: "복원했습니다" })}>
            <Icon name="rotate-ccw" size={14} />
            복원
          </button>
        </div>
      )}
      {s && !s.deleted_at && pending(s) && <ApprovalCard s={s} dirty={dirty} onApplied={() => (resync.current = true)} />}
      {form && !s?.deleted_at && (
        <>
          <div className="form">
            <label>
              이름
              <input
                className="mono"
                value={form.name}
                placeholder="deploy-release"
                maxLength={NAME_MAX}
                autoFocus={!id}
                aria-invalid={Boolean(problems.name) || undefined}
                aria-describedby="skill-name-help"
                onChange={(e) => set("name", e.target.value)}
              />
              <span id="skill-name-help" className={problems.name ? "error-text small" : "hint"}>
                {problems.name ?? "pi의 /skill:이름 명령과 파일 이름이 됩니다. 영어 소문자·숫자·하이픈"}
              </span>
            </label>
            <label>
              설명 — 무엇을 하고 언제 쓰는지
              <textarea
                rows={2}
                value={form.description}
                placeholder="새 버전을 배포한다: 백업, 버전 올리기, 테스트, 태그, 운영 반영. 사용자가 배포·릴리스를 요청할 때 사용."
                aria-invalid={Boolean(problems.description) || undefined}
                aria-describedby="skill-desc-help"
                onChange={(e) => set("description", e.target.value)}
              />
              <span id="skill-desc-help" className={problems.description ? "error-text small" : "hint"}>
                {problems.description ?? `pi는 이 설명만 보고 스킬을 읽을지 정합니다. 한 줄로, 최대 ${DESCRIPTION_MAX}자`}
              </span>
            </label>
            <label>
              본문 (Markdown) — 에이전트가 따를 절차
              <textarea
                className="skill-body mono"
                value={form.body}
                placeholder={"## 절차\n1. …\n2. …\n\n## 주의\n- …"}
                onChange={(e) => set("body", e.target.value)}
              />
            </label>
          </div>
          <SyncNote />
          <div className="edit-footer">
            <button className="btn primary" disabled={saving || !ready} aria-busy={saving || undefined} onClick={save} title={`저장 (${MOD_LABEL}+S)`}>
              {saving ? "저장 중…" : "저장"} <kbd>{MOD_LABEL === "⌘" ? "⌘S" : "Ctrl+S"}</kbd>
            </button>
            <a className="btn ghost" href={skillsHref(home)}>
              취소
            </a>
            <span className="spacer" />
            {dirty && <span className="dirty-note">저장 안 된 변경</span>}
          </div>
        </>
      )}
      {s && <SkillHistory skill={s} dirty={dirty} onApplied={() => (resync.current = true)} />}
    </article>
  );
}
