// The TypeScript worker (served as /ts-worker.js, loaded only by rooms whose script is TypeScript): the
// TypeScript compiler + the browser's type definitions, off the editor's thread. Requests: protocol.ts.

import ts from "typescript";
import { LIBS, TS_VERSION } from "./libs.gen.ts";
import type { TsApi, TsRequest, TsResponse } from "./protocol.ts";
import { ScriptService } from "./service.ts";

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<TsRequest>) => void) | null;
  postMessage(m: TsResponse): void;
};

const service = new ScriptService(ts, LIBS);
const api: TsApi = {
  completions: (text, pos, trigger) => service.completions(text, pos, trigger),
  details: (text, pos, name, source) => service.details(text, pos, name, source),
  typeAt: (text, pos) => service.typeAt(text, pos),
  errors: (text) => service.errors(text),
  transpile: (text) => service.transpile(text),
  rename: (text, pos, lang) => service.rename(text, pos, lang),
};

scope.onmessage = (e) => {
  const { id, method, args } = e.data ?? {};
  if (typeof id !== "number" || !(method in api)) return;
  try {
    const fn = api[method] as (...a: unknown[]) => unknown;
    scope.postMessage({ id, result: fn(...(args as unknown[])) });
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
scope.postMessage({ id: 0, ready: TS_VERSION });
