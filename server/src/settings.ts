import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

// Feature switches set from the web (ADR-0038), kept in <DATA_DIR>/settings.json.
// Same precedence as debug mode and the extension settings (ADR-0033, ADR-0035):
// an env var wins over the file, the file over the default. Debug mode keeps its
// own debug.json.
//  - wikiCompose (WIKI_COMPOSE): the server LLM organizing turn records into wiki
//    pages (POST /wiki/compose). Off = no new or retried compose jobs and the
//    worker leaves queued ones waiting (G-067). On by default. Agent and person
//    page writes are not affected.
//  - skillApproval: which agent skill writes wait for a person's approval
//    (ADR-0040): "off", "global" (default: a global skill reaches every project
//    and PC) or "all". People's own writes never wait.

export type SettingSource = "env" | "file" | "default";
export interface SwitchState {
  enabled: boolean;
  source: SettingSource;
}

const file = () => path.join(config.dataDir, "settings.json");
let cache: Record<string, unknown> | undefined;

function readFile(): Record<string, unknown> {
  try {
    const j = JSON.parse(fs.readFileSync(file(), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

const saved = () => (cache ??= readFile());

export function wikiComposeState(): SwitchState {
  if (config.wiki.composeEnv !== undefined) return { enabled: config.wiki.composeEnv, source: "env" };
  const v = saved().wikiCompose;
  return typeof v === "boolean" ? { enabled: v, source: "file" } : { enabled: true, source: "default" };
}

export const wikiComposeEnabled = () => wikiComposeState().enabled;

export const SKILL_APPROVALS = ["off", "global", "all"] as const;
export type SkillApproval = (typeof SKILL_APPROVALS)[number];

export function skillApprovalState(): { value: SkillApproval; source: SettingSource } {
  const v = saved().skillApproval;
  return SKILL_APPROVALS.includes(v as SkillApproval) ? { value: v as SkillApproval, source: "file" } : { value: "global", source: "default" };
}

/** Whether an agent write to this scope (null = global) waits for approval. */
export const skillNeedsApproval = (projectId: number | null) => {
  const v = skillApprovalState().value;
  return v === "all" || (v === "global" && projectId == null);
};

function writeSetting(patch: Record<string, unknown>) {
  const next = { ...readFile(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
}

export function setSkillApproval(value: SkillApproval) {
  writeSetting({ skillApproval: value });
  return skillApprovalState();
}

export class SettingForcedError extends Error {
  constructor(env: string) {
    super(`this setting is fixed by ${env}`);
  }
}

let onChange: (() => void) | null = null;
/** The worker wakes up when compose is switched back on (queued jobs can run). */
export function onSettingsChanged(fn: () => void) {
  onChange = fn;
}

/** Turns wiki compose on or off (persisted). Throws when WIKI_COMPOSE fixes it. */
export function setWikiCompose(enabled: boolean): SwitchState {
  if (config.wiki.composeEnv !== undefined) throw new SettingForcedError("WIKI_COMPOSE");
  writeSetting({ wikiCompose: enabled });
  onChange?.();
  return wikiComposeState();
}

/** Tests: forget the cached file. */
export function resetSettings() {
  cache = undefined;
}
