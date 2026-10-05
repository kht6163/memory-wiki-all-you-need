<div align="center">

# memory-wiki-all-you-need

**[pi](https://github.com/earendil-works/pi) 코딩 에이전트를 위한 중앙 메모리 + LLM 위키 서버**

[![CI](https://github.com/kht6163/memory-wiki-all-you-need/actions/workflows/ci.yml/badge.svg)](https://github.com/kht6163/memory-wiki-all-you-need/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-memory-wiki-all-you-need)](https://www.npmjs.com/package/pi-memory-wiki-all-you-need)
[![Docker Hub](https://img.shields.io/docker/v/kht6163/memory-wiki-all-you-need?sort=semver&label=docker%20hub)](https://hub.docker.com/r/kht6163/memory-wiki-all-you-need)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | **한국어**

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/screenshots/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/screenshots/hero-light.png">
  <img alt="memory-wiki-all-you-need 웹 UI" src=".github/assets/screenshots/hero-light.png" width="100%">
</picture>

## 무엇인가요?

pi의 메모리를 PC마다 따로 두지 않고 **서버 한 곳**에 모읍니다. 확장은 요청할 때마다 메모리를 시스템 프롬프트에 넣습니다. 에이전트가 필요할 때 찾아보는 방식이 아니라 항상 들어갑니다. 턴이 끝나면 서버의 LLM이 대화를 읽고 메모리를 알아서 추가·수정·삭제합니다. 메모리와 별도로 **위키**도 있습니다. 사람과 에이전트가 함께 쓰는 문서 공간이고, 요청하면 서버 LLM이 턴 기록을 읽어 페이지로 정리해 줍니다.

## 동작 방식

```mermaid
flowchart LR
  subgraph PC["각 PC"]
    pi["pi + 확장"]
  end
  subgraph S["서버 (Node 24 + node:sqlite FTS5)"]
    inj["메모리 주입<br/>· 회상"]
    q["턴 큐"] --> cur["LLM 메모리 정리"]
    wiki["위키 정리<br/>(요청 시)"]
    rev["메모리 점검"]
    db[("SQLite")]
  end
  llm["OpenAI 호환 LLM"]
  web["브라우저 (웹 UI)"]

  pi -- "요청 전" --> inj
  pi -- "턴이 끝나면" --> q
  cur & wiki & rev --> llm
  inj & cur & wiki & rev --- db
  web -- "같은 포트" --> S
```

## 기능

**메모리**
- **강제 주입** — 정책, 고정 지시, 사용자 프로필, 프로젝트·전역 메모리 순으로 `CONTEXT_BUDGET_CHARS` 안에서 넣습니다. 메모리가 바뀔 때만 내용이 바뀌므로 프롬프트 캐시가 유지됩니다.
- **프롬프트별 회상** — 이번 프롬프트와 관련된 나머지 메모리는 숨은 메시지(`memory-recall`)로 붙습니다.
- **턴 정리** — LLM이 관련 기존 메모리를 함께 보고 add / update / edit / delete / confirm을 정합니다. 모든 변경은 이력에 남아 되돌릴 수 있고, 똑같은 메모리는 다시 추가하지 않습니다.
- **정확한 날짜** — "어제"는 정리한 날이 아니라 턴이 일어난 날(`TIMEZONE` 기준)로 적습니다. 메모리마다 어느 턴에서 추가·수정·확인됐는지도 남습니다.
- **지난 사실** — 새 메모리가 옛 메모리를 `supersedes`로 대체하고, 임시 사실은 `valid_until`이 지나면 이력으로 넘어갑니다. 이력은 주입되지 않지만 검색할 수 있습니다.
- **검색 키워드** — 동의어·번역·다른 표기(`Postgres`, `포스트그레스`)는 검색과 회상에만 쓰이고 프롬프트에는 들어가지 않습니다.
- **정리 방침** — 서버 LLM이 따를 규칙을 전역·프로젝트별로 사람이 적어 둡니다.
- **프로젝트 구분** — git `origin` 주소를 정규화해 씁니다(`github.com/foo/bar`, worktree는 메인 저장소 기준). 원격이 없으면 `local/<폴더명>`, git 밖이면 전역만 씁니다. `MEMORY_PROJECT`로 직접 지정할 수 있습니다.

**그래프**
- **엔티티와 관계** — 메모리는 엔티티를 언급하고 `because`·`depends_on`·`supersedes`·`related`로 서로 이어집니다. 턴 정리와 같은 호출에서 정하므로 LLM을 더 부르지 않습니다. 엔티티는 프로젝트끼리 공유되고, 이름을 바꾸거나 합치면 예전 이름이 별칭으로 남습니다.
- **그래프 회상** — 프롬프트가 언급한 엔티티의 메모리를 앞으로 올리고, 이웃 메모리를 `GRAPH_RECALL_EXTRA`개까지 더합니다.
- **비슷한 엔티티 제안** — 이름 유사도와 함께 언급된 정도로 "PostgreSQL ↔ Postgres" 같은 합치기를 제안합니다(LLM 없음).

**점검**
- **메모리 점검** — LLM이 같은 엔티티의 메모리끼리 묶어 읽고 합치기·고치기·삭제·모순을 *제안*합니다. 사람이 적용하기 전에는 아무것도 바뀌지 않고, 그사이 메모리가 바뀌었으면 적용하지 않습니다.
- **예약 점검** — `REVIEW_EVERY_DAYS`를 켜면 바뀐 범위를 주기적으로 점검해 제안만 쌓습니다.
- **사용 기록** — 최근에 쓰인 메모리를 앞에 둡니다(전날까지의 사용만 반영해 하루 동안 순서가 고정됩니다). 오래 안 쓰인 메모리는 따로 보여 줍니다.

**위키**
- **프로젝트별·전역 위키** — `[[slug]]` 링크, `[#id]` 메모리 참조, 이력·되돌리기·백링크·검색·잠금을 지원합니다.
- **턴 기록으로 정리** — LLM이 대화와 도구 실행 결과를 읽어 페이지에 반영합니다. `WIKI_COMPOSE_CHUNK_CHARS` 단위로 나눠 처리하며, 자동으로는 돌지 않습니다.
- **위키 점검** — 고아 페이지, 없는 페이지 링크, 지워진 메모리 인용, 빈 페이지를 찾습니다(LLM 없음).

**웹 UI**
- 라이트·다크 테마, `⌘K` / `Ctrl K` 명령 팔레트(초성 검색 포함), 키보드 단축키(`?`), 되돌리기 토스트, 모바일 서랍 메뉴. 글꼴이 포함돼 있어 외부 CDN을 쓰지 않습니다.

**보호**
- **비밀값** — 비밀값처럼 보이는 내용은 저장을 거부하고, 턴 기록에서는 가립니다.
- **사람 전용** — 고정 지시와 정리 방침은 사람만 쓰고 고칠 수 있습니다.
- **fail-soft** — 서버가 꺼져 있거나 느려도 짧은 타임아웃(`MEMORY_TIMEOUT_MS`) 뒤 pi 턴이 그대로 진행되고, 마지막으로 받은 메모리 블록을 다시 씁니다.
- **작업 취소** — 위키 정리·그래프 백필·점검 작업은 취소했다가 이어서 다시 실행할 수 있습니다.

## 스크린샷

<table>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/graph.png" alt="메모리 그래프"><br><sub><b>그래프</b> — 프로젝트별 엔티티와 메모리 관계</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/wiki.png" alt="위키 페이지"><br><sub><b>위키</b> — 이력과 백링크가 있는 페이지</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/memory.png" alt="메모리 상세 페이지"><br><sub><b>메모리</b> — 엔티티·관계·출처 턴, 수정 이력 비교와 되돌리기</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/review.png" alt="메모리 점검 제안"><br><sub><b>점검</b> — LLM 제안과 변경 비교, 적용 전에는 아무것도 바뀌지 않음</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/palette.png" alt="명령 팔레트"><br><sub><b>명령 팔레트</b> — <code>⌘K</code> / <code>Ctrl K</code>로 메모리·위키·지난 턴 검색</sub></td>
    <td width="50%"></td>
  </tr>
</table>

## 빠른 시작

### 1. 서버 실행

서버 이미지는 [도커 허브](https://hub.docker.com/r/kht6163/memory-wiki-all-you-need)에 `linux/amd64`·`linux/arm64`로 있습니다. 태그는 `X.Y.Z`(그 버전), `X.Y`(그 minor의 최신 패치, 예: `0.8`), `latest`입니다.

Docker Compose 예시입니다(`LLM_API_KEY`는 `.env`에 둡니다).

```yaml
services:
  memory:
    image: kht6163/memory-wiki-all-you-need:0.8   # amd64 / arm64
    restart: unless-stopped
    environment:
      LLM_BASE_URL: http://<llm-host>:8317/v1
      LLM_API_KEY: ${LLM_API_KEY:?missing}
      LLM_MODEL: gpt-6-luna
      TIMEZONE: Asia/Seoul
    ports:
      - "127.0.0.1:8765:8765"
    volumes:
      - ./data:/data
```

컨테이너는 `node` 사용자(uid 1000)로 돌기 때문에 `./data`에 쓸 수 있어야 합니다: `mkdir -p data && sudo chown 1000:1000 data`.

`docker run`으로 바로 띄울 수도 있습니다.

```sh
mkdir -p data && sudo chown 1000:1000 data
docker run -d --name memory-wiki --restart unless-stopped \
  -p 127.0.0.1:8765:8765 -v "$PWD/data:/data" \
  -e LLM_BASE_URL=http://<llm-host>:8317/v1 -e LLM_API_KEY=<키> -e TIMEZONE=Asia/Seoul \
  kht6163/memory-wiki-all-you-need:0.8
```

소스에서 직접 빌드하려면 `image:` 대신 `build: ./memory-wiki-all-you-need`(이 저장소를 받은 폴더)를 쓰세요.

> [!WARNING]
> 로그인 기능이 없습니다. `127.0.0.1`이나 신뢰하는 네트워크에만 바인딩하세요.

웹 UI는 `http://<서버 주소>:8765`에서 열립니다.

**업데이트** — 먼저 `data/`를 백업하세요. DB 스키마는 기동할 때 자동으로 올라가고 옛 서버는 더 새 DB를 열지 않으므로, 되돌릴 방법은 백업뿐입니다. 그다음:

```sh
docker compose pull && docker compose up -d
```

버전 목록은 [GitHub 태그](https://github.com/kht6163/memory-wiki-all-you-need/tags)에 있습니다. 올릴 시점을 직접 정하고 싶으면 `X.Y.Z`로 고정하세요.

### 2. pi 확장 설치 (각 PC)

**방법 A — 설치 스크립트** (서버 주소가 자동으로 들어갑니다)

```sh
curl -fsSL http://<서버 주소>:8765/install.sh | sh   # → ~/.pi/agent/extensions/memory-wiki-all-you-need
```

**방법 B — npm** (서버 주소를 직접 설정합니다)

```sh
pi install npm:pi-memory-wiki-all-you-need
export MEMORY_SERVER_URL=http://<서버 주소>:8765
```

> [!IMPORTANT]
> 둘 중 하나만 쓰세요. 둘 다 설치하면 확장이 두 번 실행됩니다.

## 설정

<details>
<summary><b>서버 환경 변수</b></summary>

| 변수 | 기본값 | 설명 |
|---|---|---|
| `LLM_BASE_URL` | – | OpenAI 호환 `/v1` 주소. 없으면 턴은 저장만 하고 정리는 건너뜁니다 |
| `LLM_API_KEY` / `LLM_MODEL` | – / `gpt-6-luna` | |
| `LLM_TIMEOUT_MS` | 180000 | LLM 요청 타임아웃 |
| `PORT` / `HOST` / `DATA_DIR` | 8765 / `0.0.0.0` / `./data` (Docker는 `/data`) | |
| `TIMEZONE` | `UTC` | 상대 날짜를 풀 때 쓰는 시간대(IANA) |
| `CONTEXT_BUDGET_CHARS` | 8000 | 시스템 프롬프트 메모리 블록 예산 |
| `RECALL_BUDGET_CHARS` / `RECALL_LIMIT` | 3000 / 6 | 프롬프트별 회상 |
| `WIKI_COMPOSE_CHUNK_CHARS` | 40000 | 위키 정리 LLM 호출 1회에 넣는 턴 기록 글자 수 |
| `WIKI_COMPOSE_MAX_TURNS` | 200 | 정리 작업 1건의 최대 턴 수 |
| `WIKI_WRITER_BUDGET_CHARS` | 40000 | 정리 호출 1회에 보여 주는 기존 페이지 본문 예산 |
| `WIKI_INDEX_BUDGET_CHARS` | 1500 | pi에 주입하는 위키 페이지 목록 예산 |
| `GRAPH_RECALL_EXTRA` | 4 | 그래프로 회상에 더하는 메모리 수 상한 |
| `GRAPH_BACKFILL_CHUNK_CHARS` / `GRAPH_BACKFILL_MAX` | 24000 / 2000 | 그래프 백필 호출 크기 / 작업 1건 최대 메모리 수 |
| `REVIEW_CHUNK_CHARS` / `REVIEW_MAX_ENTRIES` | 24000 / 2000 | 메모리 점검 호출 크기 / 작업 1건 최대 메모리 수 |
| `REVIEW_STALE_DAYS` | 60 | 이 기간 동안 사용·주입·수정이 없으면 "오래 안 쓰인 메모리" |
| `REVIEW_EVERY_DAYS` | 0 (끔) | 바뀐 범위를 자동 점검하는 간격(제안만 쌓음) |

</details>

<details>
<summary><b>확장 환경 변수</b></summary>

| 변수 | 기본값 | 설명 |
|---|---|---|
| `MEMORY_SERVER_URL` | 설치 스크립트: 설치한 서버 주소 · npm: `http://127.0.0.1:8765` | 서버 주소 |
| `MEMORY_SETTLE_DELAY_MS` | 8000 | 에이전트가 완전히 대기 상태가 된 뒤 턴을 보내기까지 기다리는 시간 |
| `MEMORY_TIMEOUT_MS` | 1500 | 주입할 메모리를 조회하는 타임아웃 |
| `MEMORY_PROJECT` | (자동) | 프로젝트 키 직접 지정 |
| `MEMORY_DISABLED` | – | `1`이면 끔 |

</details>

## 메모리 모델

| 필드 | 값 |
|---|---|
| `scope` | `global` / `user` / `project` |
| `category` | `standing` `convention` `decision` `fact` `preference` `correction` `failure` `tool-quirk` `insight` |
| `source` | `human` / `llm` / `agent` (마지막 작성자) |
| `keywords` | 검색 전용 단어(주입 안 됨) |
| `valid_until` | 유효 기한 `YYYY-MM-DD`(지나면 이력) |

## 에이전트 도구와 명령

**도구:** `memory_search`, `session_search`, `memory_add`, `memory_replace`, `memory_remove`(pi-hermes-memory와 같은 이름·target), `memory_graph`, `wiki_search`, `wiki_read`, `wiki_write`.

| 명령 | 하는 일 |
|---|---|
| `/memory` | 서버 상태와 이 프로젝트의 위키 링크 |
| `/memory-pin <text> [--project]` | 모든 세션에 주입되는 고정 지시 추가 |
| `/memory-flush` | 모아 둔 턴을 기다리지 않고 지금 보냄 |
| `/wiki-compose [정리 방향]` | 현재 세션의 턴을 서버 LLM으로 위키에 정리 |

## 개발

```sh
npm install
npm run dev:server   # :8765 (PORT, DATA_DIR로 변경)
npm run dev:web      # vite, /api는 API_URL(기본 127.0.0.1:8765)로 프록시
npm run typecheck
npm test             # server/test — 테스트 파일마다 임시 DB와 가짜 LLM (node --test)
npm run build        # 웹 UI
```

Node 24가 필요합니다(`node:sqlite`, 타입 스트리핑 — 서버는 빌드 단계가 없습니다). [GitHub Actions](.github/workflows/ci.yml)가 push·PR마다 `npm ci` → typecheck → test → build를 돌리고, Docker 이미지 빌드와 헤드리스 Chrome 웹 스모크 테스트도 실행합니다.

**출시** — 서버·웹 UI·확장은 같은 버전 번호를 씁니다. `package.json` 버전과 같은 `vX.Y.Z` 태그를 푸시하면 [GitHub Actions](.github/workflows/release.yml)가 서버 이미지를 도커 허브에 올립니다(amd64 + arm64). 확장은 같은 버전으로 [npm](https://www.npmjs.com/package/pi-memory-wiki-all-you-need)에 올립니다.

## 라이선스

[MIT](LICENSE)
