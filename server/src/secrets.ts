// Blocks credentials from being persisted as memory and redacts them from
// turn transcripts. Patterns favour precision: a false positive silently
// drops a memory, so only well-known credential shapes are matched.

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: "openai-key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  {
    name: "assignment",
    re: /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd)[A-Za-z0-9_]*)\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{16,})["']?/gi,
  },
];

export function findSecrets(text: string): string[] {
  const found = new Set<string>();
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) found.add(name);
  }
  return [...found];
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    out = name === "assignment"
      ? out.replace(re, (_m, key: string) => `${key}=[REDACTED]`)
      : out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}
