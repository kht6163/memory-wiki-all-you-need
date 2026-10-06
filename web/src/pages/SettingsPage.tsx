import "./debug.css";
import { api, type SkillApproval, type SwitchState } from "../api.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { SkeletonList } from "../components/Skeleton.tsx";
import { ErrorBox, act, useData } from "../lib.tsx";

// Feature switches (ADR-0038). The server keeps them in <DATA_DIR>/settings.json;
// one fixed by an env var is shown but cannot be changed here.

const SOURCE: Record<SwitchState["source"], string> = { env: "환경 변수", file: "웹에서 설정", default: "기본값" };

const APPROVAL: { value: SkillApproval; label: string; help: string }[] = [
  { value: "off", label: "안 함", help: "에이전트가 만들고 고친 스킬이 바로 PC로 내려갑니다." },
  { value: "global", label: "전역 스킬만", help: "전역 스킬은 모든 프로젝트·PC로 퍼지므로 승인 뒤에 내려갑니다. 프로젝트 스킬은 바로 내려갑니다." },
  { value: "all", label: "모두", help: "에이전트가 만들거나 고친 스킬은 모두 승인 뒤에 내려갑니다." },
];

export function SettingsPage({ onChange }: { onChange?: () => void }) {
  const { data, error, loading, reload } = useData(() => api.settings(), []);
  const compose = data?.wikiCompose;
  const toggleCompose = (enabled: boolean) =>
    act(() => api.setSettings({ wikiCompose: enabled }), { success: enabled ? "턴 기록으로 위키 정리를 켰습니다" : "턴 기록으로 위키 정리를 껐습니다" }).then(() => {
      reload();
      onChange?.();
    });
  const approval = data?.skillApproval;
  const setApproval = (value: SkillApproval) =>
    act(() => api.setSettings({ skillApproval: value }), { success: `에이전트 스킬 승인: ${APPROVAL.find((a) => a.value === value)!.label}` }).then(() => {
      reload();
      onChange?.();
    });
  return (
    <article className="page">
      <PageHeader title="설정" lead="서버 기능을 켜고 끕니다. 서버 환경 변수로 정해 둔 항목은 여기서 바꿀 수 없습니다." busy={loading && Boolean(data)} />
      <ErrorBox error={error} />
      {loading && !data && <SkeletonList rows={1} />}
      {compose && (
        <dl className="card settings-state">
          <dt id="compose-switch-label">턴 기록으로 위키 정리</dt>
          <dd>
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={compose.enabled}
              aria-labelledby="compose-switch-label"
              aria-describedby="compose-switch-help"
              disabled={compose.source === "env"}
              title={compose.source === "env" ? "WIKI_COMPOSE 환경 변수로 정해져 있습니다" : compose.enabled ? "끄기" : "켜기"}
              onClick={() => toggleCompose(!compose.enabled)}
            />
            <span className="muted small"> {compose.source === "env" ? `${SOURCE.env} WIKI_COMPOSE` : SOURCE[compose.source]}</span>
          </dd>
          <dd id="compose-switch-help" className="settings-help muted small">
            고른 턴 기록을 서버 LLM이 읽고 위키 페이지로 정리하는 기능입니다(웹의 "턴 기록으로 정리", pi의 <code>/wiki-compose</code>). 끄면 새 정리 요청과 다시
            실행을 받지 않고, 대기 중인 작업은 다시 켤 때까지 기다립니다. 사람이나 pi 에이전트가 페이지를 직접 쓰는 것에는 영향이 없습니다.
          </dd>
        </dl>
      )}
      {approval && (
        <dl className="card settings-state">
          <dt id="approval-label">에이전트 스킬 승인</dt>
          <dd>
            <select aria-labelledby="approval-label" aria-describedby="approval-help" value={approval.value} onChange={(e) => setApproval(e.target.value as SkillApproval)}>
              {APPROVAL.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
            <span className="muted small"> {SOURCE[approval.source]}</span>
          </dd>
          <dd id="approval-help" className="settings-help muted small">
            pi 에이전트가 <code>skill_manage</code>로 만들거나 고친 스킬을 사람이 승인해야 PC로 내려가게 합니다.{" "}
            {APPROVAL.find((a) => a.value === approval.value)!.help} 승인할 것은 각 스킬 화면의 "승인 대기"에 모입니다. 사람이 웹에서 쓰는 것은
            언제나 바로 반영됩니다.
          </dd>
        </dl>
      )}
      <p className="muted small">
        요청과 프롬프트 기록은 <a href="#/debug">디버그 모드</a>에서 켜고 끕니다.
      </p>
    </article>
  );
}
