// Key names. Bindings are written in CodeMirror's notation ("Mod-Shift-p", chords "Mod-k Mod-0"), where
// Mod = Cmd on macOS and Ctrl elsewhere. This module turns them into one canonical form (to compare and
// detect conflicts), reads them from keyboard events the way CodeMirror does, and displays them.

export const IS_MAC: boolean = (() => {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  return /Mac|iPhone|iPad|iPod/.test(nav?.platform ?? nav?.userAgent ?? "");
})();

const ALIASES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  space: "Space",
  " ": "Space",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
};

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Fn"]);

function normKey(k: string): string {
  if ([...k].length === 1) return k === " " ? "Space" : k;
  const a = ALIASES[k.toLowerCase()];
  if (a) return a;
  if (/^f\d{1,2}$/i.test(k)) return k.toUpperCase();
  return k;
}

/** "Mod-Shift-p" → "Ctrl-Shift-p" (or "Meta-Shift-p" on mac), modifiers in a fixed order. */
export function canonicalStroke(stroke: string, mac = IS_MAC): string {
  const parts = stroke.split(/-(?!$)/);
  let key = parts.pop() ?? "";
  let alt = false, ctrl = false, shift = false, meta = false;
  for (const p of parts) {
    const m = p.toLowerCase();
    if (m === "alt" || m === "a" || m === "option") alt = true;
    else if (m === "ctrl" || m === "control" || m === "c") ctrl = true;
    else if (m === "shift" || m === "s") shift = true;
    else if (m === "meta" || m === "cmd" || m === "m") meta = true;
    else if (m === "mod") mac ? (meta = true) : (ctrl = true);
    else throw new Error(`unknown modifier "${p}" in "${stroke}"`);
  }
  key = normKey(key);
  if (!key) throw new Error(`no key in "${stroke}"`);
  // "Ctrl-P" (CodeMirror: the char P, Shift folded in) is the same key as "Ctrl-Shift-p"
  if (/^[A-Z]$/.test(key)) {
    shift = true;
    key = key.toLowerCase();
  }
  return `${alt ? "Alt-" : ""}${ctrl ? "Ctrl-" : ""}${meta ? "Meta-" : ""}${shift ? "Shift-" : ""}${key}`;
}

/** A whole binding (one or more space-separated strokes) in canonical form. */
export function canonical(binding: string, mac = IS_MAC): string {
  return binding.trim().split(/\s+/).map((s) => canonicalStroke(s, mac)).join(" ");
}

export function isValidBinding(binding: string): boolean {
  try {
    return canonical(binding).length > 0;
  } catch {
    return false;
  }
}

const CODE_KEYS: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Space: "Space",
};

/** The physical (US-layout) key of an event: what CodeMirror falls back to when a modifier changed the char. */
function baseKey(code: string): string | null {
  const m = code.match(/^Key([A-Z])$/) ?? code.match(/^Digit(\d)$/) ?? code.match(/^Numpad(\d)$/);
  if (m) return m[1].toLowerCase();
  return CODE_KEYS[code] ?? null;
}

interface KeyEventLike {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  getModifierState?: (key: string) => boolean;
}

function withMods(key: string, e: KeyEventLike, shift: boolean): string {
  const raw = `${e.altKey ? "Alt-" : ""}${e.ctrlKey ? "Ctrl-" : ""}${e.metaKey ? "Meta-" : ""}${
    shift && e.shiftKey ? "Shift-" : ""
  }${normKey(key)}`;
  try {
    return canonicalStroke(raw);
  } catch {
    return raw;
  }
}

/**
 * Canonical names an event can match, most specific first — the same two tries as CodeMirror's keymap:
 * the produced character (Shift folded into it), then the physical key with every modifier.
 */
