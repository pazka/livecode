# livecode

https://code.hosh.it — live-code an HTML / CSS / JavaScript page together: shared cursors, live preview,
per-person themes (incl. high contrast) and keymaps (VS Code, JetBrains, Sublime, Vim, Emacs), every shortcut
customisable, fully keyboard accessible.

- `BRIEF.md` — what it does and why · `DEPLOY.md` — deployment on the hosh.it box · `docs/BOX-CONTRACT.md` — box rules
- Code: `src/server` (Deno: rooms, Yjs sync, persistence, limits), `src/client` (CodeMirror 6 + y-codemirror),
  `src/shared` (wire protocol), `web/` (HTML, CSS themes, preview frame).
- Checks: `deno task build && deno task check && deno task test && deno task e2e` — **in CI only**
  (box Decision #17: app code and dependencies never run on the box). Lockfile/format/diagnostics without a
  local Deno: Actions → **bootstrap** → artifacts.
