// Small DOM helpers (no framework).

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") e.className = String(v);
    else if (k === "text") e.textContent = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing from index.html`);
  return e as T;
}

let liveTimer: number | undefined;

/** Polite screen-reader announcement (the #live region). */
export function announce(msg: string) {
  const live = document.getElementById("live");
  if (!live) return;
  clearTimeout(liveTimer);
  live.textContent = "";
  // re-set after a tick so the same message twice is announced twice
  liveTimer = setTimeout(() => (live.textContent = msg), 50);
}
