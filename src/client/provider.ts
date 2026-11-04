// Browser side of the room connection: y-websocket wire convention (shared/protocol.ts), reconnect with
// jittered backoff, presence (awareness) kept alive, server notices surfaced to the UI.

import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { FATAL_NOTICES, MSG_AWARENESS, MSG_NOTICE, MSG_SYNC, type Notice } from "../shared/protocol.ts";

export type Status = "connecting" | "online" | "offline" | "stopped";

export interface ProviderEvents {
  status(s: Status): void;
  synced(): void;
  notice(n: Notice): void;
}

export class RoomProvider {
  readonly awareness: awarenessProtocol.Awareness;
  status: Status = "connecting";
  synced = false;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: number | undefined;
  private stopped = false;

  constructor(private readonly url: string, readonly doc: Y.Doc, private readonly on: ProviderEvents) {
    this.awareness = new awarenessProtocol.Awareness(doc);
    doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      this.send(MSG_SYNC, (e) => sync.writeUpdate(e, u));
    });
    this.awareness.on(
      "update",
      (ch: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin !== "local") return;
        const changed = ch.added.concat(ch.updated, ch.removed);
        this.send(
          MSG_AWARENESS,
          (e) =>
            encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)),
        );
      },
    );
    addEventListener("online", () => this.retryNow());
    addEventListener("pagehide", () => {
      awarenessProtocol.removeAwarenessStates(this.awareness, [doc.clientID], "unload");
    });
    this.connect();
  }

  private setStatus(s: Status) {
    if (this.status === s) return;
    this.status = s;
    this.on.status(s);
  }

  private send(type: number, write: (e: encoding.Encoder) => void) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, type);
    write(enc);
    this.ws.send(encoding.toUint8Array(enc));
  }

  private connect() {
    if (this.stopped) return;
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.send(MSG_SYNC, (e) => sync.writeSyncStep1(e, this.doc));
      if (this.awareness.getLocalState() !== null) {
        this.send(
          MSG_AWARENESS,
          (e) =>
            encoding.writeVarUint8Array(
              e,
              awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
            ),
        );
      }
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const dec = decoding.createDecoder(new Uint8Array(ev.data));
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        const sub = sync.readSyncMessage(dec, enc, this.doc, this);
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
        if (sub === sync.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          this.on.synced();
        }
        if (sub === sync.messageYjsSyncStep2) this.setStatus("online");
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
      } else if (type === MSG_NOTICE) {
        let n: Notice;
        try {
          n = JSON.parse(decoding.readVarString(dec));
        } catch {
          return;
        }
        if (FATAL_NOTICES.has(n.code)) this.stopped = true;
        this.on.notice(n);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // everyone else's cursor is stale now; they come back with the next sync
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
      if (this.stopped) return this.setStatus("stopped");
      this.setStatus("offline");
      const delay = Math.min(10_000, 400 * 2 ** this.attempt) * (0.75 + Math.random() / 2);
      this.attempt = Math.min(this.attempt + 1, 6);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  retryNow() {
    if (this.stopped || this.ws) return;
    clearTimeout(this.retryTimer);
    this.connect();
  }

  destroy() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.awareness.destroy();
  }
}
