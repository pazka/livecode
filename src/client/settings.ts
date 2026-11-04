// Per-person settings, kept in this browser only (localStorage). Nothing here is shared with the room except
// the name and colour, which travel in the awareness state.

import { type Bindings, isPresetId, type PresetId } from "./keymaps.ts";
import { isThemeChoice, PEER_COLORS } from "./themes.ts";

export interface Settings {
  name: string;
  color: string;
  theme: string;
  keymap: PresetId;
  /** User overrides per preset: command id → keys (an empty list unbinds). */
  overrides: Partial<Record<PresetId, Bindings>>;
  /** Vim mappings, one per line: `imap jk <Esc>`, `nnoremap H ^` … */
  vimrc: string;
  fontSize: number;
  tabSize: number;
  lineWrap: boolean;
  autoRun: boolean;
  /** Debounce of the live preview after the last edit (ms). */
  previewDelay: number;
  layout: "columns" | "rows";
  /** Editor share of the workspace, percent. */
  split: number;
  consoleOpen: boolean;
}

const KEY = "livecode.settings.v1";

const ANIMALS = [
  "Otter",
  "Heron",
  "Lynx",
  "Badger",
  "Gecko",
  "Puffin",
  "Ibex",
  "Marten",
  "Narwhal",
  "Quokka",
  "Tapir",
  "Wombat",
  "Fennec",
  "Kestrel",
  "Okapi",
  "Pika",
];

export function randomName(): string {
  const r = crypto.getRandomValues(new Uint8Array(2));
  return `${ANIMALS[r[0] % ANIMALS.length]} ${10 + (r[1] % 90)}`;
}

export function defaults(): Settings {
  return {
    name: randomName(),
    color: PEER_COLORS[crypto.getRandomValues(new Uint8Array(1))[0] % PEER_COLORS.length],
    theme: "system",
    keymap: "vscode",
    overrides: {},
    vimrc: "",
    fontSize: 14,
    tabSize: 2,
    lineWrap: false,
    autoRun: true,
    previewDelay: 600,
    layout: "columns",
    split: 50,
    consoleOpen: false,
  };
}

const num = (v: unknown, lo: number, hi: number, def: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : def;

/** Anything read back from storage (or an imported file) is validated field by field. */
export function sanitize(raw: unknown, base: Settings = defaults()): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const overrides: Partial<Record<PresetId, Bindings>> = {};
  if (r.overrides && typeof r.overrides === "object") {
    for (const [p, b] of Object.entries(r.overrides as Record<string, unknown>)) {
      if (!isPresetId(p) || !b || typeof b !== "object") continue;
      const clean: Bindings = {};
      for (const [id, keys] of Object.entries(b as Record<string, unknown>)) {
        if (Array.isArray(keys) && keys.every((k) => typeof k === "string" && k.length < 64)) {
          clean[id] = keys.slice(0, 4);
        }
      }
      overrides[p] = clean;
    }
  }
  return {
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 32) : base.name,
    color: typeof r.color === "string" && PEER_COLORS.includes(r.color) ? r.color : base.color,
    theme: isThemeChoice(r.theme) ? r.theme : base.theme,
    keymap: isPresetId(r.keymap) ? r.keymap : base.keymap,
    overrides,
    vimrc: typeof r.vimrc === "string" ? r.vimrc.slice(0, 4000) : base.vimrc,
    fontSize: num(r.fontSize, 10, 32, base.fontSize),
    tabSize: num(r.tabSize, 1, 8, base.tabSize),
    lineWrap: typeof r.lineWrap === "boolean" ? r.lineWrap : base.lineWrap,
    autoRun: typeof r.autoRun === "boolean" ? r.autoRun : base.autoRun,
    previewDelay: num(r.previewDelay, 100, 5000, base.previewDelay),
    layout: r.layout === "rows" || r.layout === "columns" ? r.layout : base.layout,
    split: num(r.split, 15, 85, base.split),
    consoleOpen: typeof r.consoleOpen === "boolean" ? r.consoleOpen : base.consoleOpen,
  };
}

type Listener = (s: Settings, prev: Settings) => void;

export class SettingsStore {
  private value: Settings;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: Storage | null = globalThis.localStorage ?? null) {
    let raw: unknown = null;
    try {
      raw = JSON.parse(this.storage?.getItem(KEY) ?? "null");
    } catch { /* corrupt: defaults */ }
    this.value = sanitize(raw);
    this.persist();
    globalThis.addEventListener?.("storage", (e: StorageEvent) => {
      if (e.key !== KEY || !e.newValue) return;
      try {
        this.apply(sanitize(JSON.parse(e.newValue), this.value), false); // another tab changed them
      } catch { /* ignore */ }
    });
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings>) {
    this.apply(sanitize({ ...this.value, ...patch }, this.value), true);
  }

  replace(all: unknown) {
    this.apply(sanitize(all, this.value), true);
  }

  private apply(next: Settings, save: boolean) {
    const prev = this.value;
    this.value = next;
    if (save) this.persist();
    for (const l of this.listeners) l(next, prev);
  }

  private persist() {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.value));
    } catch { /* private mode / quota: settings stay for this visit */ }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
