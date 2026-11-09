// The page the preview shows, from a room's shared files: the three files as they are, or with the TypeScript
// turned into JavaScript first (worker). Used by the editor's preview and by the preview screen (viewer.ts).

import type * as Y from "yjs";
import type { FileId } from "../shared/protocol.ts";
import { composeDocument } from "./compose.ts";
import type { Built } from "./preview.ts";
import { tsClient } from "./ts/client.ts";
import { sourceLookup } from "./ts/sourcemap.ts";

export function buildPage(texts: Record<FileId, Y.Text>, meta: Y.Map<unknown>): Built | Promise<Built> {
  const src = {
    html: texts.html.toString(),
    css: texts.css.toString(),
    js: texts.js.toString(),
    jsModule: meta.get("jsModule") === true,
  };
  if (meta.get("jsLang") !== "ts" || !src.js.trim()) return { html: composeDocument(src) };
  return tsClient().call("transpile", src.js).then((t) => ({
    html: composeDocument({ ...src, js: t.js }),
    toSource: sourceLookup(t.map),
    label: "TS",
  }));
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
