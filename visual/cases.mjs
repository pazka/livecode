// Visual use cases covered by the harness (ids from TESTING.md "Visual use cases").
// Each: { id, path, dark?, room?, storage?, mask?, steps? }.
// - room: the case opens /r/<room>; every case has its own room, so no case changes another's page.
//   The 3 widths (and dark) of a case share its room: its steps must give the same page when run again.
//   A fresh room holds the server's fixed starter (src/shared/starter.ts).
// - storage: localStorage entries merged over BASE_STORAGE before the page loads (per-person settings).
// - mask: CSS selectors made invisible before the shot (layout kept); fixText: { selector: text } pinned.
//   Every room case pins #preview-status ("Updated <clock time>") to "Updated 12:00:00 PM" (shoot.mjs).
// - steps(page): browser actions before the shot (clicks, typing), Node built-ins only.
export const WIDTHS = [1400, 1024, 390];

/** The person's settings are random on a first visit (name, colour): pinned here. */
export const SETTINGS = { name: "Visual Tester", color: "#f42525" };
export const BASE_STORAGE = { "livecode.settings.v1": SETTINGS };

const click = (sel) => async (p) => {
  if (!(await p.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`))) throw new Error(`no ${sel}`);
  await p.evaluate(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
};
const visible = (sel) => async (p) => {
  const ok = await p.waitFor(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
    return !!e && !e.hidden && e.getClientRects().length > 0; })()`);
  if (!ok) throw new Error(`${sel} not shown`);
};
const setText = (file, text) => async (p) => {
  await p.evaluate(`globalThis.__livecode.setText(${JSON.stringify(file)}, ${JSON.stringify(text)}); true`);
};
const seq = (...fs) => async (p) => {
  for (const f of fs) await f(p);
};

const BROKEN_JS = `const out = document.getElementById("out");
out.textContent = "before the error";
missingFunction();
`;

const CONSOLE_JS = `console.log("hello from the page");
console.warn("careful", { count: 2 });
console.error("something went wrong");
`;

export const CASES = [
  // Landing (/)
  { id: "L1-landing", path: "/", dark: true },
  {
    id: "L2-join-error",
    path: "/",
    steps: seq(async (p) => {
      await p.evaluate(`(() => { const i = document.getElementById("join-input"); i.value = "no";
        document.getElementById("join-form").requestSubmit(); return true; })()`);
    }, async (p) => {
      if (!(await p.waitFor(`document.getElementById("join-error").textContent.trim() !== ""`))) {
        throw new Error("no join error shown");
      }
    }),
  },
  {
    id: "L3-recent-rooms",
    path: "/",
    // fixed dates; the page runs in UTC with the en-US locale (shoot.mjs)
    storage: {
      "livecode.recent.v1": [
        { id: "visual-recent-one", at: Date.UTC(2026, 0, 2, 10, 30) },
        { id: "visual-recent-two", at: Date.UTC(2026, 0, 1, 9, 0) },
      ],
    },
  },
  // Room (/r/<room>): toolbar, code, preview
  { id: "R1-room-starter", room: "visual-starter", dark: true },
  { id: "R2-room-three-files", room: "visual-three-files", steps: click('.pane-tools [data-count="3"]') },
  {
    id: "R3-room-stacked",
    room: "visual-stacked",
    storage: { "livecode.settings.v1": { ...SETTINGS, panes: ["html", "css"], paneDir: "column" } },
  },
  {
    id: "R4-room-script-error",
    room: "visual-script-error",
    steps: seq(click('#tab-js'), setText("js", BROKEN_JS), visible("#tab-js .errs")),
  },
  {
    id: "R5-room-console",
    room: "visual-console",
    steps: seq(setText("js", CONSOLE_JS), click("#console-btn"), visible("#console"), async (p) => {
      if (!(await p.waitFor(`document.querySelectorAll("#console-list > li").length >= 3`))) {
        throw new Error("the console does not show the page's 3 messages");
      }
    }),
  },
  {
    id: "R6-room-typescript",
    room: "visual-typescript",
    // TypeScript is shared with the room (which every width reuses): switched on only if it is off
    steps: seq(click("#tab-js"), async (p) => {
      await p.evaluate(`(() => { const c = document.getElementById("js-ts"); if (!c.checked) c.click(); return true; })()`);
    }, visible("#tab-js .errs")),
  },
  { id: "R7-room-high-contrast", room: "visual-contrast", storage: { "livecode.settings.v1": { ...SETTINGS, theme: "hc-dark" } } },
  // Dialogs
  { id: "D1-settings", room: "visual-settings", steps: seq(click("#settings-btn"), visible("#settings[open]")) },
  { id: "D2-help", room: "visual-help", steps: seq(click("#help-btn"), visible("#help[open]")) },
  { id: "D3-commands", room: "visual-commands", steps: seq(click("#palette-btn"), visible("#palette[open]")) },
  // Preview screen (/r/<room>/view)
  { id: "V1-viewer", path: "/r/visual-viewer/view", viewer: true },
];
