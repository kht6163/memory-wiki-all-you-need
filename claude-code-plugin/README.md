# memory-wiki (Claude Code plugin)

The [Claude Code](https://code.claude.com) client for [memory-wiki-all-you-need](https://github.com/kht6163/memory-wiki-all-you-need) — the same central memory + LLM wiki server the pi extension uses. It is a **mod**: a plugin whose hooks run inside Claude Code. ([한국어](https://github.com/kht6163/memory-wiki-all-you-need/blob/main/README.ko.md#3-claude-code-플러그인-설치-각-pc))

- **Memory in every request** — the server's memory block is a section of the system prompt, and memories related to each prompt are attached as context only Claude reads.
- **Curation after each turn** — the turn (prompt, answers, tool calls and results) is sent to the server, whose LLM adds, updates or removes memories. A pi session and a Claude Code session in the same repository share one project.
- **Tools** — `memory_search`, `session_search`, `memory_add`, `memory_replace`, `memory_remove`, `memory_graph`, `wiki_search`, `wiki_read`, `wiki_write`, `skill_manage`, `memory_review` (Claude sees them as `mcp__memory-wiki__<name>`).
- **Skills** — the server's **global** skills are installed into `~/.claude/skills/<name>/` (one way; Claude Code picks them up without a restart, and a change on the server arrives before the next prompt). **This project's** skills stay on the server: they are listed in the memory block and Claude reads one with `skill_manage` before following it. A skills folder that this plugin did not write is never touched.

It is fail-soft: when the server is down or slow, a prompt waits at most `timeout_ms` and goes on without memory, and finished turns are kept on this machine and sent later.

Requires **Claude Code v2.1.287 or later** (mods) and a running server — see the [main README](https://github.com/kht6163/memory-wiki-all-you-need#readme). Tested with Claude Code 2.1.290.

## Install

In a Claude Code session:

```text
/plugin marketplace add kht6163/memory-wiki-all-you-need
/plugin install memory-wiki@memory-wiki-all-you-need
```

Then set the server URL: open `/config`, find **Memory server URL** (memory-wiki) and enter `http://<server>:8765`. Run `/reload-plugins` (or start a new session) and check with `/memory-wiki`.

## Settings

Shown in `/config` (stored under `pluginConfigs` in `~/.claude/settings.json`). An environment variable with the same meaning as the pi extension's overrides the setting.

| Setting | Env override | Default | Description |
|---|---|---|---|
| `server_url` | `MEMORY_SERVER_URL` | `http://127.0.0.1:8765` | Server URL |
| `timeout_ms` | `MEMORY_TIMEOUT_MS` | 1500 | How long a prompt waits for the memory block |
| `settle_delay_ms` | `MEMORY_SETTLE_DELAY_MS` | 8000 | Wait after a turn before sending it (a prompt in between sends both together) |
| `project` | `MEMORY_PROJECT` | (git origin; outside git the folder: `home/<user>[/<path>]` or `path/<path>`) | Fixed project key |
| `skill_nudge` | `MEMORY_SKILL_NUDGE` | 8 | After a turn with this many tool calls (2+ different tools) and no `skill_manage` call, hint Claude to save the procedure as a skill; `0` = off |
| `mirror_skills` | `MEMORY_MIRROR_SKILLS` (`0` = off) | `true` | Install the server's global skills into `~/.claude/skills` |
| `show_activity` | `MEMORY_SHOW_ACTIVITY` (`0` = off) | `true` | Log lines in the conversation when memories are recalled for a prompt (`🧠 memory_recall`) and when a turn's curation changed memories (`🧠 memory_curate`), one line per memory. Display only: never sent to Claude |

## Commands

| Command | What it does |
|---|---|
| `/memory-wiki` | Server status and the wiki link for this project |
| `/memory-pin <text> [--project]` | Add a standing instruction injected into every session |
| `/memory-flush` | Send the finished turns now instead of waiting |
| `/wiki-compose [focus]` | Organize this session's turns into the wiki with the server LLM |
| `/skills-sync` | Download the server's global skills now (they also sync on their own) |

`/memory` stays Claude Code's own command (CLAUDE.md memory).

## Development

```sh
claude --plugin-dir ./claude-code-plugin   # loads this directory, reloads on save
claude plugin validate ./claude-code-plugin
```

Loading it once with `--plugin-dir` writes Claude Code's type declarations into `.claude-plugin/types/`, which `tsconfig.json` uses (`npx tsc -p claude-code-plugin`). `hooks/lib.ts` is pure and tested by the server's test suite (`server/test/CC-*.ts`), which also runs `hooks/register.ts` against a fake mods API.
