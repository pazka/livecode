// The front-end embedded in the binary. `assets.gen.ts` is written by scripts/embed.ts (gitignored).

import { ASSETS } from "./assets.gen.ts";
import type { Asset } from "./http.ts";

function b64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function loadAssets(): Map<string, Asset> {
  const m = new Map<string, Asset>();
  for (const [path, a] of Object.entries(ASSETS)) {
    m.set(path, {
      type: a.type,
      body: a.b64 ? b64(a.b64) : undefined,
      gzip: a.gz ? b64(a.gz) : undefined,
      immutable: a.immutable,
    });
  }
  return m;
}
