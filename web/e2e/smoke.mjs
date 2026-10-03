#!/usr/bin/env node
// Headless smoke test of the built web UI against a running server.
//
// Seeds a little data through the API, then opens the main routes at 1280px and
// 375px in light and dark color schemes and fails on:
//   - page errors and console errors
//   - horizontal overflow at 375px (scrollWidth > clientWidth)
//   - requests to any other host (G-038), and no self-hosted .woff2 served
//   - native alert/confirm/prompt dialogs (G-036)
//   - "page not found" / error boxes on a main route
//   - dark tokens differing between OS dark + system and OS light + forced dark (G-037)
// and checks the memory delete → "실행 취소" toast flow once (G-036).
//
// playwright-core is NOT a repo dependency: install it anywhere outside the repo
// and point SMOKE_PW_DIR at that folder.
//
//   npm i --prefix /tmp/pw --no-save --no-package-lock playwright-core@1.63.0
//   SMOKE_BASE=http://127.0.0.1:18765 SMOKE_PW_DIR=/tmp/pw SMOKE_OUT=/tmp/smoke node web/e2e/smoke.mjs
//
// Env: SMOKE_BASE (server origin, required), SMOKE_PW_DIR (folder holding
// node_modules/playwright-core), SMOKE_CHROME (default /usr/bin/google-chrome),
// SMOKE_OUT (screenshot folder, default ./smoke-out).
// The script creates data (keys and slugs tagged per run) and leaves it there, so
// re-running against the same server works; a fresh DATA_DIR keeps it tidy.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const BASE = (process.env.SMOKE_BASE ?? "").replace(/\/+$/, "");
if (!BASE) {
  console.error("SMOKE_BASE is required (e.g. http://127.0.0.1:18765)");
  process.exit(2);
}
const ORIGIN = new URL(BASE).origin;
const PW_DIR = path.resolve(process.env.SMOKE_PW_DIR ?? ".");
const CHROME = process.env.SMOKE_CHROME ?? "/usr/bin/google-chrome";
const OUT = path.resolve(process.env.SMOKE_OUT ?? "smoke-out");
fs.mkdirSync(OUT, { recursive: true });

// Anchor resolution at the install folder so playwright-core's exports map applies.
const { chromium } = createRequire(path.join(PW_DIR, "noop.js"))("playwright-core");

const failures = [];
const fail = (where, msg) => {
  failures.push(`${where}: ${msg}`);
  if (failures.length <= 60) console.log(`  FAIL ${where}: ${msg}`);
  else if (failures.length === 61) console.log("  … more failures not printed (count at the end)");
};

// ------------------------------------------------------------------ seed

