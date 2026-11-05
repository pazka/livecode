// Settings dialog: profile (name, colour), appearance, editor, keyboard — keymap preset, vim mappings, and the
// shortcut editor (record / add / reset / clear per command, conflicts shown, import / export as JSON).

import { ALL_COMMANDS, type Group } from "../commands.ts";
import { canonical, displayBinding, recordStroke } from "../keys.ts";
import { type Bindings, conflicts, effectiveBindings, PRESET_BY_ID, PRESETS } from "../keymaps.ts";
import type { Settings, SettingsStore } from "../settings.ts";
import { PEER_COLORS, THEME_CHOICES } from "../themes.ts";
import { $, announce, h } from "./dom.ts";

const COLOR_NAMES = [
  "Red",
  "Orange",
  "Ochre",
  "Green",
  "Emerald",
  "Teal",
  "Cyan",
  "Blue",
  "Indigo",
  "Purple",
  "Magenta",
  "Pink",
];

const GROUP_ORDER: Group[] = [
  "Preview",
  "Files",
  "Edit",
  "Selection",
  "Search",
  "Fold",
  "View",
  "Room",
  "Help",
];

export interface KeySuspender {
  /** While recording a shortcut, the app's own key handling must stand aside. */
  suspendKeys(on: boolean): void;
}

export class SettingsDialog {
  private readonly dlg = $<HTMLDialogElement>("settings");
  private readonly tbody = $<HTMLTableElement>("kb-table").tBodies[0];
  private readonly status = $("kb-status");
  private recording: { id: string; add: boolean; strokes: string[]; btn: HTMLButtonElement } | null = null;
  private chordTimer: number | undefined;

  constructor(private readonly store: SettingsStore, private readonly keys: KeySuspender) {
    this.buildStatic();
    store.subscribe(() => this.sync());
    this.sync();
  }

  open(section?: "keyboard" | "profile" | "editor" | "appearance") {
    if (!this.dlg.open) this.dlg.showModal();
    if (section) this.showSection(section === "keyboard" ? "st-keyboard" : `st-${section}`, false);
    if (section === "keyboard") $("kb-filter").focus();
    else if (section === "profile") $("set-name").focus();
    else if (section === "editor") $("set-tab").focus();
    else this.currentTab().focus();
  }

  private readonly tabs = (): HTMLButtonElement[] => [
    ...$("settings-tabs").querySelectorAll<HTMLButtonElement>("[role=tab]"),
  ];

  private currentTab(): HTMLButtonElement {
    return this.tabs().find((t) => t.getAttribute("aria-selected") === "true") ?? this.tabs()[0];
  }

  /** Vertical tabs (Appearance / Editor / Keymap / You): one section shown at a time. */
  private showSection(tabId: string, focus: boolean) {
    for (const t of this.tabs()) {
      const on = t.id === tabId;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")!).hidden = !on;
      if (on && focus) t.focus();
    }
  }

