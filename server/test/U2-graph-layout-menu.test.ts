// Web UI pure logic, part 2: sparse graph placement (web/src/graph-layout.ts) and the shared overflow
// menu / shared CSS moves (source scans). No DOM, React or cytoscape involved.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ApiError, describeError } from "../../web/src/errors.ts";
import { GRID_DEFAULTS, fitViewport, isolatedIds, isolatedKey, placeIsolated, placeLabels, planGrid, sortIsolated, type Box } from "../../web/src/graph-layout.ts";
import { menuKeyAction, openFocusIndex } from "../../web/src/menu-keys.ts";

const webSrc = new URL("../../web/src/", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, webSrc), "utf8");
const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i + 1}`);
const landscape = { w: 1200, h: 700 };

test("web-ui: isolated nodes are those without an edge to another node", () => {
  const nodes = ["a", "b", "c", "d", "e"];
  const edges = [
    { source: "a", target: "b" },
    { source: "d", target: "d" }, // a self loop does not connect anything
  ];
  assert.deepEqual(isolatedIds(nodes, edges), ["c", "d", "e"]);
  assert.deepEqual(isolatedIds(nodes, []), nodes);
  assert.deepEqual(isolatedIds([], edges), []);
});

test("web-ui: grid keys put memories by legend category, unknown categories after them, entities last", () => {
  const order = ["standing", "fact", "decision"];
  const nodes = [
    isolatedKey({ id: "e:1", type: "entity", entityId: 1 }, order),
    isolatedKey({ id: "m:5", type: "memory", entryId: 5, category: "mystery" }, order),
    isolatedKey({ id: "m:9", type: "memory", entryId: 9, category: "fact" }, order),
    isolatedKey({ id: "m:2", type: "memory", entryId: 2, category: "decision" }, order),
    isolatedKey({ id: "m:4", type: "memory", entryId: 4, category: "fact" }, order),
  ];
  assert.ok(nodes.every((k) => k.group >= 0), "no negative group for an unknown category");
  assert.deepEqual(sortIsolated(nodes), ["m:4", "m:9", "m:2", "m:5", "e:1"]);
  // GraphView wires these in rather than computing its own keys or isolation test.
  const view = read("pages/GraphView.tsx");
  assert.match(view, /isolatedIds\(/);
  assert.match(view, /isolatedKey\(/);
  assert.doesNotMatch(view, /degree\(/);
});

test("web-ui: grid order is deterministic (group, order, id) whatever the input order", () => {
  const nodes = [
    { id: "m9", group: 2, order: 9 },
    { id: "m3", group: 0, order: 3 },
    { id: "m7", group: 2, order: 1 },
    { id: "m1", group: 0, order: 3 },
    { id: "e5", group: 9, order: 5 },
  ];
  const want = ["m1", "m3", "m7", "m9", "e5"];
  assert.deepEqual(sortIsolated(nodes), want);
  assert.deepEqual(sortIsolated([...nodes].reverse()), want);
  assert.deepEqual(sortIsolated([nodes[2], nodes[4], nodes[0], nodes[3], nodes[1]]), want);
});

test("web-ui: same input gives the same positions, one node per cell", () => {
  const anchor: Box = { x1: -300, y1: -200, x2: 300, y2: 200 };
  for (const box of [null, anchor]) {
    const a = placeIsolated(ids(37), box, landscape);
    const b = placeIsolated(ids(37), box, landscape);
    assert.deepEqual([...a.entries()], [...b.entries()]);
    assert.equal(a.size, 37);
    const cells = new Set([...a.values()].map((p) => `${p.x},${p.y}`));
    assert.equal(cells.size, 37, "no two nodes share a cell");
    // Neighbours are at least one cell apart, so 140px labels never overlap.
    const pts = [...a.values()];
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        const dx = Math.abs(pts[i].x - pts[j].x);
        const dy = Math.abs(pts[i].y - pts[j].y);
        assert.ok(dx >= GRID_DEFAULTS.cellW - 1e-6 || dy >= GRID_DEFAULTS.cellH - 1e-6);
      }
  }
  assert.equal(placeIsolated([], null, landscape).size, 0);
});

test("web-ui: many isolated nodes form a wide grid, not a tall column", () => {
  for (const n of [7, 50, 200]) {
    const plan = planGrid(n, null, landscape);
    const W = plan.cols * GRID_DEFAULTS.cellW;
    const H = plan.rows * GRID_DEFAULTS.cellH;
    assert.ok(W >= H, `n=${n}: ${plan.cols} cols x ${plan.rows} rows is taller than wide`);
    // The grid's aspect is close to the viewport's (within one cell), so fit wastes little space.
    assert.ok(Math.abs(W / H - landscape.w / landscape.h) < 1.5, `n=${n}: aspect ${W / H}`);
    // A single column would have to be zoomed far further out.
    const column = Math.min(landscape.w / GRID_DEFAULTS.cellW, landscape.h / (n * GRID_DEFAULTS.cellH));
    assert.ok(plan.zoom >= column);
  }
  // 50 unconnected memories still fit at a zoom where 10px labels stay above the 8px cutoff.
  assert.ok(planGrid(50, null, landscape).zoom >= 0.8);
  assert.deepEqual(planGrid(1, null, landscape), { placement: "alone", cols: 1, rows: 1, zoom: Math.min(1200 / 160, 700 / 52), aspect: 160 / 52 });
});

test("web-ui: with a connected part the grid sits below or beside it without overlap", () => {
  const { cellW, cellH, gap } = GRID_DEFAULTS;
  // A wide cluster on a landscape canvas: grid goes below; a tall one: grid goes beside.
  const wide: Box = { x1: 0, y1: 0, x2: 1600, y2: 300 };
  const tall: Box = { x1: 0, y1: 0, x2: 300, y2: 900 };
  assert.equal(planGrid(40, wide, landscape).placement, "below");
  assert.equal(planGrid(40, tall, landscape).placement, "beside");
  for (const box of [wide, tall]) {
    const pos = placeIsolated(ids(40), box, landscape);
    for (const p of pos.values()) {
      const left = p.x - cellW / 2;
      const top = p.y - cellH / 2;
      const outside = left >= box.x2 + gap - 1e-6 || top >= box.y2 + gap - 1e-6;
      assert.ok(outside, `(${p.x}, ${p.y}) overlaps the connected part`);
    }
  }
  // Row by row in the given order: the first node is the top-left cell.
  const first = placeIsolated(["x", "y"], wide, landscape).get("x");
  assert.deepEqual(first, { x: wide.x1 + cellW / 2, y: wide.y2 + gap + cellH / 2 });
});

test("web-ui: overflow menus come from components/Menu.tsx only", () => {
  const pages = readdirSync(new URL("pages/", webSrc)).filter((f) => f.endsWith(".tsx"));
  for (const f of pages) {
    const src = read(`pages/${f}`);
    if (f === "ReviewPage.tsx" || f === "GraphPages.tsx") continue; // not using menus; owned elsewhere
    assert.doesNotMatch(src, /role="menu"|className="menu-list|"menu-item/, `${f} renders its own menu`);
  }
  for (const f of ["EntryPage.tsx", "ScopePage.tsx"]) assert.match(read(`pages/${f}`), /<Menu\b/, `${f} uses <Menu>`);
  const menu = read("components/Menu.tsx");
  for (const needle of ['role="menu"', 'role="menuitem"', 'aria-haspopup="menu"', '"mousedown"', "stopPropagation", "menuKeyAction(", "openFocusIndex("])
    assert.ok(menu.includes(needle), `Menu.tsx handles ${needle}`);
});

test("web-ui: opening focuses the first item, or the last when opened with ArrowUp", () => {
  assert.equal(openFocusIndex("first", 4), 0);
  assert.equal(openFocusIndex("last", 4), 3);
  assert.equal(openFocusIndex("last", 1), 0);
  assert.equal(openFocusIndex("first", 0), -1);
});

test("web-ui: arrows wrap, Home/End jump, Esc returns to the trigger, Tab moves on", () => {
  const n = 3;
  assert.deepEqual(menuKeyAction("ArrowDown", 0, n), { focus: 1 });
  assert.deepEqual(menuKeyAction("ArrowDown", 2, n), { focus: 0 }, "↓ on the last wraps to the first");
  assert.deepEqual(menuKeyAction("ArrowUp", 0, n), { focus: 2 }, "↑ on the first wraps to the last");
  assert.deepEqual(menuKeyAction("ArrowUp", 2, n), { focus: 1 });
  assert.deepEqual(menuKeyAction("ArrowDown", -1, n), { focus: 0 }, "nothing focused: ↓ goes to the first");
  assert.deepEqual(menuKeyAction("ArrowUp", -1, n), { focus: 2 }, "nothing focused: ↑ goes to the last");
  assert.deepEqual(menuKeyAction("Home", 1, n), { focus: 0 });
  assert.deepEqual(menuKeyAction("End", 0, n), { focus: 2 });
  assert.deepEqual(menuKeyAction("Escape", 1, n), { close: "refocus" });
  assert.deepEqual(menuKeyAction("Tab", 1, n), { close: "move-on" });
  assert.equal(menuKeyAction("a", 1, n), null);
  assert.equal(menuKeyAction("ArrowDown", -1, 0), null);
  assert.deepEqual(menuKeyAction("Escape", -1, 0), { close: "refocus" });
});

test("web-ui: shared pieces live in styles.css, not in screen CSS", () => {
  const styles = read("styles.css");
  for (const sel of [".menu {", ".menu-trigger {", ".switch {", ".search-field {", ".search-field > .icon {", ".search-field input {"])
    assert.ok(styles.includes(`\n${sel}`), `styles.css defines ${sel}`);
  const screens = readdirSync(new URL("pages/", webSrc)).filter((f) => f.endsWith(".css"));
  for (const f of screens) {
    const css = read(`pages/${f}`);
    assert.doesNotMatch(css, /\.ep-switch|\.ep-menu|\.more-menu/, `${f} keeps an old screen-local copy`);
    assert.doesNotMatch(css, /:is\([^)]*\) \.search-field \{/, `${f} redefines the base .search-field`);
  }
});

test("G-048: a cross-scope proposal whose relied-on memory changed gets a Korean message", () => {
  const msg = describeError(new ApiError(409, "memory #7 this relies on changed since it was proposed; run the review again"));
  assert.match(JSON.stringify(msg), /#7.*다시 실행/);
  // No particle glued to the number (\"#7가\" reads wrong for most digits).
  assert.doesNotMatch(JSON.stringify(msg), /#7[가이를을은는]/);
});

test("web-ui: graph fit keeps nodes clear of the toolbar (top) and legend (bottom)", () => {
  const box: Box = { x1: 0, y1: 0, x2: 400, y2: 400 };
  const view = { w: 1000, h: 800 };
  const insets = { top: 100, bottom: 60 };
  const v = fitViewport(box, view, insets, 40);
  const top = box.y1 * v.zoom + v.pan.y;
  const bottom = box.y2 * v.zoom + v.pan.y;
  assert.ok(top >= insets.top + 40 - 1e-9, `top edge ${top} below the toolbar`);
  assert.ok(bottom <= view.h - insets.bottom - 40 + 1e-9, `bottom edge ${bottom} above the legend`);
  assert.ok(Math.abs((top + bottom) / 2 - (insets.top + 40 + (view.h - insets.bottom - 40)) / 2) < 1e-6, "centered in the free band");
  const left = box.x1 * v.zoom + v.pan.x;
  const right = box.x2 * v.zoom + v.pan.x;
  assert.ok(Math.abs(left - (view.w - right)) < 1e-6, "centered horizontally");
  assert.equal(fitViewport({ x1: 0, y1: 0, x2: 1, y2: 1 }, view, insets, 40, { min: 0.1, max: 3 }).zoom, 3, "zoom capped");
});

test("G-080: the graph is laid out with fcose, edges pull by kind, names never overlap on screen", () => {
  const view = read("pages/GraphView.tsx");
  assert.match(view, /cytoscape\.use\(fcose\)/);
  assert.match(view, /name: "fcose"/);
  assert.doesNotMatch(view, /name: "cose"/, "cose pulled every memory around the project's own entity into one ball");
  // A mentions edge knows its entity's hub size; the layout lengthens and loosens it by that,
  // typed links are short and stiff.
  assert.match(view, /hub: e\.type === "mentions" \? \(deg\.get\(e\.target\)/);
  assert.match(view, /idealEdgeLength: edgeLength/);
  assert.match(view, /t === "mentions" \? 80 \+ 16 \* Math\.sqrt\(hubOf\(e\)\)/);
  assert.match(view, /t === "mentions" \? 0\.45 \/ Math\.sqrt\(hubOf\(e\)\)/);
  // G-081: packComponents needs layout-utilities registered and set up.
  assert.match(view, /cytoscape\.use\(layoutUtilities\)/);
  assert.match(view, /\.layoutUtilities\(\{/);
  // Names: constant size on screen, chosen by placeLabels after every viewport change, never by
  // cytoscape's size threshold (it scales with the pixel ratio: a Retina screen showed every name).
  assert.match(view, /"font-size": "data\(fs\)"/);
  assert.match(view, /placeLabels\(candidates, \{ obstacles, budget:/);
  assert.match(view, /c\.on\("viewport resize layoutstop select unselect dragfree", relabel\)/);
  assert.match(view, /node\.nolabel/);
  assert.doesNotMatch(view, /min-zoomed-font-size/);
  // Hover / selection focus, faint mentions when zoomed out, edges hidden while moving, history hidden.
  assert.match(view, /c\.on\("mouseover", "node"/);
  assert.match(view, /closedNeighborhood\(\)/);
  assert.match(view, /edge\.far/);
  assert.match(view, /hideEdgesOnViewport: true/);
  assert.match(view, /const \[showHistory, setShowHistory\] = useState\(false\)/);
  // Review fixes: a focused history memory stays; closing the drawer unselects (no stuck fade);
  // a search hit beats the fade; a refresh keeps runtime classes; fits ignore screen-sized labels.
  assert.match(view, /f\.showHistory \|\| !isPast\(n\) \|\| n\.id === f\.focus/);
  assert.match(view, /if \(!selected\) cy\.current\?\.nodes\(":selected"\)\.unselect\(\)/);
  assert.match(view, /selector: "node\.match", style: \{ opacity: 1 \}/);
  assert.match(view, /for \(const k of \["focus", "past"\]\) el\.toggleClass/);
  assert.match(view, /boundingBox\(\{ includeLabels: false \}\)/);
});

test("G-080: placeLabels draws no two overlapping names, the more important one wins, same input same result", () => {
  const box = (x: number, y: number, w = 60, h = 14): Box => ({ x1: x, y1: y, x2: x + w, y2: y + h });
  const items = [
    { id: "m:1", box: box(0, 0), priority: 0 },
    { id: "e:hub", box: box(30, 5), priority: 1040 },
    { id: "e:small", box: box(200, 0), priority: 1003 },
    { id: "m:2", box: box(205, 8), priority: 0 },
    { id: "m:3", box: box(400, 0), priority: 0 },
    { id: "sel", box: box(395, 2), priority: 1e6 },
  ];
  const shown = placeLabels(items);
  assert.deepEqual([...shown].sort(), ["e:hub", "e:small", "sel"]);
  // No two shown boxes overlap.
  const kept = items.filter((i) => shown.has(i.id)).map((i) => i.box);
  for (const a of kept) for (const b of kept) if (a !== b) assert.ok(!(a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2));
  assert.deepEqual([...placeLabels([...items].reverse())].sort(), [...shown].sort(), "input order does not matter");
  // A node at least as important blocks a name; a lesser node or the name's own node does not.
  const obstacles = [
    { id: "e:big", box: box(0, 100, 30, 30), priority: 1040 },
    { id: "e:tiny", box: box(200, 100, 10, 10), priority: 1002 },
  ];
  const named = placeLabels(
    [
      { id: "m:9", box: box(-10, 110), priority: 500 },
      { id: "e:mid", box: box(190, 98), priority: 1020 },
      { id: "e:big", box: box(-5, 105), priority: 1040 },
    ],
    { obstacles },
  );
  assert.ok(!named.has("m:9"), "a memory name may not cover a hub's square");
  assert.ok(named.has("e:mid"), "a bigger entity's name may sit over a tiny square (drawn on top)");
  assert.ok(named.has("e:big"), "a name may sit on its own node");
  // A budget keeps the most important names only.
  assert.deepEqual([...placeLabels(items, { budget: 2 })].sort(), ["e:hub", "sel"]);
  // Equal priority: by id. Far apart: both. Thousands stay fast (grid cells).
  assert.deepEqual([...placeLabels([{ id: "b", box: box(0, 0), priority: 1 }, { id: "a", box: box(10, 0), priority: 1 }])], ["a"]);
  assert.equal(placeLabels([{ id: "a", box: box(0, 0), priority: 1 }, { id: "b", box: box(500, 500), priority: 1 }]).size, 2);
  const many = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, box: box((i * 37) % 3000, Math.floor(i / 80) * 9), priority: i % 7 }));
  const t0 = performance.now();
  placeLabels(many);
  assert.ok(performance.now() - t0 < 500);
});