async function api(method, p, body) {
  const res = await fetch(`${BASE}/api${p}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function seed() {
  const tag = Date.now().toString(36);
  const { project } = await api("POST", "/context", { project: { key: `github.com/smoke/demo-${tag}`, name: "smoke-demo" }, prompt: "" });
  const long = "아주 긴 제목이 좁은 화면에서도 가로로 넘치지 않는지 확인하기 위한 메모리 제목 — pnpm-workspace-and-vite-config-with-a-very-long-unbroken-identifier";
  const pinned = await api("POST", "/entries", {
    scope: "global",
    category: "preference",
    title: "답변은 한국어로",
    body: "사용자에게 보이는 문자열은 **한국어**로 쓴다.\n\n- 코드 식별자는 영어\n- `npm test` 전에 typecheck",
    tags: ["lang", "style"],
    pinned: true,
    entities: [{ name: "TypeScript", kind: "tech" }],
  });
  const detail = await api("POST", "/entries", {
    scope: "project",
    project_id: project.id,
    category: "fact",
    title: long,
    body: "서버는 Hono와 node:sqlite를 쓴다. 웹은 React 19 + Vite.\n\n```ts\nconst x = 'a-very-long-line-of-code-that-should-scroll-inside-its-own-box-not-the-page-0123456789';\n```",
    tags: ["stack"],
    entities: [{ name: "Hono", kind: "tech" }, { name: "SQLite", kind: "tech" }, "TypeScript"],
  });
  await api("POST", "/entries", {
    scope: "project",
    project_id: project.id,
    category: "decision",
    title: "기한이 지난 메모리",
    body: "이 메모리는 기한이 지났다.",
    valid_until: "2020-01-01",
  });
  await api("POST", "/entries", { scope: "user", category: "preference", title: "사용자 프로필 예시", body: "짧은 답을 좋아한다." });
  const victim = await api("POST", "/entries", { scope: "global", category: "fact", title: `되돌리기 시험 ${tag}`, body: "삭제 후 실행 취소로 돌아와야 한다." });
  const page = await api("POST", "/wiki/pages", {
    project_id: null,
    slug: `smoke-home-${tag}`,
    title: "스모크 시험 페이지",
    body: `# 개요\n\n[[missing-link-${tag}]]로 가는 없는 링크와 [[smoke-other-${tag}]]가 있다.\n\n| 열 | 값 |\n|---|---|\n| 아주 긴 값 | pnpm-workspace-and-vite-config-with-a-very-long-unbroken-identifier |`,
  });
  await api("POST", "/wiki/pages", { project_id: project.id, slug: `smoke-other-${tag}`, title: "프로젝트 위키 페이지", body: `[[smoke-home-${tag}]]을 본다.` });
  const turn = await api("POST", "/turns", {
    sessionId: `smoke-${tag}`,
    project: { key: project.key, name: project.name },
    client: "smoke",
    cwd: "/tmp/smoke",
    messages: [
      { role: "user", text: "웹 화면 점검을 자동으로 돌려 줘" },
      { role: "assistant", text: "스모크 스크립트를 추가했습니다.", toolCalls: [{ name: "bash", args: "node web/e2e/smoke.mjs" }] },
      { role: "tool", name: "bash", text: "ok", isError: false },
    ],
  });
  const ents = await api("GET", "/entities");
  const list = Array.isArray(ents) ? ents : ents.entities ?? ents.items ?? [];
  const entity = list.find((e) => e.name === "TypeScript") ?? list[0];
  return { project, pinned, detail, victim, page, turn, entity };
}

// ------------------------------------------------------------------ checks

const NOT_FOUND = "페이지를 찾을 수 없습니다";

async function settle(page, where) {
  // The app polls (/api/stats), so networkidle never comes: wait for load and for
  // every aria-busy skeleton to go away instead. Still loading after 15s is a failure.
  await page.waitForLoadState("load");
  await page
    .waitForFunction(() => document.querySelector("#root")?.children.length && !document.querySelector('[aria-busy="true"]'), null, { timeout: 15_000 })
    .catch(() => fail(where, "still loading (aria-busy skeleton or empty #root) after 15s"));
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(400);
}

// page → "route width/scheme", so blocked requests are reported against their route
const pageWhere = new WeakMap();

