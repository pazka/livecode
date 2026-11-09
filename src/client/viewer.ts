// The preview screen (/r/<room>/view, owner 2026-11-09: "open the live preview in another tab so that I can
// put it on another screen in fullscreen"): only the room's page, full window, live. It joins the room by
// itself (works without an editor tab open, follows everyone's edits) with the same refresh delay as the
// person's editor (their settings) and runs again when Run is pressed in one of their editor tabs.
// In the people list it is an eye next to its owner's name: never a person, a cursor or a file dot.

import * as Y from "yjs";
import { type FileId, FILES, type Notice } from "../shared/protocol.ts";
import { buildPage, isViewer, previewChannel, type PreviewMessage, type ViewerState } from "./page.ts";
import { Preview, previousRunFroze } from "./preview.ts";
import { RoomProvider, type Status } from "./provider.ts";
import type { SettingsStore } from "./settings.ts";
import { $, announce } from "./ui/dom.ts";

export function startViewer(roomId: string, settings: SettingsStore) {
  $("viewer").hidden = false;
  document.title = `${roomId} — preview — livecode`;
  document.documentElement.classList.add("viewing");
  $<HTMLAnchorElement>("viewer-editor").href = `/r/${roomId}`;
  $("viewer-room").textContent = roomId;

  const doc = new Y.Doc();
  const texts = Object.fromEntries(FILES.map((f) => [f, doc.getText(f)])) as Record<FileId, Y.Text>;
  const meta = doc.getMap<unknown>("meta");
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${roomId}`;
  let paused = previousRunFroze() || new URLSearchParams(location.search).has("norun");
  let ready = false;
  let renders = 0;
  const statusEl = $("viewer-status");

  const preview = new Preview($("viewer-frames"), () => buildPage(texts, meta), {
    console: () => {}, // the console is in the editor
    rendered: () => {
      renders++;
      showStatus();
    },
  });

  const provider = new RoomProvider(wsUrl, doc, {
    status: (s) => showStatus(s),
    synced: () => {
      ready = true;
      if (!paused) preview.render(true);
      showStatus();
    },
    notice: (n: Notice) => {
      const b = $("banner-viewer");
      b.hidden = false;
      b.textContent = n.message;
    },
  });

  // presence: a viewer, so the room shows an eye next to its owner's name instead of one more person
  const presence = (): ViewerState => {
    const s = settings.get();
    return { viewer: true, user: { name: s.name, color: s.color } };
  };
  provider.awareness.setLocalState(presence());
  settings.subscribe((s, prev) => {
    if (!prev || prev.name !== s.name || prev.color !== s.color) provider.awareness.setLocalState(presence());
  });

  doc.on("update", () => {
    const s = settings.get();
    if (ready && s.autoRun && !paused) preview.schedule(s.previewDelay);
  });

  function run() {
    paused = false;
    preview.render(true);
    showStatus();
  }
  // Run in one of the person's editor tabs (same browser) runs this screen too
  previewChannel()?.addEventListener("message", (e: MessageEvent<PreviewMessage>) => {
    if (e.data?.room === roomId && e.data.type === "run") run();
  });
  $("viewer-run").addEventListener("click", run);

  function showStatus(s: Status = provider.status) {
    statusEl.dataset.state = s;
    const people = [...provider.awareness.getStates().values()].filter((st) => !isViewer(st)).length;
    statusEl.textContent = s !== "online"
      ? (s === "connecting" ? "Connecting…" : "Offline — reconnecting")
      : paused
      ? "Paused — press Run"
      : `Live · ${people} ${people === 1 ? "person" : "people"} editing${renders ? "" : " · loading"}`;
  }
  provider.awareness.on("change", () => showStatus());

  // fullscreen (the screen's own button; Escape leaves it, as everywhere)
  const fsBtn = $<HTMLButtonElement>("viewer-fullscreen");
  const canFullscreen = !!document.documentElement.requestFullscreen;
  fsBtn.hidden = !canFullscreen;
  fsBtn.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => announce("Fullscreen is not allowed here"));
  });
  document.addEventListener("fullscreenchange", () => {
    const on = !!document.fullscreenElement;
    fsBtn.setAttribute("aria-pressed", String(on));
    fsBtn.setAttribute("aria-label", on ? "Leave fullscreen" : "Fullscreen");
    fsBtn.title = on ? "Leave fullscreen (Esc)" : "Fullscreen";
    document.documentElement.classList.toggle("fullscreen", on);
  });

  // the bar shows for a moment, then fades away until the mouse comes over it or it gets focus
  const bar = $("viewer-bar");
  let fade: number | undefined;
  const wake = () => {
    bar.classList.add("awake");
    clearTimeout(fade);
    fade = setTimeout(() => bar.classList.remove("awake"), 2500);
  };
  wake();
  addEventListener("mousemove", wake); // over the bar itself (the page's own frame keeps its events)
  bar.addEventListener("focusin", wake);

  Object.assign(globalThis, {
    __livecode: {
      get ready() {
        return ready;
      },
      viewer: true,
      renders: () => renders,
      peers: () => [...provider.awareness.getStates().values()].filter((st) => !isViewer(st)).length,
    },
  });
}