export function eventStrokes(e: KeyEventLike, mac = IS_MAC): string[] {
  if (MODIFIER_KEYS.has(e.key)) return [];
  const isChar = [...e.key].length === 1 && e.key !== " ";
  // AltGr typed a character (Windows reports AltGr as Ctrl+Alt): that is text — "ł", "[", "@" … — never a
  // shortcut (CodeMirror does the same)
  if (isChar && e.getModifierState?.("AltGraph")) return [];
  // macOS has no AltGr: Option is how a layout types its characters (French ⌥⇧5 = "[", ⌥⇧) = "]", ⌥5 = "{",
  // ⌥⇧L = "|", ⌥N = "~"; French-PC ⌥2 = "~" …). A printable ASCII character typed with Option (no ⌘ / ⌃) is
  // what the person meant to type: text, never a shortcut (owner, 2026-11-09: "[" switched the file). Option
  // characters no code needs ("¡", "“", "∆" on a US Mac) still fall back to the physical key: ⌥1 = Alt-1.
  if (mac && isChar && e.altKey && !e.ctrlKey && !e.metaKey && /^[\x21-\x7e]$/.test(e.key)) return [];
  const out = [withMods(e.key, e, !isChar)];
  const base = baseKey(e.code);
  // the layout's own letters win: AZERTY Ctrl+Q is Ctrl-q, never the physical key's Ctrl-a. The physical
  // key is only a fallback when a modifier changed the character (macOS ⌥1 = "¡", AZERTY digits, Cyrillic)
  const layoutLetter = /^[a-z]$/i.test(e.key);
  if (
    base && !layoutLetter && (isChar || e.key === " ") && (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey)
  ) {
    const b = withMods(base, e, true);
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

/** The binding to store when the user presses keys in the shortcut recorder (null for a lone modifier). */
export function recordStroke(e: KeyEventLike, mac = IS_MAC): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const isChar = [...e.key].length === 1;
  const hasMod = e.ctrlKey || e.metaKey || e.altKey;
  const base = baseKey(e.code);
  // a modifier changed the character (Alt-1 on macOS types "¡", Shift-p types "P"): store the physical key
  const key = isChar && (hasMod || e.shiftKey) && base ? base : e.key;
  const shift = e.shiftKey && (!isChar || key !== e.key);
  const mod = mac ? e.metaKey : e.ctrlKey;
  const parts = [
    mod ? "Mod" : null,
    mac && e.ctrlKey ? "Ctrl" : null,
    !mac && e.metaKey ? "Meta" : null,
    e.altKey ? "Alt" : null,
    shift ? "Shift" : null,
  ].filter(Boolean);
  return [...parts, normKey(key)].join("-");
}

const DISPLAY_ORDER = ["Ctrl", "Alt", "Shift", "Meta"]; // ⌃⌥⇧⌘ on macOS, Ctrl+Alt+Shift elsewhere
const MAC_SYMBOLS: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };
const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Space: "Space",
  Backspace: "⌫",
  Delete: "Del",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

/** Human label: "Ctrl+Shift+P", "⌘⇧P", chords joined with a space. */
export function displayBinding(binding: string, mac = IS_MAC): string {
  return canonical(binding, mac).split(" ").map((stroke) => {
    const parts = stroke.split(/-(?!$)/);
    const key = parts.pop()!;
    parts.sort((a, b) => DISPLAY_ORDER.indexOf(a) - DISPLAY_ORDER.indexOf(b));
    const k = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
    if (mac) return parts.map((p) => MAC_SYMBOLS[p] ?? p).join("") + k;
    return [...parts.map((p) => (p === "Meta" ? "Win" : p)), k].join("+");
  }).join(" ");
}

/** aria-keyshortcuts value (first stroke of each binding, WAI-ARIA names). */
export function ariaShortcut(bindings: string[], mac = IS_MAC): string {
  return bindings.filter((b) => !b.includes(" ")).map((b) => {
    const parts = canonical(b, mac).split(/-(?!$)/);
    const key = parts.pop()!;
    const names = parts.map((p) => (p === "Ctrl" ? "Control" : p));
    return [...names, key === "Space" ? "Space" : key.length === 1 ? key.toUpperCase() : key].join("+");
  }).join(" ");
}

// ---------- mouse ----------

/** Mouse modifiers of a gesture (multiple cursors): "Mod" = Cmd on macOS, Ctrl elsewhere. */
export type MouseMods = "Alt" | "Alt-Shift" | "Mod";

/** True when a mouse event carries exactly these modifiers. */
export function mouseMods(
  e: Pick<MouseEvent, "altKey" | "shiftKey" | "ctrlKey" | "metaKey">,
  m: MouseMods,
  mac = IS_MAC,
): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (m === "Mod") return mod && !e.altKey && !e.shiftKey;
  return e.altKey && !mod && e.shiftKey === (m === "Alt-Shift");
}

/** "Alt+Click", "⌥⇧Click", "Ctrl+Drag" … */
export function displayMouse(m: MouseMods, action: "Click" | "Drag", mac = IS_MAC): string {
  const mods = m === "Mod" ? ["Meta"] : m === "Alt" ? ["Alt"] : ["Alt", "Shift"];
  if (mac) return mods.map((x) => MAC_SYMBOLS[x]).join("") + action;
  return [...mods.map((x) => (x === "Meta" ? "Ctrl" : x)), action].join("+");
}