function watch(page, where, seen) {
  pageWhere.set(page, where);
  page.on("pageerror", (err) => fail(where, `pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") fail(where, `console error: ${msg.text()}`);
  });
  page.on("dialog", async (d) => {
    fail(where, `native ${d.type()}() dialog: ${d.message()} (G-036)`);
    await d.dismiss().catch(() => {});
  });
  page.on("requestfailed", (req) => {
    // ERR_ABORTED: a poll still in flight when the page is closed or navigates away
    if (req.failure()?.errorText === "net::ERR_ABORTED") return;
    if (new URL(req.url()).origin === ORIGIN) fail(where, `request failed: ${req.url()} ${req.failure()?.errorText ?? ""}`);
  });
  page.on("request", (req) => {
    const u = req.url();
    if (/\.woff2(\?|$)/.test(u) && u.startsWith(`${ORIGIN}/assets/`)) seen.woff2 = true;
  });
}

async function newContext(browser, width, scheme, forceDark = false) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
  // Block and report every request that leaves the server's origin (G-038).
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (/^(data|blob|about):/.test(u) || new URL(u).origin === ORIGIN) return route.continue();
    let where = `${width}/${scheme}`;
    try {
      where = pageWhere.get(route.request().frame().page()) ?? where;
    } catch {
      // service worker or detached frame: keep the context label
    }
    fail(where, `request to another host: ${u} (G-038)`);
    return route.abort();
  });
  if (forceDark) await ctx.addInitScript(() => localStorage.setItem("theme", "dark"));
  return ctx;
}

async function checkRoute(ctx, route, width, scheme, seen) {
  const where = `${route.name} ${width}/${scheme}`;
  const page = await ctx.newPage();
  watch(page, where, seen);
  try {
    await page.goto(`${BASE}/#${route.hash}`, { waitUntil: "load", timeout: 20_000 });
    await settle(page, where);
    if (route.wait) await page.waitForSelector(route.wait, { timeout: 15_000 }).catch(() => fail(where, `"${route.wait}" did not appear`));
    const state = await page.evaluate((nf) => {
      const el = document.documentElement;
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        notFound: document.body.innerText.includes(nf),
        errorBox: document.querySelector(".error-box")?.textContent ?? null,
        // The sidebar and top bar always have text, so judge only the main content area.
        empty: (() => {
          const main = document.querySelector("main.main");
          return !main || (!main.textContent?.trim() && !main.querySelector("canvas, img, svg"));
        })(),
      };
    }, NOT_FOUND);
    if (state.empty) fail(where, "blank main content area");
    if (state.notFound) fail(where, "route shows the not-found page");
    if (state.errorBox) fail(where, `error box: ${state.errorBox}`);
    if (width <= 375 && state.scrollWidth > state.clientWidth) {
      const culprits = await page.evaluate((cw) => {
        const out = [];
        for (const n of document.querySelectorAll("body *")) {
          const r = n.getBoundingClientRect();
          if (r.right > cw + 1 && r.width > 0) out.push(`${n.tagName.toLowerCase()}.${String(n.className).split(" ").filter(Boolean).join(".")} (right ${Math.round(r.right)})`);
          if (out.length >= 5) break;
        }
        return out;
      }, state.clientWidth);
      fail(where, `horizontal overflow ${state.scrollWidth} > ${state.clientWidth}: ${culprits.join(", ")}`);
    }
    await page.screenshot({ path: path.join(OUT, `${route.name}-${width}-${scheme}.png`), fullPage: false });
  } catch (err) {
    fail(where, `navigation: ${err.message.split("\n")[0]}`);
    await page.screenshot({ path: path.join(OUT, `${route.name}-${width}-${scheme}-error.png`) }).catch(() => {});
  } finally {
    await page.close();
  }
}

/** G-037: OS dark + system theme must equal OS light + forced dark, token by token. */
async function checkDarkTokens(browser) {
  const read = async (scheme, force) => {
    const ctx = await newContext(browser, 1280, scheme, force);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/#/`, { waitUntil: "load" });
    await settle(page, `dark tokens ${scheme}`);
    const tokens = await page.evaluate(() => {
      const names = new Set();
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        const walk = (list) => {
          for (const r of list) {
            if (r.style) for (const p of r.style) if (p.startsWith("--color-")) names.add(p);
            if (r.cssRules) walk(r.cssRules);
          }
        };
        walk(rules);
      }
      const cs = getComputedStyle(document.documentElement);
      return Object.fromEntries([...names].sort().map((n) => [n, cs.getPropertyValue(n).trim()]));
    });
    await ctx.close();
    return tokens;
  };
  const system = await read("dark", false);
  const forced = await read("light", true);
  const names = Object.keys(system);
  if (!names.length) fail("dark tokens", "no --color-* tokens found");
  const diff = names.filter((n) => system[n] !== forced[n]);
  if (diff.length) fail("dark tokens", `OS dark ≠ forced dark for ${diff.slice(0, 8).map((n) => `${n} (${system[n]} vs ${forced[n]})`).join(", ")} (G-037)`);
  else console.log(`  ok dark tokens: ${names.length} --color-* identical`);
}

