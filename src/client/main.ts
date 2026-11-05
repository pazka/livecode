// livecode front-end: landing page (/) or a room (/r/<id>): three shared editors, live preview, presence,
// themes, keymaps, command palette, settings. See BRIEF.md for the feature list.

import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import { searchPanelOpen } from "@codemirror/search";
import { Vim } from "@replit/codemirror-vim";
import { type FileId, FILES, isRoomId, MAX_FILE_CHARS, type Notice } from "../shared/protocol.ts";
import { ALL_COMMANDS, APP_COMMANDS, COMMAND_BY_ID } from "./commands.ts";
import { composeDocument } from "./compose.ts";
import { addShownErrors, type CodeError, cssErrors, errorCount, showErrors } from "./diagnostics.ts";
import { FILE_LABELS, SharedEditor } from "./editors.ts";
import {
  autoDirection,
  closePane,
  dropPane,
  goToPane,
  movePane,
  openBeside,
  resizePair,
  setPaneCount,
} from "./panes.ts";
import { ariaShortcut, displayBinding, eventStrokes } from "./keys.ts";
import { effectiveBindings, isPlainKey, makeMatcher, type Matcher, PRESETS } from "./keymaps.ts";
import { type ConsoleEntry, Preview, previousRunFroze } from "./preview.ts";
import { RoomProvider, type Status } from "./provider.ts";
import { type Settings, SettingsStore } from "./settings.ts";
import { resolveTheme, THEME_CHOICES, THEMES } from "./themes.ts";
import { $, announce, h } from "./ui/dom.ts";
import { Palette, type PaletteItem } from "./ui/palette.ts";
import { SettingsDialog } from "./ui/settingsDialog.ts";

const settings = new SettingsStore();

// ---------- theme (applied before anything renders) ----------
const mq = (q: string) => matchMedia(q).matches;
function applyTheme(s: Settings) {
  document.documentElement.dataset.theme = resolveTheme(s.theme, mq);
  document.documentElement.style.setProperty("--editor-font-size", `${s.fontSize}px`);
}
applyTheme(settings.get());
for (const q of ["(prefers-color-scheme: dark)", "(prefers-contrast: more)", "(forced-colors: active)"]) {
  matchMedia(q).addEventListener("change", () => applyTheme(settings.get()));
}

// ---------- recent rooms ----------
const RECENT_KEY = "livecode.recent.v1";
function recentRooms(): { id: string; at: number }[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v)
      ? v.filter((r) => r && isRoomId(r.id) && typeof r.at === "number").slice(0, 10)
      : [];
  } catch {
    return [];
  }
}
function rememberRoom(id: string) {
  const list = [{ id, at: Date.now() }, ...recentRooms().filter((r) => r.id !== id)].slice(0, 10);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* storage off */ }
}

// ---------- route ----------
const m = location.pathname.match(/^\/r\/([^/]+)\/?$/);
if (m && isRoomId(m[1])) startRoom(m[1]);
else startLanding();

function startLanding() {
  $("landing").hidden = false;
  document.title = "livecode — code a page together";
  const form = $<HTMLFormElement>("join-form");
  const input = $<HTMLInputElement>("join-input");
  const err = $("join-error");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    const fromUrl = v.match(/\/r\/([a-z0-9-]+)/i)?.[1];
    const id = (fromUrl ?? v).toLowerCase();
    if (!isRoomId(id)) {
      err.textContent = "That is not a room link or a valid room name (a–z, 0–9, dashes, 4–40 characters).";
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    location.href = `/r/${id}`;
  });
  const recent = recentRooms();
  if (recent.length) {
    $("recent").hidden = false;
    $("recent-list").replaceChildren(...recent.map((r) =>
      h(
        "li",
        {},
        h("a", { href: `/r/${r.id}`, text: r.id }),
        ` — ${new Date(r.at).toLocaleString()}`,
      )
    ));
  }
  $("new-room").focus();
}