  private buildStatic() {
    const s = this.store;
    const tabsEl = $("settings-tabs");
    this.showSection("st-appearance", false);
    tabsEl.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLButtonElement>("[role=tab]");
      if (t) this.showSection(t.id, true);
    });
    tabsEl.addEventListener("keydown", (e) => {
      const tabs = this.tabs();
      const i = tabs.indexOf(this.currentTab());
      const n = e.key === "ArrowDown" || e.key === "ArrowRight"
        ? (i + 1) % tabs.length
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
        ? (i + tabs.length - 1) % tabs.length
        : e.key === "Home"
        ? 0
        : e.key === "End"
        ? tabs.length - 1
        : -1;
      if (n < 0) return;
      e.preventDefault();
      this.showSection(tabs[n].id, true);
    });
    const theme = $<HTMLSelectElement>("set-theme");
    theme.replaceChildren(...THEME_CHOICES.map((t) => h("option", { value: t.id, text: t.label })));
    theme.addEventListener("change", () => s.update({ theme: theme.value }));

    const km = $<HTMLSelectElement>("set-keymap");
    km.replaceChildren(...PRESETS.map((p) => h("option", { value: p.id, text: p.label })));
    km.addEventListener("change", () => s.update({ keymap: km.value as typeof PRESETS[number]["id"] }));

    const name = $<HTMLInputElement>("set-name");
    name.addEventListener("change", () => s.update({ name: name.value }));

    const sw = $("set-color");
    sw.replaceChildren(...PEER_COLORS.map((c, i) =>
      h("button", {
        type: "button",
        role: "radio",
        "aria-label": COLOR_NAMES[i] ?? c,
        "data-color": c,
        style: `background:${c}`,
      })
    ));
    sw.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-color]");
      if (b) s.update({ color: b.dataset.color! });
    });
    sw.addEventListener("keydown", (e) => {
      const dir = e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? -1
        : 0;
      if (!dir) return;
      e.preventDefault();
      const i = PEER_COLORS.indexOf(s.get().color);
      const next = PEER_COLORS[(i + dir + PEER_COLORS.length) % PEER_COLORS.length];
      s.update({ color: next });
      sw.querySelector<HTMLButtonElement>(`[data-color="${next}"]`)?.focus();
    });

    const num = (id: string, key: "fontSize" | "tabSize" | "previewDelay") => {
      const i = $<HTMLInputElement>(id);
      i.addEventListener("change", () => {
        const patch: Partial<Settings> = {};
        patch[key] = Number(i.value);
        s.update(patch);
      });
    };
    num("set-font", "fontSize");
    num("set-tab", "tabSize");
    num("set-delay", "previewDelay");
    const wrap = $<HTMLInputElement>("set-wrap");
    wrap.addEventListener("change", () => s.update({ lineWrap: wrap.checked }));
    const errs = $<HTMLInputElement>("set-errors");
    errs.addEventListener("change", () => s.update({ showErrors: errs.checked }));
    const layout = $<HTMLSelectElement>("set-layout");
    layout.addEventListener("change", () => s.update({ layout: layout.value as "columns" | "rows" }));
    const paneDir = $<HTMLSelectElement>("set-panedir");
    paneDir.addEventListener("change", () => s.update({ paneDir: paneDir.value as Settings["paneDir"] }));
    const vimrc = $<HTMLTextAreaElement>("set-vimrc");
    vimrc.addEventListener("change", () => s.update({ vimrc: vimrc.value }));

    $<HTMLInputElement>("kb-filter").addEventListener("input", () => this.renderTable());
    $("kb-reset-all").addEventListener("click", () => {
      const p = s.get().keymap;
      if (!confirm(`Reset every shortcut of the ${PRESET_BY_ID.get(p)?.label} keymap to its defaults?`)) {
        return;
      }
      const o = { ...s.get().overrides };
      delete o[p];
      s.update({ overrides: o });
      announce("All shortcuts reset");
    });
    $("kb-export").addEventListener("click", () => {
      const v = s.get();
      const blob = new Blob(
        [JSON.stringify({ livecode: 1, keymap: v.keymap, overrides: v.overrides, vimrc: v.vimrc }, null, 2)],
        { type: "application/json" },
      );
      const a = h("a", { href: URL.createObjectURL(blob), download: "livecode-keys.json" });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    const file = $<HTMLInputElement>("kb-import-file");
    $("kb-import").addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        s.update({ keymap: j.keymap, overrides: j.overrides, vimrc: j.vimrc });
        this.say("Shortcuts imported.");
      } catch {
        this.say("That file is not a livecode shortcuts export.");
      }
    });

    this.tbody.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
      if (!b) return;
      const id = b.dataset.id!;
      const act = b.dataset.act;
      if (act === "change" || act === "add") this.startRecording(id, act === "add", b);
      else if (act === "reset") this.setOverride(id, undefined);
      else if (act === "clear") this.setOverride(id, []);
    });
    this.dlg.addEventListener("close", () => this.stopRecording(false));
  }

  private say(msg: string) {
    this.status.textContent = msg;
  }

  private sync() {
    const v = this.store.get();
    const set = (id: string, val: string) => {
      const e = $<HTMLInputElement>(id);
      if (document.activeElement !== e) e.value = val;
    };
    set("set-name", v.name);
    set("set-theme", v.theme);
    set("set-keymap", v.keymap);
    set("set-font", String(v.fontSize));
    set("set-tab", String(v.tabSize));
    set("set-delay", String(v.previewDelay));
    set("set-layout", v.layout);
    set("set-panedir", v.paneDir);
    set("set-vimrc", v.vimrc);
    $<HTMLInputElement>("set-wrap").checked = v.lineWrap;
    $<HTMLInputElement>("set-errors").checked = v.showErrors;
    $("vimrc-field").hidden = v.keymap !== "vim";
    for (const b of $("set-color").querySelectorAll<HTMLButtonElement>("[data-color]")) {
      const on = b.dataset.color === v.color;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    this.renderTable();
  }

  private setOverride(id: string, keys: string[] | undefined) {
    const v = this.store.get();
    const mine: Bindings = { ...(v.overrides[v.keymap] ?? {}) };
    if (keys === undefined) delete mine[id];
    else mine[id] = keys;
    this.store.update({ overrides: { ...v.overrides, [v.keymap]: mine } });
    const label = ALL_COMMANDS.find((c) => c.id === id)?.label ?? id;
    this.say(
      keys === undefined
        ? `${label}: back to the default`
        : keys.length
        ? `${label}: ${keys.map((k) => displayBinding(k)).join(", ")}`
        : `${label}: no shortcut`,
    );
  }

  private renderTable() {
    const v = this.store.get();
    const b = effectiveBindings(v.keymap, v.overrides[v.keymap]);
    const mine = v.overrides[v.keymap] ?? {};
    const clash = conflicts(b);
    const clashOf = (id: string) => {
      const others = new Set<string>();
      for (const k of b[id] ?? []) {
        let c: string;
        try {
          c = canonical(k);
        } catch {
          continue;
        }
        for (const [key, ids] of clash) {
          if (key === c || key === c.split(" ")[0] || c === key.split(" ")[0]) {
            for (const o of ids) if (o !== id) others.add(o);
          }
        }
      }
      return [...others].map((o) => ALL_COMMANDS.find((x) => x.id === o)?.label ?? o);
    };
    const q = $<HTMLInputElement>("kb-filter").value.trim().toLowerCase();
    const rows = [...ALL_COMMANDS]
      .sort((a, c) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(c.group))
      .filter((c) => {
        if (!q) return true;
        const keys = (b[c.id] ?? []).map((k) => displayBinding(k)).join(" ").toLowerCase();
        return `${c.label} ${c.group} ${keys}`.toLowerCase().includes(q);
      })
      .map((c) => {
        const keys = b[c.id] ?? [];
        const changed = c.id in mine;
        const others = clashOf(c.id);
        return h(
          "tr",
          { class: changed ? "changed" : undefined },
          h("th", { scope: "row" }, c.label, h("span", { class: "group", text: c.group })),
          h(
            "td",
            {},
            h(
              "span",
              { class: "keys" },
              ...(keys.length
                ? keys.map((k) => h("kbd", { text: safeDisplay(k) }))
                : [h("span", { class: "none", text: "none" })]),
            ),
            others.length
              ? h("span", { class: "conflict", text: `Also used by: ${others.join(", ")}` })
              : null,
          ),
          h(
            "td",
            { class: "actions" },
            h("button", {
              type: "button",
              "data-act": "change",
              "data-id": c.id,
              "aria-label": `Change the shortcut of ${c.label}`,
              text: "Change",
            }),
            h("button", {
              type: "button",
              "data-act": "add",
              "data-id": c.id,
              "aria-label": `Add a shortcut to ${c.label}`,
              text: "Add",
            }),
            keys.length
              ? h("button", {
                type: "button",
                "data-act": "clear",
                "data-id": c.id,
                "aria-label": `Remove the shortcuts of ${c.label}`,
                text: "Clear",
              })
              : null,
            changed
              ? h("button", {
                type: "button",
                "data-act": "reset",
                "data-id": c.id,
                "aria-label": `Reset ${c.label} to the default`,
                text: "Reset",
              })
              : null,
          ),
        );
      });
    // keep focus on the same button across re-renders
    const f = document.activeElement as HTMLElement | null;
    const key = f?.dataset?.act && f.dataset.id
      ? `[data-act="${f.dataset.act}"][data-id="${f.dataset.id}"]`
      : null;
    this.tbody.replaceChildren(...rows);
    if (key && f && this.dlg.contains(f) && !this.tbody.contains(f)) {
      const again = this.tbody.querySelector<HTMLElement>(key) ??
        this.tbody.querySelector<HTMLElement>(`[data-act="change"][data-id="${f.dataset.id}"]`);
      again?.focus();
    }
  }

  private startRecording(id: string, add: boolean, btn: HTMLButtonElement) {
    this.stopRecording(false);
    this.keys.suspendKeys(true);
    this.recording = { id, add, strokes: [], btn };
    btn.classList.add("recording");
    btn.textContent = "Press keys…";
    const label = ALL_COMMANDS.find((c) => c.id === id)?.label ?? id;
    this.say(`Recording a shortcut for ${label}: press the keys. Escape cancels, Backspace removes it.`);
    addEventListener("keydown", this.onRecordKey, true);
  }

  private readonly onRecordKey = (e: KeyboardEvent) => {
    const r = this.recording;
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (r.strokes.length === 0 && plain && e.key === "Escape") return this.stopRecording(false);
    if (r.strokes.length === 0 && plain && e.key === "Backspace") {
      const id = r.id;
      this.stopRecording(false);
      return this.setOverride(id, []);
    }
    const s = recordStroke(e);
    if (!s) return;
    r.strokes.push(s);
    r.btn.textContent = r.strokes.map((x) => displayBinding(x)).join(" ") + " …";
    clearTimeout(this.chordTimer);
    if (r.strokes.length >= 2) return this.stopRecording(true);
    // a second stroke within a second makes a chord (Ctrl+K Ctrl+S)
    this.chordTimer = setTimeout(() => this.stopRecording(true), 1000);
  };

  private stopRecording(commit: boolean) {
    clearTimeout(this.chordTimer);
    removeEventListener("keydown", this.onRecordKey, true);
    const r = this.recording;
    this.recording = null;
    this.keys.suspendKeys(false);
    if (!r) return;
    r.btn.classList.remove("recording");
    if (!commit || r.strokes.length === 0) {
      this.renderTable();
      this.say("Recording cancelled.");
      return;
    }
    const binding = r.strokes.join(" ");
    const v = this.store.get();
    const current = effectiveBindings(v.keymap, v.overrides[v.keymap])[r.id] ?? [];
    const next = r.add ? [...current.filter((k) => safeCanon(k) !== safeCanon(binding)), binding] : [binding];
    this.setOverride(r.id, next.slice(-4));
  }
}

function safeCanon(k: string): string {
  try {
    return canonical(k);
  } catch {
    return k;
  }
}

function safeDisplay(k: string): string {
  try {
    return displayBinding(k);
  } catch {
    return k;
  }
}
