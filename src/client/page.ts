// The page the preview shows, from a room's shared files: the three files as they are, or with the TypeScript
// turned into JavaScript first (worker). Used by the editor's preview and by the preview screen (viewer.ts).

import type * as Y from "yjs";
import type { FileId } from "../shared/protocol.ts";
import { composeDocument, exportDocument, type Sources } from "./compose.ts";
import type { Built } from "./preview.ts";
import { tsClient } from "./ts/client.ts";
import { sourceLookup } from "./ts/sourcemap.ts";

const sourcesOf = (texts: Record<FileId, Y.Text>, meta: Y.Map<unknown>): Sources => ({
  html: texts.html.toString(),
  css: texts.css.toString(),
  js: texts.js.toString(),
  jsModule: meta.get("jsModule") === true,
});

export function buildPage(texts: Record<FileId, Y.Text>, meta: Y.Map<unknown>): Built | Promise<Built> {
  const src = sourcesOf(texts, meta);
  if (meta.get("jsLang") !== "ts" || !src.js.trim()) return { html: composeDocument(src) };
  return tsClient().call("transpile", src.js).then((t) => ({
    html: composeDocument({ ...src, js: t.js }),
    toSource: sourceLookup(t.map),
    label: "TS",
  }));
}

/**
 * The room's page as one HTML file to share (exportDocument): a TypeScript script is turned into the same
 * JavaScript the preview runs, so the file opens in any browser.
 */
export async function exportPage(texts: Record<FileId, Y.Text>, meta: Y.Map<unknown>): Promise<string> {
  const src = sourcesOf(texts, meta);
  if (meta.get("jsLang") === "ts" && src.js.trim()) src.js = (await tsClient().call("transpile", src.js)).js;
  return exportDocument(src);
}

/** Hands `html` to the browser as a download named `fileName` (UTF-8, marked so even opened from disk). */
export function downloadHtml(html: string, fileName: string) {
  // the byte-order mark makes a browser read the file as UTF-8 whatever the page declares (or not)
  const url = URL.createObjectURL(new Blob(["\uFEFF", html], { type: "text/html;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Same-browser messages between a room's editor tabs and its preview screens (Run → they run too). */
export const PREVIEW_CHANNEL = "livecode-preview";

export interface PreviewMessage {
  room: string;
  type: "run";
}

export function previewChannel(): BroadcastChannel | null {
  try {
    return new BroadcastChannel(PREVIEW_CHANNEL);
  } catch {
    return null;
  }
}

/** The address of a room's preview screen. */
export const viewerUrl = (room: string) => `/r/${room}/view`;
/** Its window name: the same screen is reused for a room, never one more each click. */
export const viewerTarget = (room: string) => `livecode-view-${room}`;

/** Presence of a preview screen: a viewer (the eye in the people list), never a person or a cursor. */
export interface ViewerState {
  viewer: true;
  user: { name: string; color: string };
}

export const isViewer = (st: Record<string, unknown> | undefined): boolean => st?.viewer === true;