// ---------- room ----------
function startRoom(roomId: string) {
  $("app").hidden = false;
  document.title = `${roomId} — livecode`;
  $("room-name").textContent = roomId;
  rememberRoom(roomId);

  const doc = new Y.Doc();
  const texts = Object.fromEntries(FILES.map((f) => [f, doc.getText(f)])) as Record<FileId, Y.Text>;
  const meta = doc.getMap<unknown>("meta");
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${roomId}`;

  let previewPaused = previousRunFroze() || new URLSearchParams(location.search).has("norun");
  let renders = 0;
  const hook = { ready: false, renders: () => renders, console: [] as ConsoleEntry[] };

  // --- connection + presence ---
  const statusEl = $("conn-status");
  const provider = new RoomProvider(wsUrl, doc, {
    status: (s) => renderStatus(s),
    synced: () => {
      hook.ready = true;
      syncModuleToggle();
      if (!previewPaused) preview.render(true);
      else setPreviewStatus();
    },
    notice: (n) => showNotice(n),
  });
  const awareness = provider.awareness;

  function renderStatus(s: Status = provider.status) {
    const n = awareness.getStates().size;
    statusEl.dataset.state = s;
    statusEl.textContent = s === "online"
      ? `Connected · ${n} ${n === 1 ? "person" : "people"}`
      : s === "connecting"
      ? "Connecting…"
      : s === "offline"
      ? "Offline — reconnecting"
      : "Disconnected";
  }

  function showNotice(n: Notice) {
    const b = $("banner");
    b.hidden = false;
    b.textContent = n.message;
    if (n.code === "rate-limited" || n.code === "file-too-large") {
      const shown = n.message;
      setTimeout(() => {
        if (b.textContent === shown) b.hidden = true;
      }, 5000);
    }
  }

  // --- editors + tabs ---
  let current: FileId = settings.get().panes[0];
  const editors = Object.fromEntries(FILES.map((f) => [
    f,
    new SharedEditor(
      f,
      $(`panel-${f}`),
      texts[f],
      awareness,
      editorOptions(settings.get()),
      onFileLimit,
      (file, line, col) => {
        if (file === current) $("sb-pos").textContent = `Ln ${line}, Col ${col}`;
      },
      (g) => texts[g].toString(),
    ),
  ])) as Record<FileId, SharedEditor>;

  let limitNoticeAt = 0;
  function onFileLimit(f: FileId) {
    if (Date.now() - limitNoticeAt < 3000) return;
    limitNoticeAt = Date.now();
    showNotice({
      code: "file-too-large",
      message: `${FILE_LABELS[f]} is at its size limit (${
        MAX_FILE_CHARS / 1024
      } K characters): that edit was not applied.`,
    });
  }

  function editorOptions(s: Settings) {
    return { keymap: s.keymap, tabSize: s.tabSize, lineWrap: s.lineWrap };
  }

  // --- files: the buttons above the code, and one, two or three panes (panes.ts) ---
  const tabs = FILES.map((f) => $<HTMLButtonElement>(`tab-${f}`));
  const panesEl = $("panes");
  const paneEl = (f: FileId) => $(`pane-${f}`);
  const othersIn: Record<FileId, number> = { html: 0, css: 0, js: 0 };
  const FILE_NAMES: Record<FileId, string> = { html: "index.html", css: "style.css", js: "script.js" };

  function labelTabs() {
    const shown = settings.get().panes;
    for (const t of tabs) {
      const f = t.dataset.file as FileId;
      const n = othersIn[f];
      const errs = errorCount(editors[f].view.state);
      const badge = t.querySelector<HTMLElement>(".errs")!;
      badge.hidden = errs === 0;
      badge.textContent = String(errs);
      t.dataset.shown = String(shown.includes(f));
      if (f === current) t.setAttribute("aria-current", "true");
      else t.removeAttribute("aria-current");
      t.setAttribute(
        "aria-label",
        `${FILE_NAMES[f]} (${FILE_LABELS[f]})${
          f === current ? ", editing" : shown.includes(f) ? ", shown" : ""
        }${n ? `, ${n} ${n === 1 ? "other person" : "other people"} here` : ""}${
          errs ? `, ${errs} ${errs === 1 ? "error" : "errors"}` : ""
        }`,
      );
    }
  }

  /** The file being edited: its button marked, its caret in the status bar, told to the room. */
  function setCurrent(f: FileId) {
    const changed = f !== current;
    current = f;
    labelTabs();
    for (const g of FILES) paneEl(g).classList.toggle("current", g === f);
    const st = editors[f].view.state;
    const ln = st.doc.lineAt(st.selection.main.head);
    $("sb-pos").textContent = `Ln ${ln.number}, Col ${st.selection.main.head - ln.from + 1}`;
    if (changed || awareness.getLocalState()?.file !== f) awareness.setLocalStateField("file", f);
  }

  /** Go to a file: shown → focus it; hidden → it takes the place of the file being edited. */
  function selectTab(f: FileId, focusEditor: boolean) {
    const s = settings.get();
    if (!s.panes.includes(f)) settings.update({ panes: goToPane(s.panes, current, f) });
    setCurrent(f);
    if (focusEditor) editors[f].focus();
  }
  function cycle(d: 1 | -1): FileId {
    const shown = settings.get().panes;
    const list: readonly FileId[] = shown.length > 1 ? shown : FILES;
    return list[(list.indexOf(current) + d + list.length) % list.length];
  }
  function setPanes(panes: FileId[], announceIt = true) {
    const before = settings.get().panes.join();
    settings.update({ panes });
    const now = settings.get().panes;
    if (!now.includes(current)) setCurrent(now[0]);
    if (announceIt && now.join() !== before) {
      announce(`Showing ${now.map((f) => FILE_NAMES[f]).join(", ")}`);
    }
  }
  for (const f of FILES) {
    editors[f].view.contentDOM.addEventListener("focus", () => {
      if (current !== f) setCurrent(f);
    });
  }

  let effectiveDir: "row" | "column" = "row";
  function applyPanes(s: Settings) {
    const shown = s.panes;
    const n = shown.length;
    effectiveDir = s.paneDir === "auto" ? autoDirection(panesEl.clientWidth || innerWidth / 2, n) : s.paneDir;
    panesEl.dataset.dir = effectiveDir;
    panesEl.dataset.count = String(n);
    for (const f of FILES) {
      const el = paneEl(f);
      const i = shown.indexOf(f);
      const was = el.hidden;
      el.hidden = i < 0;
      el.style.order = String(i * 2);
      el.style.flexGrow = String(n > 1 ? s.paneSizes[f] : 1);
      if (i >= 0) {
        const back = el.querySelector<HTMLButtonElement>("[data-act=back]")!;
        const fwd = el.querySelector<HTMLButtonElement>("[data-act=forward]")!;
        const [b, a] = effectiveDir === "row" ? ["left", "right"] : ["up", "down"];
        back.disabled = i === 0;
        fwd.disabled = i === n - 1;
        back.setAttribute("aria-label", `Move ${FILE_NAMES[f]} ${b}`);
        fwd.setAttribute("aria-label", `Move ${FILE_NAMES[f]} ${a}`);
        back.title = `Move ${b}`;
        fwd.title = `Move ${a}`;
        if (was) editors[f].view.requestMeasure();
      }
    }
    panesEl.querySelectorAll<HTMLElement>(".pane-splitter").forEach((sp, k) => {
      sp.hidden = k >= n - 1;
      sp.style.order = String(k * 2 + 1);
      if (sp.hidden) return;
      const a = shown[k], b = shown[k + 1];
      const pct = Math.round((s.paneSizes[a] / (s.paneSizes[a] + s.paneSizes[b])) * 100);
      sp.setAttribute("aria-orientation", effectiveDir === "row" ? "vertical" : "horizontal");
      sp.setAttribute("aria-label", `Resize ${FILE_NAMES[a]} and ${FILE_NAMES[b]}`);
      sp.setAttribute("aria-valuemin", "0");
      sp.setAttribute("aria-valuemax", "100");
      sp.setAttribute("aria-valuenow", String(pct));
      sp.setAttribute("aria-valuetext", `${FILE_NAMES[a]} ${pct} percent`);
    });
    for (const b of document.querySelectorAll<HTMLButtonElement>(".pane-tools [data-count]")) {
      b.setAttribute("aria-pressed", String(Number(b.dataset.count) === n));
    }
    const dirBtn = $("pane-dir");
    const toStack = effectiveDir === "row";
    dirBtn.setAttribute("aria-label", toStack ? "Stack the files" : "Put the files side by side");
    dirBtn.title = dirBtn.getAttribute("aria-label")!;
    dirBtn.hidden = n < 2;
    dirBtn.classList.toggle("stacked", !toStack);
    $("module-toggle").hidden = !shown.includes("js");
    if (!shown.includes(current)) setCurrent(shown[0]);
    else labelTabs();
  }
  new ResizeObserver(() => {
    const s = settings.get();
    if (s.paneDir === "auto" && autoDirection(panesEl.clientWidth, s.panes.length) !== effectiveDir) {
      applyPanes(s);
    }
  }).observe(panesEl);

  $("tabs").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-file]");
    if (!t) return;
    const f = t.dataset.file as FileId;
    const s = settings.get();
    // Ctrl / Cmd / Shift + click: open beside the current file instead of in its place
    if ((e.ctrlKey || e.metaKey || e.shiftKey) && !s.panes.includes(f)) {
      setPanes(openBeside(s.panes, current, f));
      setCurrent(f);
    } else {
      selectTab(f, false);
    }
  });
  $("tabs").addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = e.key === "ArrowRight"
      ? (i + 1) % FILES.length
      : e.key === "ArrowLeft"
      ? (i + FILES.length - 1) % FILES.length
      : e.key === "Home"
      ? 0
      : e.key === "End"
      ? FILES.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    // with one file shown the arrows switch files (like tabs); with several they only move between buttons
    if (settings.get().panes.length === 1) selectTab(FILES[next], false);
    for (const t of tabs) t.tabIndex = -1;
    tabs[next].tabIndex = 0;
    tabs[next].focus();
  });
  tabs.forEach((t, i) => (t.tabIndex = i === 0 ? 0 : -1));

  document.querySelector(".pane-tools")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b) return;
    if (b.id === "pane-dir") return app.paneDirection();
    setPanes(setPaneCount(settings.get().panes, current, Number(b.dataset.count)));
  });
  panesEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".pane-head [data-act]");
    if (!b) return;
    const f = b.closest<HTMLElement>(".pane")!.dataset.file as FileId;
    const s = settings.get();
    const act = b.dataset.act;
    if (act === "close") setPanes(closePane(s.panes, f));
    else if (act === "only") {
      setCurrent(f);
      setPanes([f]);
    } else setPanes(movePane(s.panes, f, act === "back" ? -1 : 1));
    // keep the keyboard where it was when the button disappears or goes disabled
    if (!b.isConnected || b.disabled || b.closest<HTMLElement>(".pane")!.hidden) editors[current].focus();
  });

  // drag a file button or a pane's title bar onto a pane: placed before / after it (by the pointer's half)
  const DRAG_TYPE = "application/x-livecode-file";
  let dragFile: FileId | null = null;
  const clearDrop = () =>
    panesEl.querySelectorAll(".drop-before, .drop-after").forEach((el) =>
      el.classList.remove("drop-before", "drop-after")
    );
  function onDragStart(e: DragEvent, f: FileId) {
    dragFile = f;
    e.dataTransfer?.setData(DRAG_TYPE, f);
    e.dataTransfer?.setData("text/plain", FILE_NAMES[f]);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }
  for (const t of tabs) t.addEventListener("dragstart", (e) => onDragStart(e, t.dataset.file as FileId));
  for (const f of FILES) {
    paneEl(f).querySelector<HTMLElement>(".pane-head")!.addEventListener(
      "dragstart",
      (e) => onDragStart(e, f),
    );
  }
  const dropTarget = (e: DragEvent): { f: FileId; after: boolean } | null => {
    const pane = e.target instanceof Element ? e.target.closest<HTMLElement>(".pane") : null;
    if (!pane || pane.hidden) return null;
    const r = pane.getBoundingClientRect();
    const after = effectiveDir === "row"
      ? e.clientX > r.left + r.width / 2
      : e.clientY > r.top + r.height / 2;
    return { f: pane.dataset.file as FileId, after };
  };
  panesEl.addEventListener("dragover", (e) => {
    if (!dragFile) return;
    const t = dropTarget(e);
    clearDrop();
    if (!t || t.f === dragFile) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    paneEl(t.f).classList.add(t.after ? "drop-after" : "drop-before");
  });
  panesEl.addEventListener("dragleave", (e) => {
    if (!panesEl.contains(e.relatedTarget as Node | null)) clearDrop();
  });
  panesEl.addEventListener("drop", (e) => {
    const t = dropTarget(e);
    clearDrop();
    if (!dragFile || !t) return;
    e.preventDefault();
    const f = dragFile;
    dragFile = null;
    setPanes(dropPane(settings.get().panes, f, t.f, t.after));
    setCurrent(f);
    editors[f].focus();
  });
  document.addEventListener("dragend", () => {
    dragFile = null;
    clearDrop();
  });

  // the line between two panes: drag, or arrow keys (Shift = bigger steps), Home / End
  panesEl.querySelectorAll<HTMLElement>(".pane-splitter").forEach((sp, k) => {
    const pair = () => {
      const shown = settings.get().panes;
      return [shown[k], shown[k + 1]] as const;
    };
    let live: Record<FileId, number> | null = null;
    sp.addEventListener("pointerdown", (e) => {
      live = { ...settings.get().paneSizes };
      sp.setPointerCapture(e.pointerId);
      document.body.style.userSelect = "none";
    });
    sp.addEventListener("pointermove", (e) => {
      if (!live) return;
      const [a, b] = pair();
      const ra = paneEl(a).getBoundingClientRect(), rb = paneEl(b).getBoundingClientRect();
      const row = effectiveDir === "row";
      const start = row ? ra.left : ra.top, end = row ? rb.right : rb.bottom;
      live = resizePair(live, a, b, ((row ? e.clientX : e.clientY) - start) / Math.max(1, end - start));
      paneEl(a).style.flexGrow = String(live[a]);
      paneEl(b).style.flexGrow = String(live[b]);
    });
    sp.addEventListener("pointerup", (e) => {
      if (!live) return;
      sp.releasePointerCapture(e.pointerId);
      document.body.style.userSelect = "";
      const sizes = live;
      live = null;
      settings.update({ paneSizes: sizes });
    });
    sp.addEventListener("keydown", (e) => {
      const [a, b] = pair();
      const sizes = settings.get().paneSizes;
      const frac = sizes[a] / (sizes[a] + sizes[b]);
      const step = e.shiftKey ? 0.15 : 0.05;
      const v = e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? frac - step
        : e.key === "ArrowRight" || e.key === "ArrowDown"
        ? frac + step
        : e.key === "Home"
        ? 0
        : e.key === "End"
        ? 1
        : null;
      if (v === null) return;
      e.preventDefault();
      settings.update({ paneSizes: resizePair(sizes, a, b, v) });
    });
    sp.addEventListener("dblclick", () => {
      const [a, b] = pair();
      settings.update({ paneSizes: resizePair(settings.get().paneSizes, a, b, 0.5) });
    });
  });

  // shared "run as module" switch (room-wide)
  const moduleBox = $<HTMLInputElement>("js-module");
  function syncModuleToggle() {
    moduleBox.checked = meta.get("jsModule") === true;
  }
  moduleBox.addEventListener("change", () => meta.set("jsModule", moduleBox.checked));
  meta.observe(syncModuleToggle);

  // --- preview ---
  const consoleEntries: ConsoleEntry[] = hook.console;
  let unseenErrors = 0;
  let lastRenderAt = 0;
  const preview = new Preview($("preview-frames"), () =>
    composeDocument({
      html: texts.html.toString(),
      css: texts.css.toString(),
      js: texts.js.toString(),
      jsModule: meta.get("jsModule") === true,
    }), {
    console: (e) => addConsole(e),
    started: () => (pendingJsErrors = []),
    pageError: (e, pending) => {
      const err: CodeError = { line: e.line, col: e.col || undefined, message: e.text };
      if (pending) pendingJsErrors.push(err);
      else if (collectingJs) shownJsErrors.push(err);
      else if (settings.get().showErrors) {
        addShownErrors(editors.js.view, [err]);
        errorsChanged();
      }
    },
    rendered: () => {
      renders++;
      lastRenderAt = Date.now();
      setPreviewStatus();
      refreshErrors();
    },
  });

  // --- errors in the code (diagnostics.ts), refreshed with the preview ---
  // JS: what the new version reports while it starts (collected for a moment, so a persistent error does not
  // blink off and on at each refresh), then anything it reports later (a click handler throwing …).
  let pendingJsErrors: CodeError[] = [];
  let shownJsErrors: CodeError[] = [];
  let collectingJs = false;
  let collectTimer: number | undefined;
  const lastCounts: Record<FileId, number> = { html: 0, css: 0, js: 0 };
  function refreshErrors() {
    if (!settings.get().showErrors) return clearErrors();
    showErrors(editors.css.view, cssErrors(texts.css.toString()));
    collectingJs = true;
    shownJsErrors = pendingJsErrors;
    pendingJsErrors = [];
    clearTimeout(collectTimer);
    collectTimer = setTimeout(() => {
      collectingJs = false;
      showErrors(editors.js.view, shownJsErrors);
      errorsChanged();
    }, 300);
    errorsChanged();
  }
  function clearErrors() {
    clearTimeout(collectTimer);
    collectingJs = false;
    for (const f of ["css", "js"] as const) showErrors(editors[f].view, []);
    errorsChanged();
  }
  function errorsChanged() {
    labelTabs();
    const said: string[] = [];
    for (const f of ["css", "js"] as const) {
      const n = errorCount(editors[f].view.state);
      if (n && n !== lastCounts[f]) said.push(`${FILE_LABELS[f]}: ${n} ${n === 1 ? "error" : "errors"}`);
      if (!n && lastCounts[f]) said.push(`${FILE_LABELS[f]}: no errors`);
      lastCounts[f] = n;
    }
    if (said.length) announce(said.join(", "));
  }
  doc.on("update", () => {
    const s = settings.get();
    if (s.autoRun && !previewPaused) preview.schedule(s.previewDelay);
    else setPreviewStatus();
  });

  function setPreviewStatus() {
    const s = settings.get();
    const el = $("preview-status");
    if (previewPaused) {
      el.textContent = "Paused — press Run";
    } else if (!s.autoRun) {
      el.textContent = `Auto-refresh off — press Run${renders ? ` · last run ${time(lastRenderAt)}` : ""}`;
    } else {
      el.textContent = renders ? `Updated ${time(lastRenderAt)}` : "";
    }
    $<HTMLInputElement>("auto-run").checked = s.autoRun && !previewPaused;
  }
  const time = (t: number) => new Date(t).toLocaleTimeString();

  if (previewPaused) {
    showNotice({
      code: "bad-message",
      message: "The preview is paused: the last one seemed to freeze this tab. Fix the code, then press Run.",
    });
  }

  function runPreview() {
    previewPaused = false;
    preview.render(true);
    setPreviewStatus();
  }

  $("run-btn").addEventListener("click", runPreview);
  $<HTMLInputElement>("auto-run").addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    previewPaused = false;
    settings.update({ autoRun: on });
    if (on) preview.render(false);
  });

  // --- console ---
  const consoleList = $("console-list");
  function addConsole(e: ConsoleEntry) {
    consoleEntries.push(e);
    if (consoleEntries.length > 500) {
      consoleEntries.shift();
      consoleList.firstElementChild?.remove();
    }
    const atBottom = consoleList.scrollTop + consoleList.clientHeight >= consoleList.scrollHeight - 4;
    consoleList.append(
      h(
        "li",
        { "data-level": e.level },
        h("span", { class: "lvl", text: e.level === "log" ? "›" : e.level }),
        e.text,
      ),
    );
    if (atBottom) consoleList.scrollTop = consoleList.scrollHeight;
    if (e.level === "error" && !settings.get().consoleOpen) {
      unseenErrors++;
      const c = $("console-count");
      c.hidden = false;
      c.textContent = String(unseenErrors);
      c.setAttribute("aria-label", `${unseenErrors} new errors`);
    }
  }
  function clearConsole() {
    consoleEntries.length = 0;
    consoleList.replaceChildren();
    announce("Console cleared");
  }
  $("console-clear").addEventListener("click", clearConsole);
  $("console-btn").addEventListener(
    "click",
    () => settings.update({ consoleOpen: !settings.get().consoleOpen }),
  );

  // --- people ---
  const names = new Map<number, string>();
  const peersEl = $("peers");
  const initials = (name: string) =>
    name.trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] ?? "").join("").toUpperCase() || "?";
  const MAX_AVATARS = 7;
  function renderPeers() {
    const states = awareness.getStates();
    const me = doc.clientID;
    const items: HTMLElement[] = [];
    const dots: Record<FileId, HTMLElement[]> = { html: [], css: [], js: [] };
    const entries = [...states.entries()].sort(([a], [b]) => (a === me ? -1 : b === me ? 1 : a - b));
    const hidden: string[] = [];
    for (const [id, st] of entries) {
      const u = st.user as { name?: string; color?: string } | undefined;
      if (!u?.name) continue;
      names.set(id, u.name);
      const f = (FILES as readonly string[]).includes(st.file) ? st.file as FileId : "html";
      const self = id === me;
      if (!self) dots[f].push(h("i", { style: `background:${u.color}` }));
      if (items.length >= MAX_AVATARS) {
        hidden.push(u.name);
        continue;
      }
      const label = `${u.name}${self ? " (you)" : ""}, in ${FILE_NAMES[f]}${
        self ? ": open your settings" : ": show their cursor"
      }`;
      items.push(h(
        "li",
        {},
        h("button", {
          type: "button",
          class: self ? "avatar self" : "avatar",
          "data-client": id,
          style: `background:${u.color}`,
          "aria-label": label,
          title: `${u.name}${self ? " (you)" : ""} · ${FILE_NAMES[f]}`,
          text: initials(u.name),
        }),
      ));
    }
    if (hidden.length) {
      items.push(h(
        "li",
        {},
        h("span", {
          class: "avatar more",
          role: "img",
          "aria-label": `and ${hidden.length} more: ${hidden.join(", ")}`,
          title: hidden.join(", "),
          text: `+${hidden.length}`,
        }),
      ));
    }
    peersEl.replaceChildren(...items);
    for (const f of FILES) {
      $(`tab-${f}`).querySelector(".dots")!.replaceChildren(...dots[f]);
      paneEl(f).querySelector(".pane-head .dots")!.replaceChildren(...dots[f].map((d) => d.cloneNode()));
      othersIn[f] = dots[f].length;
    }
    labelTabs();
    renderStatus();
  }
  awareness.on("change", (ch: { added: number[]; removed: number[] }, origin: unknown) => {
    renderPeers();
    if (origin === "local") return;
    const me = doc.clientID;
    const joined = ch.added.filter((id) => id !== me).map((id) => names.get(id)).filter(Boolean);
    const left = ch.removed.filter((id) => id !== me).map((id) => names.get(id)).filter(Boolean);
    if (joined.length) announce(`${joined.join(", ")} joined`);
    if (left.length) announce(`${left.join(", ")} left`);
    for (const id of ch.removed) names.delete(id);
  });
  peersEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-client]");
    if (!b) return;
    const id = Number(b.dataset.client);
    if (id === doc.clientID) return dialog.open("profile");
    jumpTo(id);
  });

  function jumpTo(clientId: number) {
    const st = awareness.getStates().get(clientId);
    if (!st) return;
    const f = (FILES as readonly string[]).includes(st.file) ? st.file as FileId : "html";
    selectTab(f, true);
    const head = st.cursor?.head;
    if (!head) return announce(`${names.get(clientId)} is in ${FILE_LABELS[f]}, no cursor yet`);
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), doc);
    if (!abs || abs.type !== texts[f]) return;
    const view = editors[f].view;
    const pos = Math.min(abs.index, view.state.doc.length);
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    announce(`${names.get(clientId)}'s cursor: ${FILE_LABELS[f]}, line ${view.state.doc.lineAt(pos).number}`);
  }

  function setUser(s: Settings) {
    awareness.setLocalStateField("user", { name: s.name, color: s.color, colorLight: `${s.color}55` });
  }
  setUser(settings.get());
  applyPanes(settings.get());
  setCurrent(settings.get().panes[0]);

  // --- layout: split + orientation ---
  const ws = $("workspace");
  const splitter = $("splitter");
  function applyLayout(s: Settings) {
    ws.dataset.layout = s.layout;
    ws.style.setProperty("--split", `${s.split}%`);
    splitter.setAttribute("aria-valuenow", String(Math.round(s.split)));
    splitter.setAttribute("aria-orientation", s.layout === "columns" ? "vertical" : "horizontal");
    splitter.setAttribute("aria-valuetext", `Code ${Math.round(s.split)} percent`);
    $("console").hidden = !s.consoleOpen;
    $("console-btn").setAttribute("aria-expanded", String(s.consoleOpen));
    if (s.consoleOpen) {
      unseenErrors = 0;
      $("console-count").hidden = true;
    }
  }
  let dragging = false;
  splitter.addEventListener("pointerdown", (e) => {
    dragging = true;
    splitter.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
  });
  splitter.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = ws.getBoundingClientRect();
    const cols = settings.get().layout === "columns";
    const pct = cols ? ((e.clientX - r.left) / r.width) * 100 : ((e.clientY - r.top) / r.height) * 100;
    const v = Math.max(15, Math.min(85, pct));
    ws.style.setProperty("--split", `${v}%`);
    splitter.setAttribute("aria-valuenow", String(Math.round(v)));
  });
  splitter.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = "";
    splitter.releasePointerCapture(e.pointerId);
    settings.update({ split: Number(splitter.getAttribute("aria-valuenow")) });
  });
  splitter.addEventListener("keydown", (e) => {
    const s = settings.get().split;
    const step = e.shiftKey ? 10 : 5;
    const v = e.key === "ArrowLeft" || e.key === "ArrowUp"
      ? s - step
      : e.key === "ArrowRight" || e.key === "ArrowDown"
      ? s + step
      : e.key === "Home"
      ? 15
      : e.key === "End"
      ? 85
      : null;
    if (v === null) return;
    e.preventDefault();
    settings.update({ split: Math.max(15, Math.min(85, v)) });
  });

  // --- commands ---
  const palette = new Palette(paletteItems);
  let keysSuspended = false;
  const dialog = new SettingsDialog(settings, { suspendKeys: (on) => (keysSuspended = on) });
  const helpDlg = $<HTMLDialogElement>("help");

  const focusRegions = () =>
    [
      document.querySelector<HTMLElement>(".bar button, .bar a"),
      editors[current].view.contentDOM,
      document.querySelector<HTMLIFrameElement>(".preview-frame:not(.pending)"),
      settings.get().consoleOpen ? consoleList : null,
    ].filter((x): x is HTMLElement => x !== null);

  const app: Record<string, () => void> = {
    run: runPreview,
    toggleAutoRun: () => {
      previewPaused = false;
      settings.update({ autoRun: !settings.get().autoRun });
      announce(`Auto-refresh ${settings.get().autoRun ? "on" : "off"}`);
    },
    toggleConsole: () => settings.update({ consoleOpen: !settings.get().consoleOpen }),
    clearConsole,
    focusPreview: () => preview.focus(),
    tabHtml: () => selectTab("html", true),
    tabCss: () => selectTab("css", true),
    tabJs: () => selectTab("js", true),
    // several files shown: next / previous go through them in their order; one shown: through all files
    nextTab: () => selectTab(cycle(1), true),
    prevTab: () => selectTab(cycle(-1), true),
    focusEditor: () => editors[current].focus(),
    paneOnly: () => setPanes([current]),
    paneSplit: () => {
      const next = openBeside(settings.get().panes, current);
      const added = next.find((f) => !settings.get().panes.includes(f));
      setPanes(next);
      if (added) selectTab(added, true);
    },
    paneAll: () => setPanes(setPaneCount(settings.get().panes, current, 3)),
    paneClose: () => {
      setPanes(closePane(settings.get().panes, current));
      editors[current].focus();
    },
    paneMoveBack: () => setPanes(movePane(settings.get().panes, current, -1)),
    paneMoveForward: () => setPanes(movePane(settings.get().panes, current, 1)),
    paneDirection: () => {
      settings.update({ paneDir: effectiveDir === "row" ? "column" : "row" });
      announce(effectiveDir === "row" ? "Files side by side" : "Files stacked");
    },
    nextPane: () => {
      const regions = focusRegions();
      const a = document.activeElement;
      const i = regions.findIndex((r) =>
        r === a || r.contains(a) ||
        (r === editors[current].view.contentDOM && editors[current].view.hasFocus) ||
        (r.classList.contains("bar") && r.contains(a))
      );
      const inBar = a instanceof HTMLElement && a.closest(".bar") !== null;
      const from = inBar ? 0 : i;
      regions[(from + 1) % regions.length]?.focus();
    },
    palette: () => palette.toggle(),
    settings: () => dialog.open(),
    keybindings: () => dialog.open("keyboard"),
    cycleTheme: () => {
      const i = THEME_CHOICES.findIndex((t) => t.id === settings.get().theme);
      const next = THEME_CHOICES[(i + 1) % THEME_CHOICES.length];
      settings.update({ theme: next.id });
      announce(`Theme: ${next.label}`);
    },
    toggleLayout: () => settings.update({ layout: settings.get().layout === "columns" ? "rows" : "columns" }),
    toggleWrap: () => settings.update({ lineWrap: !settings.get().lineWrap }),
    fontBigger: () => settings.update({ fontSize: settings.get().fontSize + 1 }),
    fontSmaller: () => settings.update({ fontSize: settings.get().fontSize - 1 }),
    fontReset: () => settings.update({ fontSize: 14 }),
    copyLink: () => {
      navigator.clipboard.writeText(location.href).then(
        () => {
          popover("Copied to clipboard", false);
          announce("Room link copied to the clipboard");
        },
        () => {
          popover("Copy failed — the link is in the address bar", true);
          announce("Copy failed: the link is in the address bar");
        },
      );
    },
    newRoom: () => (location.href = "/new"),
    help: () => {
      renderHelp();
      if (!helpDlg.open) helpDlg.showModal();
    },
  };
  for (const c of APP_COMMANDS) if (!app[c.id]) console.warn("no handler for", c.id);

  /** Runs a command; editor commands need an editor (the focused one, or the current tab from the palette). */
  function runCommand(id: string, view: EditorView | null): boolean {
    const c = COMMAND_BY_ID.get(id);
    if (!c) return false;
    if (c.kind === "app") {
      app[id]?.();
      return true;
    }
    if (!view) return false;
    return c.run(view);
  }

  $("copy-link").addEventListener("click", app.copyLink);
  let popTimer: number | undefined;
  /** A short note under the copy button (screen readers get the same words through announce). */
  function popover(text: string, fail: boolean) {
    const p = $("copy-pop");
    p.textContent = text;
    p.classList.toggle("fail", fail);
    p.hidden = false;
    clearTimeout(popTimer);
    popTimer = setTimeout(() => (p.hidden = true), 1800);
  }
  $("palette-btn").addEventListener("click", () => palette.open());
  $("settings-btn").addEventListener("click", () => dialog.open());
  $("help-btn").addEventListener("click", app.help);

  // --- the key matcher (capture phase: runs before CodeMirror, chords included) ---
  let bindings = effectiveBindings(settings.get().keymap, settings.get().overrides[settings.get().keymap]);
  let matcher: Matcher = makeMatcher(bindings);
  let pending: string | null = null;
  let pendingTimer: number | undefined;
  const clearPending = () => {
    pending = null;
    clearTimeout(pendingTimer);
  };
  /** The editor the key is for: its text (`inPanel` false) or one of its panels, e.g. the search field. */
  function editorAt(target: EventTarget | null): { view: EditorView; inPanel: boolean } | null {
    if (!(target instanceof Node)) return null;
    for (const f of FILES) {
      const v = editors[f].view;
      if (v.dom.contains(target)) return { view: v, inPanel: !v.contentDOM.contains(target) };
    }
    return null;
  }
  /** Keys CodeMirror's own open UI needs first: the completion list, and Escape closing the search panel. */
  const UI_KEYS = new Set(["Escape", "Enter", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Tab"]);
  function editorUiWants(v: EditorView, stroke: string): boolean {
    if (!UI_KEYS.has(stroke)) return false;
    return completionStatus(v.state) !== null || (stroke === "Escape" && searchPanelOpen(v.state));
  }
  document.addEventListener("keydown", (e) => {
    if (keysSuspended || e.isComposing || e.defaultPrevented) return;
    const strokes = eventStrokes(e);
    if (!strokes.length) return;
    const target = e.target as HTMLElement | null;
    const hit = editorAt(target);
    const view = hit && !hit.inPanel ? hit.view : null;
    const inField = !view && !!target?.closest?.("input, textarea, select, [contenteditable]");
    const tries = pending ? strokes.map((s) => `${pending} ${s}`) : strokes;
    for (const k of tries) {
      const id = matcher.get(k);
      if (!id) continue;
      if (!pending && inField && isPlainKey(k)) continue;
      const c = COMMAND_BY_ID.get(id);
      // editor commands only act inside an editor's text; elsewhere the key keeps its normal meaning. In an
      // editor panel (the search field) only the search commands run: Ctrl+A, Ctrl+Z, Escape … are the field's.
      let onView: EditorView | null = null;
      if (c?.kind === "editor") {
        onView = view ?? (hit?.inPanel && c.group === "Search" ? hit.view : null);
        if (!onView) continue;
        if (!pending && editorUiWants(onView, k)) continue;
      }
      clearPending();
      if (runCommand(id, onView)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (pending) {
      clearPending();
      return;
    }
    for (const s of strokes) {
      if (!matcher.isPrefix(s) || (inField && isPlainKey(s))) continue;
      pending = s;
      e.preventDefault();
      e.stopPropagation();
      pendingTimer = setTimeout(clearPending, 2000);
      announce(`${displayBinding(s)} pressed, waiting for the second key`);
      return;
    }
  }, true);

  // --- vim: ex commands + user mappings ---
  Vim.defineEx("write", "w", () => runPreview());
  Vim.defineEx("edit", "e", (_cm: unknown, params: { args?: string[] }) => {
    const a = (params.args?.[0] ?? "").toLowerCase();
    const f = a.startsWith("c") ? "css" : a.startsWith("j") ? "js" : a.startsWith("h") ? "html" : null;
    if (f) selectTab(f, true);
  });
  function applyVimrc(src: string) {
    try {
      Vim.mapclear();
    } catch { /* older API */ }
    const bad: number[] = [];
    src.split("\n").forEach((line, i) => {
      const l = line.trim();
      if (!l || l.startsWith('"')) return;
      const mm = l.match(/^(n|i|v|x)?(nore)?map\s+(\S+)\s+(.+)$/);
      if (!mm) return bad.push(i + 1);
      const ctx = mm[1] === "n" ? "normal" : mm[1] === "i" ? "insert" : mm[1] ? "visual" : undefined;
      try {
        if (mm[2]) {
          for (const c of ctx ? [ctx] : ["normal", "visual"]) Vim.noremap(mm[3], mm[4], c);
        } else {
          Vim.map(mm[3], mm[4], ctx as string); // no context = every mode, like :map
        }
      } catch {
        bad.push(i + 1);
      }
    });
    if (bad.length) $("kb-status").textContent = `Vim mappings: line ${bad.join(", ")} not understood.`;
  }
  applyVimrc(settings.get().vimrc);

  // --- palette contents ---
  function keysOf(id: string): string {
    return (bindings[id] ?? []).map((k) => {
      try {
        return displayBinding(k);
      } catch {
        return k;
      }
    }).join("  ");
  }
  function paletteItems(): PaletteItem[] {
    const s = settings.get();
    return [
      ...ALL_COMMANDS.map((c) => ({
        id: c.id,
        label: c.label,
        group: c.group,
        keys: keysOf(c.id),
        run: () => {
          if (c.kind === "editor") editors[current].focus();
          runCommand(c.id, editors[current].view);
        },
      })),
      ...THEME_CHOICES.map((t) => ({
        id: `theme:${t.id}`,
        label: `${t.label}${s.theme === t.id ? " (current)" : ""}`,
        group: "Theme",
        run: () => {
          settings.update({ theme: t.id });
          announce(`Theme: ${t.label}`);
        },
      })),
      ...PRESETS.map((p) => ({
        id: `keymap:${p.id}`,
        label: `${p.label}${s.keymap === p.id ? " (current)" : ""}`,
        group: "Keymap",
        run: () => {
          settings.update({ keymap: p.id });
          announce(`Keymap: ${p.label}`);
        },
      })),
    ];
  }

  function renderHelp() {
    const s = settings.get();
    const groups = new Map<string, HTMLElement[]>();
    for (const c of ALL_COMMANDS) {
      const k = keysOf(c.id);
      if (!k) continue;
      const list = groups.get(c.group) ?? [];
      list.push(h("dt", { text: k }), h("dd", { text: c.label }));
      groups.set(c.group, list);
    }
    const preset = PRESETS.find((p) => p.id === s.keymap)!;
    $("help-list").replaceChildren(
      h(
        "p",
        {},
        `Keymap: ${preset.label}. `,
        preset.ext ? `${preset.label} keys work inside the editor as usual. ` : "",
        "Change any shortcut in Settings → Keyboard.",
      ),
      ...[...groups].flatMap(([g, items]) => [h("h3", { text: g }), h("dl", {}, ...items)]),
    );
  }

  // --- status bar: one click to switch keymap / theme / indent (JetBrains-style widgets) ---
  $("sb-keymap").addEventListener("click", () => palette.open("keymap "));
  $("sb-theme").addEventListener("click", () => palette.open("theme "));
  $("sb-indent").addEventListener("click", () => dialog.open("editor"));
  function renderStatusBar(s: Settings) {
    const preset = PRESETS.find((p) => p.id === s.keymap)!;
    const theme = THEME_CHOICES.find((t) => t.id === s.theme);
    const resolved = THEMES.find((t) => t.id === document.documentElement.dataset.theme);
    $("sb-keymap").textContent = `Keymap: ${preset.label.replace(/ \(.*\)$/, "")}`;
    $("sb-keymap").setAttribute("aria-label", `Keymap ${preset.label}: switch keymap`);
    $("sb-theme").textContent = s.theme === "system"
      ? `Theme: System (${resolved?.label ?? ""})`
      : `Theme: ${theme?.label}`;
    $("sb-theme").setAttribute("aria-label", `${$("sb-theme").textContent}: switch theme`);
    $("sb-indent").textContent = `${s.tabSize} spaces`;
    $("sb-indent").setAttribute("aria-label", `Indent ${s.tabSize} spaces: open editor settings`);
  }

  // The previewed page gets NO colour-scheme handling of ours: its frame host is `color-scheme: light dark`
  // in app.css, which is exactly what a top-level tab gets (the OS preference reaches the page's
  // prefers-color-scheme, the default canvas when the page declares nothing) and never the editor theme.
  matchMedia("(prefers-color-scheme: dark)").addEventListener(
    "change",
    () => renderStatusBar(settings.get()),
  );

  function labelButtons() {
    const set = (id: string, cmd: string, base: string) => {
      const b = $(id);
      const keys = bindings[cmd] ?? [];
      const aria = ariaShortcut(keys);
      if (aria) b.setAttribute("aria-keyshortcuts", aria);
      else b.removeAttribute("aria-keyshortcuts");
      b.title = keys.length ? `${base} (${keysOf(cmd)})` : base;
    };
    set("run-btn", "run", "Run the preview now");
    set("palette-btn", "palette", "Show all commands");
    set("settings-btn", "settings", "Settings");
    set("help-btn", "help", "Keyboard help");
    const pk = bindings.palette?.[0];
    $("palette-kbd").textContent = pk ? safeKey(pk) : "";
  }

  // --- settings → everything ---
  function safeKey(k: string): string {
    try {
      return displayBinding(k);
    } catch {
      return k;
    }
  }

  function applyAll(s: Settings, prev?: Settings) {
    applyTheme(s);
    applyLayout(s);
    applyPanes(s);
    bindings = effectiveBindings(s.keymap, s.overrides[s.keymap]);
    matcher = makeMatcher(bindings);
    labelButtons();
    renderStatusBar(s);
    if (!prev || prev.keymap !== s.keymap || prev.tabSize !== s.tabSize || prev.lineWrap !== s.lineWrap) {
      for (const f of FILES) editors[f].configure(editorOptions(s));
    }
    if (!prev || prev.name !== s.name || prev.color !== s.color) setUser(s);
    if (prev && prev.vimrc !== s.vimrc) applyVimrc(s.vimrc);
    if (prev && !prev.autoRun && s.autoRun && !previewPaused) preview.render(false);
    if (prev && prev.showErrors !== s.showErrors) {
      if (s.showErrors) preview.render(true); // the script's errors come from running it
      else clearErrors();
    }
    setPreviewStatus();
  }
  settings.subscribe(applyAll);
  applyAll(settings.get());
  renderPeers();

  // test / debugging hook (e2e): read-only state + a way to set a file's content
  Object.assign(globalThis, {
    __livecode: {
      get ready() {
        return hook.ready;
      },
      renders: hook.renders,
      console: hook.console,
      text: (f: FileId) => texts[f].toString(),
      setText: (f: FileId, s: string) =>
        doc.transact(() => {
          texts[f].delete(0, texts[f].length);
          texts[f].insert(0, s);
        }),
      peers: () => awareness.getStates().size,
      theme: () => document.documentElement.dataset.theme,
      keymap: () => settings.get().keymap,
      themes: THEMES.map((t) => t.id),
    },
  });
}
