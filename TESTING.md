# TESTING.md — pazka/livecode

How the app is tested. The checks below run in CI (`.github/workflows/ci.yml`); app code and its
dependencies never run on the box (Decision #17).

| Job / step | What it proves |
|---|---|
| `test`: `deno task check` | format, lint, type check |
| `test`: `deno task test` | unit + real-socket integration tests (`tests/`) |
| `test`: `deno task e2e` | two Chromium windows in one room (`e2e/`): editing, collaboration, preview screen, TypeScript, export |
| `image`: Trivy gate | no fixable CRITICAL vulnerability in the image |
| `image`: container smoke | the image runs hardened (uid 10001, read-only, no caps), `/healthz`, in-container `smoke`, a foreign Origin is refused, clean SIGTERM |
| `image`: visual regression | every use case below at 1400 / 1024 / 390 px, compared with `visual/baseline/` |

## Visual use cases

Harness: `visual/` (hosh-management `AGENTS.md` §3). `visual/run.sh <image>` starts the built image
hardened as on the box (uid 10001 from the image, read-only rootfs, `cap_drop ALL`,
`no-new-privileges`, empty `/data` volume), then `visual/shoot.mjs` drives the machine's Chrome over
the DevTools protocol (Node built-ins only, no package) and shoots each case at **1400, 1024 and
390 px** (390: a touch browser without a mouse). Each shot is compared with `visual/baseline/<id>-<width>.png`
(per-pixel tolerance 24, at most 0.1 % of the pixels may differ); a diff picture is written to
`visual/out/diff/`. In CI, `visual/out/` is uploaded as the artifact `visual-<sha>`.

Every case runs in a fresh browser context (a new visitor). Every room case opens its own room, which the
server creates from the fixed starter (`src/shared/starter.ts`); the 3 widths of a case share that room.

| Id | Page / state | How it is reached |
|---|---|---|
| L1-landing | Landing page, no recent room (light and dark) | `/` |
| L2-join-error | Landing, join form refused a bad room name | `/`, type `no` in the join field, Join |
| L3-recent-rooms | Landing with two recent rooms | `/` with two rooms in this browser's history (fixed dates) |
| R1-room-starter | Room with the starter: code (index.html) + live preview (light and dark) | `/r/visual-starter` |
| R2-room-three-files | The three files side by side | room, "Show all three files" |
| R3-room-stacked | Two files stacked (index.html over style.css) | room, settings `panes: html, css`, `paneDir: column` |
| R4-room-script-error | A script that throws: error badge on the tab, inline error, console count | room, script.js tab, script with `missingFunction()` |
| R5-room-console | The preview's console open with a log, a warning and an error | room, script with 3 `console.*` calls, console button |
| R6-room-typescript | Script switched to TypeScript: `script.ts`, type errors inline | room, script tab, TypeScript switch on |
| R7-room-high-contrast | Room in the "High contrast dark" theme | room, theme `hc-dark` in the person's settings |
| D1-settings | Settings dialog open (Appearance) | room, gear button |
| D2-help | Keyboard help dialog open | room, `?` button |
| D3-commands | Command palette open | room, Commands button |
| V1-viewer | Preview screen: the page alone, with its bar | `/r/visual-viewer/view` |

**Pinned so that a diff means a real change**
- The person's name and colour are random on a first visit: every case starts with the settings
  `name: "Visual Tester"`, `color: #f42525` (`visual/cases.mjs`).
- The preview header says "Updated <clock time>": its text is set to `Updated 12:00:00 PM` in every room case.
- The page runs in UTC with the `en-US` locale (recent rooms' dates). Animations, transitions and the caret are off.
- The harness sets `Page.setBypassCSP` so it can add its freeze stylesheet (the app's CSP refuses inline
  styles); the app's own code runs the same.

**Not covered** (and why)
- Two people in one room (other people's cursors, avatars): covered by the e2e tests, not shot.
- The preview fullscreen, popup window and exported file: browser features outside the page, covered by e2e.
- Keymaps other than VS Code (Vim, Emacs...), every theme except light, dark and high contrast dark.
- Banners (disconnected, room full, limits): they need the server in a failing state.

**Phone layout (hub #33, fixed 2026-11-17):** at 390 px the room page fits the screen (no horizontal
scroll; every 390 shot is 390 px wide, so a page that grows wider fails on its size). The code-area header
wraps (switches and file tools on a second line) and the status bar wraps whole items.

**Renewing the baselines** (only in a PR that says the visual change is wanted):
`docker build -t livecode:local . && bash visual/run.sh livecode:local --update`, look at every changed
picture, commit them. Baselines are only meaningful for the Chrome that made them (`visual/baseline/chrome.txt`):
the committed ones come from the CI runner's Chrome. When the runner's Chrome changes and shots move,
take them from the CI log: the visual step runs with `VISUAL_PRINT_NEW=1`, and
`node visual/from-log.mjs <job log>` writes every failing shot back as a file (sha256 checked).
