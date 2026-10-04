# memory-wiki-all-you-need

pi 코딩 에이전트용 중앙 메모리 + 프로젝트 위키. 메모리는 pi-hermes-memory처럼 동작하지만 저장소가 각 PC가 아니라 서버 하나에 있다. 위키는 메모리와 독립된 문서 공간으로, 사람과 에이전트가 쓰고, 요청하면 LLM이 턴 기록을 읽어 페이지로 정리한다.

```
pi (각 PC) ── pi-extension ──HTTP──▶ server (Node 24 + node:sqlite FTS5)
                                      ├─ 턴 큐 ─▶ LLM 메모리 정리 (OpenAI 호환, cli-proxy)
                                      ├─ 위키 정리 작업 (요청 시, 턴 기록 → 페이지)
브라우저 ─────────────────────────────▶ └─ 웹 UI (web/, 같은 포트)
```

## 동작

- **주입 (강제)**: `before_agent_start`마다 서버에서 메모리 블록을 받아 시스템 프롬프트 `memory-context` 섹션에 넣는다. 블록은 정책, 고정 지시, 사용자 프로필, 프로젝트·전역 메모리 순(예산 `CONTEXT_BUDGET_CHARS`). 메모리가 바뀔 때만 내용이 바뀌어 프롬프트 캐시가 유지된다. 이번 프롬프트와 관련된 나머지 메모리는 숨은 메시지(`memory-recall`)로 붙는다. 서버가 응답하지 않으면 직전 블록을 쓴다.
- **턴 정리**: `message_end`로 턴을 모으고, `agent_settled`(재시도·압축·대기 작업까지 끝난 완전 대기) 후 `MEMORY_SETTLE_DELAY_MS`(기본 8초) 지나면 서버로 보낸다. 그 사이 새 프롬프트가 오면 합쳐서 나중에 보낸다. 종료 시(`session_shutdown`)에는 즉시 보낸다. 서버는 턴마다 관련 기존 메모리(같은 세션의 앞 턴이 쓴 메모리 포함)를 함께 LLM에 보여주고 add/update/edit(정확히 한 번 나오는 문장만 교체)/delete/confirm을 받아 바로 반영한다(모든 변경은 이력에 남고 되돌릴 수 있음). 이미 있는 메모리와 똑같은 add는 건너뛴다.
  - 날짜: "어제" 같은 상대 표현은 정리 시점이 아니라 **턴이 일어난 날**(`TIMEZONE` 기준)로 바꿔 적는다.
  - 출처: 메모리마다 어느 턴에서 추가·수정·확인됐는지 남는다.
- **지난 사실**: 세상이 바뀌면(라이브러리 교체, 버전 업) 새 메모리가 `supersedes`로 옛 메모리를 **대체**하고, 옛 메모리는 지우지 않고 이력으로 남는다. 임시 사실은 `valid_until`(유효 기한)이 지나면 같은 처리. 이력은 주입·회상되지 않지만 웹과 검색(`inactive=1`)에서 볼 수 있다. 옛 이름으로 물으면 회상이 새 메모리를 대신 붙인다.
- **검색 키워드**: 메모리에 동의어·번역·다른 표기(`Postgres`, `포스트그레스`)를 달아 두면 검색·회상에만 쓰이고 프롬프트에는 들어가지 않는다(벡터 검색 없이 어휘 차이를 메움).
- **정리 방침**: 서버 LLM이 정리·점검·위키 정리 때 따를 규칙(예: "테스트 픽스처 이름은 기억하지 말 것")을 전역·프로젝트별로 사람이 적어 둔다. 프로젝트 설명도 주입 블록과 정리 프롬프트에 들어간다.
- **프로젝트 구분 (클라이언트)**: cwd가 속한 git 저장소(worktree는 메인 저장소)의 `origin` 주소를 정규화해 키로 쓴다(`github.com/foo/bar`). 원격이 없으면 `local/<폴더명>`, git 밖이면 전역만. `MEMORY_PROJECT`로 덮어쓸 수 있다.
- **메모리 그래프**: 메모리는 엔티티(기술·서비스·도구·파일·개념·사람)를 언급하고, 메모리끼리는 `because`(이유)·`depends_on`(전제)·`supersedes`(대체)·`related`(관련)로 잇는다. 턴 정리 LLM이 같은 호출에서 엔티티와 관계를 함께 정하고(추가 LLM 호출 없음), 기존 메모리는 웹의 "그래프 붙이기"로 백필한다. 엔티티는 프로젝트를 가로질러 공유되며, 이름 변경·합치기 시 예전 이름이 별칭으로 남는다.
  - 회상: 프롬프트가 언급한 엔티티를 다루는 검색 결과를 앞으로 올리고(많은 메모리가 공유하는 엔티티일수록 약하게), 그 엔티티의 메모리와 회상된 메모리의 이유·전제·대체 이웃(필요하면 `depends_on`/`because` 2단계)을 `GRAPH_RECALL_EXTRA`개까지 더한다(`RECALL_BUDGET_CHARS` 안에서, `(graph: …)` 표시).
  - 비슷한 엔티티 제안: 이름 트라이그램 유사도와 함께 언급된 정도로 "PostgreSQL ↔ Postgres" 같은 쌍을 찾아 합치기를 제안한다(LLM 없음). 관계·엔티티 변경(이름 변경·합치기·삭제)은 이력에 남고 되돌릴 수 있다.
  - 웹: 그래프 뷰(`#/graph`, 프로젝트별 탭), 엔티티 목록·상세(합치기·이름 변경·변경 이력), 메모리 상세의 "연결"에서 엔티티·관계 편집.
