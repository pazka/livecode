// Messages between the editor and the TypeScript worker (worker.ts). Each request carries an id; the
// worker answers with the same id and either `result` or `error`.

import type { Completions, Transpiled, TypeError, TypeInfo } from "./service.ts";

export interface TsApi {
  completions(text: string, pos: number, trigger?: string): Completions | null;
  details(text: string, pos: number, name: string, source?: string): { display: string; docs: string } | null;
  typeAt(text: string, pos: number): TypeInfo | null;
  errors(text: string): TypeError[];
  transpile(text: string): Transpiled;
}

export type TsMethod = keyof TsApi;

export interface TsRequest<M extends TsMethod = TsMethod> {
  id: number;
  method: M;
  args: Parameters<TsApi[M]>;
}

export type TsResponse =
  | { id: number; result: unknown }
  | { id: number; error: string }
  /** Sent once, when the worker has loaded TypeScript and its lib files. */
  | { id: 0; ready: string };
