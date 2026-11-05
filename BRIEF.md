# livecode — brief

**https://code.hosh.it** — owner: Alexandre (pazka). Request (2026-11-04): *"a new project where users can live
code an html / css / js webpage together, where we can see the cursor of each other and the webpage is
refreshed live (with rebound protection of course). The theme must be choosable for each user, several
available from light to dark to high contrast etc. Accessible to keyboard too, usable keymaps for users (vim,
jetbrains, vscode, etc.) and keymaps customisable quickly."*

## Users and access
- Anyone with a room link can join and edit (owner choice). `/new` makes a random 12-character room;
  people can also type a room name (`/r/my-room`). No accounts, no passwords.
- Limits instead of auth (owner: "TTL of 7 days … a safe but comfortable limit to the text content … so we
  can't crash the server or create tons of rooms"): rooms idle for **7 days** are deleted; **128 K characters
  per file** (≈ 3 000 lines; the editor refuses more, the server cuts back); 640 KiB per room; 32 people per
  room; 20 new rooms/h per address and 200/h in total; 2 000 rooms / 512 MB on disk; 100 rooms in memory and
  a memory guard; connections per address (24) and in total (500); message size and rate limits.

## Features
1. **Three shared files** — HTML, CSS, JavaScript — edited together (Yjs CRDT: no lost edits, offline edits
   merge on reconnect). Remote **cursors and selections with names** in every file; a dot on each file tab
   for who is where; the people list jumps to a person's cursor.
2. **Live preview** refreshed for everyone after a debounce ("anti-rebond", default 600 ms after the last
   keystroke, per person 100–5000 ms); Run (Ctrl/Cmd+Enter or Ctrl/Cmd+S) forces it; auto-refresh can be
   turned off. No flash: the new version swaps in once it is alive. Console output and errors of the page
   appear in a console panel.
3. **Safety of the preview**: sandboxed iframe without `allow-same-origin` (opaque origin: no access to the
   app, its storage or other rooms), its own CSP (no form posts, can't be framed elsewhere), loop guard
   (any for/while/do loop running 1.5 s without yielding is stopped), and if a preview ever freezes the tab,
   the next load starts with the preview paused (`?norun` does the same by hand).
4. **Themes per person**: Light, Dark, Dim, Sepia, Solarized light/dark, High contrast dark/light, and
   "System" (follows dark mode, `prefers-contrast` and Windows forced colours). Every theme meets WCAG
   contrast (text ≥ 4.5:1, ≥ 7:1 for high contrast; focus, borders ≥ 3:1) — enforced by a test.
5. **Keymaps per person**: VS Code (default), JetBrains, Sublime Text, Vim (with `:w` = run, `:e css`,
   user `imap/nmap/noremap` lines), Emacs. **Every shortcut is customisable fast**: Settings → Keyboard
   → Change → press the keys (chords like Ctrl+K Ctrl+S work), Add, Clear, Reset, conflicts shown,
   export/import as JSON. A command palette (F1 / Ctrl+Shift+P, or the preset's own key) runs anything,
   including "theme …" and "keymap …".
6. **Keyboard and screen readers**: skip link, landmarks, tabs with arrow keys, resizable split by keyboard,
   F6 cycles toolbar → editor → preview → console, Escape then Tab leaves the editor (or toggle "Tab moves
   focus"), joins/leaves and status announced politely, `aria-keyshortcuts` on buttons, reduced motion.
7. Per-person settings stay in the browser (localStorage); only name + colour are shared.
8. **Completions** (owner, 2026-11-05): CSS as the package gives it, plus `.` / `#` selectors from the page's
   classes and ids; JavaScript: the browser's own globals and members (`document.`, `Math.` …), every word
   already written in the script, the page's classes / ids inside `querySelector("…")`, `getElementById("…")`,
   `classList.add("…")`; HTML: a tag name at the start of a line becomes the element (`div`, `ul.menu`,
   `section#top.hero`), `class="…"` / `id="…"` complete from the stylesheet. **Tab takes the highlighted
   suggestion** (Enter too); with no list open Tab indents as before.
9. **Name chips of remote cursors** are hidden where carets crowd (another caret — or yours — within 8
   characters on the same line); hovering the caret shows the name.
10. **One, two or three files at once** in the code area (per person): the 1 / 2 / 3 buttons, side by side or
   stacked (automatic by width, or chosen), each pane resizable (drag or arrow keys on the line between),
   moved by dragging its title bar or a file button (or the ‹ › buttons), hidden with ×, "only this" with □;
   Ctrl/Cmd/Shift+click on a hidden file opens it beside; commands "Open another file beside" (VS Code
   Ctrl+\\), "Show all three files", "Show only the current file" … in the palette.

## Stack (Decision #17 deps approved by the owner, 2026-11-04)
Deno 2.9 (compiled single binary, distroless, uid 10001). yjs + y-protocols (+ lib0), CodeMirror 6,
y-codemirror.next, @replit/codemirror-vim, @replit/codemirror-emacs; CI-only: @std/assert, playwright-core.
No other runtime dependency; no outbound calls from the server.

## Not in v0.1 (ideas for the owner)
Room history / snapshots, read-only share links, owner passphrase for room creation, room templates,
external library picker, mouse pointers over the preview.
