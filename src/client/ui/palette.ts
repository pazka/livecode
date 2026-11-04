// Command palette: a combobox + listbox in a modal dialog. Commands, themes and keymaps in one list.

import { $, h } from "./dom.ts";

export interface PaletteItem {
  id: string;
  label: string;
  group: string;
  keys?: string;
  run: () => void;
}

/** Subsequence match with a score (consecutive and word-start hits rank higher); null = no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0, ti = 0, prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    score += i === prev + 1 ? 3 : 1;
    if (i === 0 || /[\s:(/-]/.test(t[i - 1])) score += 2;
    prev = i;
    ti = i + 1;
  }
  return score - t.length / 100;
}

export class Palette {
  private readonly dlg = $<HTMLDialogElement>("palette");
  private readonly input = $<HTMLInputElement>("palette-input");
  private readonly list = $<HTMLUListElement>("palette-list");
  private items: PaletteItem[] = [];
  private shown: PaletteItem[] = [];
  private active = 0;
  private returnFocus: HTMLElement | null = null;

  constructor(private readonly source: () => PaletteItem[]) {
    this.input.addEventListener("input", () => this.filter());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.list.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest("li");
      if (li) this.choose(Number(li.dataset.index));
    });
    this.dlg.addEventListener("close", () => {
      const f = this.returnFocus;
      this.returnFocus = null;
      if (f && document.activeElement === document.body) f.focus();
    });
  }

  get isOpen(): boolean {
    return this.dlg.open;
  }

  open(prefill = "") {
    if (this.dlg.open) return;
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.items = this.source();
    this.input.value = prefill;
    this.dlg.showModal();
    this.filter();
    this.input.focus();
  }

  close() {
    if (this.dlg.open) this.dlg.close();
  }

  toggle() {
    if (this.dlg.open) this.close();
    else this.open();
  }

  private filter() {
    const q = this.input.value.trim();
    const scored = this.items
      .map((it) => ({ it, s: fuzzyScore(q, `${it.group}: ${it.label}`) }))
      .filter((x): x is { it: PaletteItem; s: number } => x.s !== null);
    if (q) scored.sort((a, b) => b.s - a.s);
    this.shown = scored.slice(0, 80).map((x) => x.it);
    this.active = 0;
    this.renderList();
  }

  private renderList() {
    this.list.replaceChildren(
      ...this.shown.map((it, i) =>
        h(
          "li",
          {
            id: `pal-${i}`,
            role: "option",
            "aria-selected": i === this.active ? "true" : "false",
            "data-index": i,
          },
          h("span", { class: "label", text: it.label }),
          h("span", { class: "group", text: it.group }),
          it.keys ? h("span", { class: "keys", text: it.keys }) : null,
        )
      ),
    );
    if (this.shown.length === 0) {
      this.list.append(h("li", { role: "option", "aria-disabled": "true", text: "No match" }));
    }
    this.input.setAttribute("aria-activedescendant", this.shown.length ? `pal-${this.active}` : "");
    this.list.querySelector(`#pal-${this.active}`)?.scrollIntoView({ block: "nearest" });
  }

  private onKey(e: KeyboardEvent) {
    const n = this.shown.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      if (!n) return;
      const step = e.key.startsWith("Page") ? 8 : 1;
      const dir = e.key === "ArrowDown" || e.key === "PageDown" ? step : -step;
      this.active = (this.active + dir + n) % n;
      this.renderList();
    } else if (e.key === "Home" && e.ctrlKey) {
      this.active = 0;
      this.renderList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (n) this.choose(this.active);
    }
  }

  private choose(i: number) {
    const it = this.shown[i];
    if (!it) return;
    const f = this.returnFocus;
    this.returnFocus = null;
    this.dlg.close();
    f?.focus();
    it.run();
  }
}
