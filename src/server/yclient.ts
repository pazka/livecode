// A minimal headless room client (Deno): used by the in-container smoke (POST_DEPLOY) and by the tests.
// Same wire protocol as the browser provider (src/client/provider.ts).

import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { MSG_AWARENESS, MSG_NOTICE, MSG_SYNC, type Notice } from "../shared/protocol.ts";

export class YClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly notices: Notice[] = [];
  readonly ws: WebSocket;
  synced = false;
  closed: Promise<CloseEvent>;
  private readonly onSynced: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    let resolveSynced!: () => void;
    this.onSynced = new Promise((r) => (resolveSynced = r));
    this.closed = new Promise((r) => this.ws.addEventListener("close", r, { once: true }));
    this.ws.onopen = () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      sync.writeSyncStep1(enc, this.doc);
      this.ws.send(encoding.toUint8Array(enc));
    };
    this.ws.onmessage = (e: MessageEvent) => {
      const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        const sub = sync.readSyncMessage(dec, enc, this.doc, this);
        if (encoding.length(enc) > 1) this.ws.send(encoding.toUint8Array(enc));
        if (sub === sync.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          resolveSynced();
        }
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
      } else if (type === MSG_NOTICE) {
        this.notices.push(JSON.parse(decoding.readVarString(dec)));
      }
    };
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === this || this.ws.readyState !== WebSocket.OPEN) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      sync.writeUpdate(enc, u);
      this.ws.send(encoding.toUint8Array(enc));
    });
    this.awareness.on(
      "update",
      (ch: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin !== "local" || this.ws.readyState !== WebSocket.OPEN) return;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_AWARENESS);
        encoding.writeVarUint8Array(
          enc,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, ch.added.concat(ch.updated, ch.removed)),
        );
        this.ws.send(encoding.toUint8Array(enc));
      },
    );
  }

  /** Resolves once the server's state arrived (sync step 2), rejects after `ms`. */
  ready(ms = 5000): Promise<void> {
    return withTimeout(this.onSynced, ms, "sync");
  }

  text(file: string): string {
    return this.doc.getText(file).toString();
  }

  /** Raw send (tests: malformed or oversized messages). */
  sendRaw(data: Uint8Array) {
    this.ws.send(data as Uint8Array<ArrayBuffer>);
  }

  async close(): Promise<void> {
    this.awareness.destroy();
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await this.closed;
    this.doc.destroy();
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: number | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))),
  ]);
}

/** Poll `pred` every 25 ms until true or `ms` elapsed. */
export async function until(pred: () => boolean, ms = 5000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
