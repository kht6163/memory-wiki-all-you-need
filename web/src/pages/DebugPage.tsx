import "./debug.css";
import { api, type DebugInfo } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SkeletonList } from "../components/Skeleton.tsx";
import { Empty, ErrorBox, act, useData } from "../lib.tsx";

// Debug mode (ADR-0035): the server keeps one JSON-lines file per day with
// requests, recall reasons, searches, LLM prompts and replies, curation results
// and embedding calls. This page turns it on and off and lists the day files.

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const SOURCE: Record<DebugInfo["source"], string> = { env: "환경 변수 DEBUG_MODE", file: "웹에서 설정", default: "기본값" };

export function DebugPage() {
  const { data, error, loading, reload } = useData(() => api.debug(), []);
  const toggle = (enabled: boolean) => act(() => api.setDebug(enabled), { success: enabled ? "디버그 모드를 켰습니다" : "디버그 모드를 껐습니다" }).then(() => reload());
  return (
    <article className="page">
      <PageHeader title="디버그 모드" lead="켜 두면 서버가 요청, 회상 근거, 검색 결과, LLM 프롬프트와 응답, 턴 정리 결과, 임베딩 호출을 날짜별 파일로 모읍니다. 기능을 조정할 때 씁니다." busy={loading && Boolean(data)} />
      <ErrorBox error={error} />
      {loading && !data && <SkeletonList rows={2} />}
      {data && (
        <>
          <dl className="card debug-state">
            <dt id="debug-switch-label">디버그 모드</dt>
            <dd>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={data.enabled}
                aria-labelledby="debug-switch-label"
                disabled={data.source === "env"}
                title={data.source === "env" ? "DEBUG_MODE 환경 변수로 켜져 있습니다" : data.enabled ? "끄기" : "켜기"}
                onClick={() => toggle(!data.enabled)}
              />
              <span className="muted small"> {SOURCE[data.source]}</span>
            </dd>
            <dt>저장 위치</dt>
            <dd>
              <code>{data.dir}</code>
            </dd>
            <dt>보관</dt>
            <dd>
              최근 {data.keepDays}일, 하루 최대 {data.maxMbPerDay} MB
            </dd>
          </dl>
          {data.enabled && (
            <div className="callout warn" role="note">
              <Icon name="alert-triangle" size={16} />
              <span className="callout-text">프롬프트와 대화 내용이 그대로 기록됩니다(알려진 비밀값 형태는 가림). 필요한 동안만 켜 두세요.</span>
            </div>
          )}
          <div className="section-head">
            <h2>날짜별 기록</h2>
            <span className="count">{data.files.length}</span>
          </div>
          {data.files.length === 0 ? (
            <Empty icon="file-text" title="기록이 없습니다">
              디버그 모드를 켜면 오늘 날짜 파일부터 쌓입니다.
            </Empty>
          ) : (
            <div className="list">
              {data.files.map((f) => (
                <div key={f.date} className="list-row debug-file">
                  <Icon name="file-text" size={16} />
                  <span className="tabular">{f.date}</span>
                  <span className="muted small tabular">{kb(f.bytes)}</span>
                  <a className="btn small" href={`/api/debug/logs/${f.date}`} target="_blank" rel="noreferrer">
                    열기
                  </a>
                  <a className="btn small" href={`/api/debug/logs/${f.date}?download=1`}>
                    받기
                  </a>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </article>
  );
}