- **메모리 점검**: 웹의 "메모리 점검"에서 범위(프로젝트, 또는 전역·사용자)를 골라 시작하면 LLM이 같은 엔티티를 가진 메모리끼리 묶어 읽고 합치기·고치기·삭제·모순을 **제안**한다. 사람이 적용하기 전에는 바뀌지 않고, 제안 뒤 메모리가 바뀌었으면(리비전 기준) 적용하지 않고 "오래됨"으로 돌린다. 합치기는 첫 메모리를 남기고 엔티티·관계를 옮긴 뒤 나머지를 소프트 삭제한다. 무시한 제안은 메모리가 바뀌기 전까지 다시 묻지 않는다. 긴 메모리는 본문 전체 대신 한 구절만 바꾸는 제안을 받는다. `REVIEW_EVERY_DAYS`를 켜면 바뀐 범위를 주기적으로 점검해 제안만 쌓는다.
- **작업 취소**: 위키 정리·그래프 백필·점검 작업은 대기·실행 중에 취소할 수 있고(진행 중이던 LLM 응답은 쓰지 않음), 취소한 작업도 이어서 다시 실행할 수 있다.
- **사용 기록**: 회상(`/context`)과 에이전트 검색(`memory_search`, `memory_graph`)에 쓰인 횟수·시각, 기본 블록에 들어간 날을 메모리마다 기록한다. 기본 블록은 최근에 쓰인 메모리를 앞에 두되 **전날까지의** 사용만 반영해 하루 동안 순서가 바뀌지 않는다(프롬프트 캐시 유지). 오래 안 쓰이고 주입되지도 않은 메모리는 점검 화면에 따로 보여준다.
- **도구**: `memory_search`, `session_search`, `memory_add`, `memory_replace`, `memory_remove` (pi-hermes-memory와 같은 이름·target), `memory_graph`, `wiki_search`, `wiki_read`, `wiki_write`.
- **명령**: `/memory`(상태·위키 링크), `/memory-pin <text> [--project]`(고정 지시), `/memory-flush`, `/wiki-compose [정리 방향]`(현재 세션의 턴을 위키로 정리).
- **위키 (메모리와 독립)**: 프로젝트별 위키와 전역 위키. 페이지는 `[[slug]]`로 잇고, 필요하면 `[#id]`로 메모리를 참조한다(링크일 뿐 동기화하지 않음). 이력·되돌리기·백링크·검색·잠금을 지원한다. "위키 점검"이 고아 페이지, 없는 페이지 링크, 지워지거나 대체된 메모리 인용, 빈 페이지를 LLM 없이 찾아 준다. pi에는 페이지 목록만 주입되고 `wiki_search`/`wiki_read`로 읽으며, 사용자가 요청하면 `wiki_write`로 쓴다.
- **턴 기록으로 위키 정리**: 웹의 "턴 기록으로 정리"에서 턴을 고르거나(기본: 이 위키에 아직 정리 안 된 턴) pi에서 `/wiki-compose`를 실행하면, LLM이 대화와 도구 실행 결과를 읽고 남길 만한 내용(구조, 결정과 이유, 절차, 문제 해결)을 페이지에 반영한다. 자동으로는 돌지 않는다. 턴이 많으면 `WIKI_COMPOSE_CHUNK_CHARS` 단위로 나눠 차례로 처리하므로 한 번의 LLM 호출 크기는 위키·기록 규모와 무관하다. 잠근 페이지와 이번 호출에서 본문을 보지 못한 페이지는 고치지 않는다.
- **보호**: 비밀값처럼 보이는 내용은 저장 거부, 턴 기록에서는 가림. 고정 지시(`standing`)와 정리 방침은 사람만 쓰고 고칠 수 있다.
- **웹 UI**: 라이트·다크 테마, `⌘K`/`Ctrl K` 명령 팔레트(초성 검색 포함), 키보드 단축키(`?`로 목록), 되돌리기 토스트, 모바일 서랍 메뉴. 글꼴(Pretendard, JetBrains Mono)은 이미지에 포함돼 외부 CDN 없이 뜬다.
- **DB 마이그레이션**: 스키마는 번호 있는 단계로 기동 시 자동으로 올라간다. 더 새 버전의 DB는 열지 않으므로, 업데이트 전에 백업해 두면 되돌릴 수 있다.

