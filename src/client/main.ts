// livecode front-end: landing page (/) or a room (/r/<id>): three shared editors, live preview, presence,
// themes, keymaps, command palette, settings. See BRIEF.md for the feature list.

import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { Vim } from "@replit/codemirror-vim";
import { type FileId, FILES, isRoomId, type Notice } from "../shared/protocol.ts";
import { ALL_COMMANDS, APP_COMMANDS, COMMAND_BY_ID } from "./commands.ts";
import { composeDocument } from "./compose.ts";
import { FILE_LABELS, SharedEditor } from "./editors.ts";
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
      ? `Live · ${n} ${n === 1 ? "person" : "people"}`
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
  let current: FileId = "html";
  const editors = Object.fromEntries(FILES.map((f) => [
    f,
    new SharedEditor(f, $(`panel-${f}`), texts[f], awareness, editorOptions(settings.get()), onFileLimit),
  ])) as Record<FileId, SharedEditor>;

  let limitNoticeAt = 0;
  function onFileLimit(f: FileId) {
    if (Date.now() - limitNoticeAt < 3000) return;
    limitNoticeAt = Date.now();
    showNotice({
      code: "file-too-large",
      message: `${FILE_LABELS[f]} is at its size limit (${MAX_FILE_CHARS / 1024} K characters): that edit was not applied.`,
    });
  }

  function editorOptions(s: Settings) {
    return { keymap: s.keymap, tabSize: s.tabSize, lineWrap: s.lineWrap };
  }

  const tabs = FILES.map((f) => $<HTMLButtonElement>(`tab-${f}`));
  function selectTab(f: FileId, focusEditor: boolean) {
    current = f;
    for (const t of tabs) {
      const on = t.dataset.file === f;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(`panel-${t.dataset.file}`).hidden = !on;
    }
    $("module-toggle").hidden = f !== "js";
    editors[f].view.requestMeasure();
    awareness.setLocalStateField("file", f);
    if (focusEditor) editors[f].focus();
  }
  $("tabs").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>("[role=tab]");
    if (t) selectTab(t.dataset.file as FileId, false);
  });
  $("tabs").addEventListener("keydown", (e) => {
    const i = FILES.indexOf(current);
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
    selectTab(FILES[next], false);
    tabs[next].focus();
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
    rendered: () => {
      renders++;
      lastRenderAt = Date.now();
      setPreviewStatus();
    },
  });
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
  function renderPeers() {
    const states = awareness.getStates();
    const me = doc.clientID;
    const items: HTMLElement[] = [];
    const dots: Record<FileId, HTMLElement[]> = { html: [], css: [], js: [] };
    const entries = [...states.entries()].sort(([a], [b]) => (a === me ? -1 : b === me ? 1 : a - b));
    for (const [id, st] of entries) {
      const u = st.user as { name?: string; color?: string } | undefined;
      if (!u?.name) continue;
      names.set(id, u.name);
      const f = (FILES as readonly string[]).includes(st.file) ? st.file as FileId : "html";
      const self = id === me;
      if (!self) dots[f].push(h("i", { style: `background:${u.color}` }));
      items.push(h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            "data-client": id,
            "aria-label": `${u.name}${self ? " (you)" : ""}, in ${FILE_LABELS[f]}${
              self ? ": open your settings" : ": show their cursor"
            }`,
          },
          h("span", { class: "swatch", style: `background:${u.color}`, "aria-hidden": "true" }),
          `${u.name}${self ? " (you)" : ""}`,
          h("span", { class: "where", "aria-hidden": "true", text: ` · ${f.toUpperCase()}` }),
        ),
      ));
    }
    peersEl.replaceChildren(...items);
    for (const t of tabs) {
      const f = t.dataset.file as FileId;
      t.querySelector(".dots")!.replaceChildren(...dots[f]);
      const n = dots[f].length;
      t.setAttribute(
        "aria-label",
        `${FILE_LABELS[f]}${n ? `, ${n} ${n === 1 ? "person" : "people"} here` : ""}`,
      );
    }
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
    awareness.setLocalStateField("user", { name: s.name, color: s.color, colorLight: `${s.color}33` });
  }
  setUser(settings.get());
  selectTab("html", false);

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
    nextTab: () => selectTab(FILES[(FILES.indexOf(current) + 1) % FILES.length], true),
    prevTab: () => selectTab(FILES[(FILES.indexOf(current) + FILES.length - 1) % FILES.length], true),
    focusEditor: () => editors[current].focus(),
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
        () => announce("Room link copied"),
        () => announce("Copy failed: the link is in the address bar"),
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
  function focusedEditor(target: EventTarget | null): EditorView | null {
    for (const f of FILES) {
      const v = editors[f].view;
      if (target instanceof Node && v.dom.contains(target)) return v;
    }
    return null;
  }
  document.addEventListener("keydown", (e) => {
    if (keysSuspended || e.isComposing || e.defaultPrevented) return;
    const strokes = eventStrokes(e);
    if (!strokes.length) return;
    const target = e.target as HTMLElement | null;
    const view = focusedEditor(target);
    const inField = !view && !!target?.closest?.("input, textarea, select, [contenteditable]");
    const tries = pending ? strokes.map((s) => `${pending} ${s}`) : strokes;
    for (const k of tries) {
      const id = matcher.get(k);
      if (!id) continue;
      if (!pending && inField && isPlainKey(k)) continue;
      const c = COMMAND_BY_ID.get(id);
      // editor commands only act inside an editor; elsewhere the key keeps its normal meaning
      if (c?.kind === "editor" && !view) continue;
      clearPending();
      if (runCommand(id, view)) {
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
  }

  // --- settings → everything ---
  function applyAll(s: Settings, prev?: Settings) {
    applyTheme(s);
    applyLayout(s);
    bindings = effectiveBindings(s.keymap, s.overrides[s.keymap]);
    matcher = makeMatcher(bindings);
    labelButtons();
    if (!prev || prev.keymap !== s.keymap || prev.tabSize !== s.tabSize || prev.lineWrap !== s.lineWrap) {
      for (const f of FILES) editors[f].configure(editorOptions(s));
    }
    if (!prev || prev.name !== s.name || prev.color !== s.color) setUser(s);
    if (prev && prev.vimrc !== s.vimrc) applyVimrc(s.vimrc);
    if (prev && !prev.autoRun && s.autoRun && !previewPaused) preview.render(false);
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
