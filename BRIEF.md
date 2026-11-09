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
11. **Errors in the code** (per person, on by default — Settings → Editor): the script's syntax errors and
   uncaught exceptions (as the browser reports them when the preview runs it) and the stylesheet's syntax
   errors (plain messages: missing `;` or `:`, `{` never closed, `}` too many) are marked on their line with
   the message at the line's end and a count on the file button. They refresh with the preview, i.e. after
   the person's own refresh delay (100–5000 ms), or on Run when auto-refresh is off.
12. Copying the room link shows a short "Copied to clipboard" note under the button.
13. **Console: "Keep between runs"** switch in the console header (per person, **off by default**): off, each
   new run of the preview starts with an empty console; on, earlier output stays and a "page reloaded" divider
   marks each run. Also in the palette.
14. **TypeScript** (owner, 2026-11-06: *"use typescript too, so that autocompletion works with typescript
   objects and all the basic TS DOM definitions … same for custom made objects, types, interfaces"*): a
   **TypeScript** switch above the code (room-wide, like "ES module"; also "Script language" in the palette)
   turns `script.js` into `script.ts`. Then, from the TypeScript language service with the browser's own type
   definitions (lib.esnext + lib.dom), in a worker loaded only by such rooms:
   - completions know the types: `document.` → the Document's members, an element's members after
     `querySelector("button")`, a canvas context's, the room's own **interfaces, types, classes and enums**
     (`p.` → exactly the fields of `Point`, optional ones marked), event names inside `addEventListener("…")`,
     a union's literal values; each with its signature and documentation beside the list;
   - the type under the mouse (hover), and **Show the type at the cursor** by keyboard (VS Code Ctrl/Cmd+K
     Ctrl/Cmd+I, any preset can bind it; announced to screen readers); Escape closes it;
   - **type errors** (strict mode) marked like the other errors (feature 11), refreshed after the person's
     delay even when only types changed;
   - the preview runs the TypeScript with its types removed (nothing else changed: same ES version, imports
     kept for a module); runtime errors and loop-guard stops are shown on the **TypeScript** line, and the
     console says "TS line N". Imports from a URL are typed `any`; top-level names never clash with the DOM's
     globals (`name`, `status` …).

15. **Preview screen** (owner, 2026-11-09: *"open the live preview in another tab so that I can put it on
   another screen in fullscreen … it won't count as another user … maybe an eye icon in the list"*): the ↗
   button in the preview header (or "Open the preview in a new tab" in the palette) opens `/r/<room>/view`:
   the page alone, full window, live. It joins the room by itself (works without the editor open, follows
   everyone's edits) with the person's own refresh delay; with auto-refresh off it runs when they press Run
   in an editor tab (same browser). A small bar (status, Run, **Fullscreen**, back to the editor) fades away
   and comes back on hover or focus. It is **not a person**: everyone sees an **eye** in its owner's colour
   after the avatars ("Ada's preview screen"), the status says "2 people · 1 preview screen", no cursor,
   no file dot; opening / closing it is announced as such. Same tab reused per room.
16. **Page hidden in the editor** (owner, 2026-11-09: *"if I run the preview on another screen, I can minimize the
   preview on the coding screen … and / or keep only the console"*): the "Hide the page here" button in the
   preview header (per person; also in the palette) leaves the console alone in the preview area when it is
   open, or removes the area (code full width) when it is closed; a **Preview** button then appears in the top
   bar, with the count of new errors, to bring it back. The hidden preview keeps running: errors are still
   marked in the code and counted.

17. **Rename** (owner, 2026-11-09): VS Code **F2**, JetBrains **Shift+F6**, "Rename" in the palette (bindable in
   any preset). A box over the name, every use highlighted; Enter renames them all in one edit (one undo step,
   shared), Escape cancels. In the script (JS or TS) the TypeScript service finds the uses, scope-aware
   (another `x` in another function is untouched; a property follows its uses; the browser's own names are
   refused with a message); in HTML / CSS, every whole-word occurrence in the file.
18. **Multiple cursors with the mouse, as in each editor** (owner): VS Code **Alt+click** adds a cursor,
   **Shift+Alt+drag** selects a column; JetBrains **Alt+Shift+click** adds a caret (on a caret: removes it),
   **Alt+drag** a column; Sublime / Vim / Emacs Ctrl/⌘+click and Alt+drag. Ctrl/⌘+click adds a cursor in every
   preset. Keyboard help lists the gestures of the current keymap.
19. **Completion icons** are letters in the theme's token colours (m method, ƒ function, p property, v variable,
   c constant, C class, I interface, T type, E enum, k keyword) — CodeMirror's □ / 𝑥 symbols showed as
   missing-glyph boxes on macOS.

## Stack (Decision #17 deps approved by the owner, 2026-11-04; typescript 2026-11-06)
Deno 2.9 (compiled single binary, distroless, uid 10001). yjs + y-protocols (+ lib0), CodeMirror 6,
y-codemirror.next, @replit/codemirror-vim, @replit/codemirror-emacs, **typescript 6.0.3** (Microsoft,
Apache-2.0, no dependencies; browser-side only, in `/ts-worker.js` — 6.0 is the last TypeScript written in
JavaScript, 7.x is a native binary that cannot run in a page); CI-only: @std/assert, playwright-core.
No other runtime dependency; no outbound calls from the server.

## Not in v0.1 (ideas for the owner)
Room history / snapshots, read-only share links, owner passphrase for room creation, room templates,
external library picker, mouse pointers over the preview.