## 메모리 모델

| 필드 | 값 |
|---|---|
| scope | `global` / `user` / `project` |
| category | `standing` `convention` `decision` `fact` `preference` `correction` `failure` `tool-quirk` `insight` |
| source | `human` / `llm` / `agent` (마지막 작성자) |
| keywords | 검색 전용 단어(주입 안 됨) |
| valid_until | 유효 기한 `YYYY-MM-DD`(지나면 이력) |

## 설치

서버 (docker compose 예시, `LLM_API_KEY`는 `.env`에):

```yaml
services:
  memory:
    build: ./memory-wiki-all-you-need   # 이 저장소
    restart: unless-stopped
    environment:
      LLM_BASE_URL: http://<llm-host>:8317/v1
      LLM_API_KEY: ${LLM_API_KEY:?missing}
      LLM_MODEL: gpt-6-luna
      TIMEZONE: Asia/Seoul
    ports:
      - "127.0.0.1:8765:8765"   # 로그인이 없으므로 신뢰하는 네트워크에만 바인딩
    volumes:
      - ./data:/data
```

| env | 기본값 | |
|---|---|---|
| `LLM_BASE_URL` | – | OpenAI 호환 `/v1` 주소. 없으면 턴은 저장만 하고 정리는 건너뜀 |
| `LLM_API_KEY`, `LLM_MODEL` | –, `gpt-6-luna` | |
| `CONTEXT_BUDGET_CHARS` | 8000 | 시스템 프롬프트 메모리 블록 예산 |
| `RECALL_BUDGET_CHARS`, `RECALL_LIMIT` | 3000, 6 | 프롬프트별 회상 |
| `WIKI_COMPOSE_CHUNK_CHARS` | 40000 | 위키 정리 시 LLM 호출 1회에 넣는 턴 기록 글자 수 |
| `WIKI_COMPOSE_MAX_TURNS` | 200 | 정리 작업 1건의 최대 턴 수 |
| `WIKI_WRITER_BUDGET_CHARS` | 40000 | 정리 호출 1회에 보여주는 기존 페이지 본문 예산 |
| `GRAPH_RECALL_EXTRA` | 4 | 그래프로 회상에 더하는 메모리 수 상한 |
| `GRAPH_BACKFILL_CHUNK_CHARS`, `GRAPH_BACKFILL_MAX` | 24000, 2000 | 그래프 백필 LLM 호출 1회 크기, 작업 1건 최대 메모리 수 |
| `REVIEW_CHUNK_CHARS`, `REVIEW_MAX_ENTRIES` | 24000, 2000 | 메모리 점검 LLM 호출 1회 크기, 작업 1건 최대 메모리 수 |
| `REVIEW_STALE_DAYS` | 60 | 이 기간 동안 사용·주입·수정이 없으면 "오래 안 쓰인 메모리" |
| `REVIEW_EVERY_DAYS` | 0 (끔) | 이 간격으로 바뀐 범위를 자동 점검(제안만 쌓음, LLM 필요) |
| `TIMEZONE` | `UTC` | 턴 정리에서 상대 날짜를 풀 때 쓰는 시간대(IANA, 예: `Asia/Seoul`) |

pi (각 PC):

```sh
curl -fsSL http://<서버 주소>:8765/install.sh | sh   # ~/.pi/agent/extensions/memory-wiki-all-you-need
```

또는 npm 패키지로 설치할 수 있습니다. 이때는 `MEMORY_SERVER_URL`을 직접 설정해야 합니다. 두 방식 중 하나만 쓰세요(둘 다 있으면 확장이 두 번 실행됨).

```sh
pi install npm:pi-memory-wiki-all-you-need
export MEMORY_SERVER_URL=http://<서버 주소>:8765
```

| env | 기본값 |
|---|---|
| `MEMORY_SERVER_URL` | 설치 스크립트: 설치한 서버 주소 · npm: `http://127.0.0.1:8765` |
| `MEMORY_SETTLE_DELAY_MS` | 8000 |
| `MEMORY_TIMEOUT_MS` | 1500 (주입 조회 타임아웃) |
| `MEMORY_PROJECT` | (자동) |
| `MEMORY_DISABLED=1` | 끄기 |

## 개발

```sh
npm install
npm run dev:server          # :8765 (PORT, DATA_DIR 로 변경)
npm run dev:web             # vite, /api 는 API_URL(기본 127.0.0.1:8765) 로 프록시
npm run typecheck
npm test                    # server/test — 테스트 파일마다 임시 DB와 가짜 LLM으로 회귀 가드 검증 (node --test)
npm run build               # 웹 UI
```

GitHub Actions(`.github/workflows/ci.yml`)가 push·PR마다 `npm ci` → typecheck → test → build를 돌린다.

## 라이선스

MIT — [LICENSE](LICENSE)