/** G-036: deleting from the list asks nothing, shows an undo toast, and undo restores. */
async function checkUndo(browser, victim, seen) {
  const where = "undo flow";
  const ctx = await newContext(browser, 1280, "light");
  const page = await ctx.newPage();
  watch(page, where, seen);
  const deletedAt = async () => (await api("GET", `/entries/${victim.id}`)).entry.deleted_at;
  try {
    await page.goto(`${BASE}/#/global`, { waitUntil: "load" });
    await settle(page, where);
    const del = page.locator(`button[aria-label="'${victim.title}' 삭제"]`);
    await del.first().hover();
    await del.first().click();
    const undo = page.locator(".toast button", { hasText: "실행 취소" });
    await undo.waitFor({ timeout: 5_000 });
    await page.screenshot({ path: path.join(OUT, "undo-1-toast.png") });
    if (!(await deletedAt())) fail(where, "memory not in the trash after delete");
    await undo.click();
    // restore is async; poll the API briefly
    let restored = false;
    for (let i = 0; i < 20 && !restored; i++) {
      restored = !(await deletedAt());
      if (!restored) await page.waitForTimeout(150);
    }
    if (!restored) fail(where, "실행 취소 did not restore the memory");
    await page.locator(`button[aria-label="'${victim.title}' 삭제"]`).first().waitFor({ state: "attached", timeout: 5_000 }).catch(() => fail(where, "restored memory not back in the list"));
    await page.screenshot({ path: path.join(OUT, "undo-2-restored.png") });
    if (restored) console.log("  ok undo flow: delete → toast → 실행 취소 → restored");
  } catch (err) {
    fail(where, err.message.split("\n")[0]);
    await page.screenshot({ path: path.join(OUT, "undo-error.png") }).catch(() => {});
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------------ main

const data = await seed();
console.log(`seeded: project #${data.project.id}, memory #${data.detail.id}, entity #${data.entity?.id}, wiki "${data.page.slug}", turn #${data.turn.id}`);

const routes = [
  { name: "home", hash: "/" },
  { name: "global", hash: "/global" },
  { name: "user", hash: "/user" },
  { name: "standing", hash: "/standing" },
  { name: "projects", hash: "/projects" },
  { name: "project", hash: `/p/${data.project.id}` },
  { name: "memory", hash: `/e/${data.detail.id}` },
  { name: "memory-edit", hash: `/e/${data.detail.id}/edit` },
  { name: "wiki-home", hash: "/w/0" },
  { name: "wiki-page", hash: `/w/0/${data.page.slug}` },
  { name: "project-wiki", hash: `/w/${data.project.id}` },
  { name: "graph", hash: "/graph", wait: "canvas" },
  { name: "entities", hash: "/entities" },
  ...(data.entity ? [{ name: "entity", hash: `/entity/${data.entity.id}` }] : []),
  { name: "review", hash: "/review" },
  { name: "activity", hash: "/activity" },
  { name: "turns", hash: "/turns" },
  { name: "turn", hash: `/turns/${data.turn.id}` },
  { name: "wiki-jobs", hash: "/wiki-jobs" },
  { name: "search", hash: "/search?q=" + encodeURIComponent("한국어") },
  { name: "trash", hash: "/trash" },
  { name: "preview", hash: `/preview?project=${data.project.id}` },
];
if (!data.entity) fail("seed", "no entity was created");

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const seen = { woff2: false };
try {
  for (const width of [1280, 375]) {
    for (const scheme of ["light", "dark"]) {
      console.log(`${width}px ${scheme}`);
      const ctx = await newContext(browser, width, scheme);
      for (const r of routes) await checkRoute(ctx, r, width, scheme, seen);
      await ctx.close();
    }
  }
  await checkDarkTokens(browser);
  await checkUndo(browser, data.victim, seen);
} finally {
  await browser.close();
}
if (!seen.woff2) fail("fonts", `no /assets/*.woff2 was requested from ${ORIGIN} (G-038)`);

if (failures.length) {
  console.log(`\n${failures.length} failure(s); screenshots in ${OUT}`);
  process.exit(1);
}
console.log(`\nweb smoke ok: ${routes.length} routes × 2 widths × 2 schemes; screenshots in ${OUT}`);
