// Repairs a bundle that `deno bundle --minify` (2.9.8) can break.
//
// esbuild's helper for a CommonJS package's default export (`import ts from "typescript"`) reads
//   __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, … }) : target, mod)
// and Deno rewrites that condition to `1` after the bundle is made. Minified, the condition is
// `a||!b||!b.__esModule`, and when the minifier happens to name the first parameter with a `$` (`$o`), Deno's
// rewrite leaves the `$` behind: `$1 ?…` — a name that does not exist. The bundle then throws
// "ReferenceError: $1 is not defined" as soon as it loads (the TypeScript worker never starts). Which names
// the minifier picks depends on everything in the bundle, so any change to the code can trigger it.
//
// Here the left-over is removed (the condition is `1` again), and the build can check that nothing of the
// kind is left. Pure: tests/unit_test.ts. Used by scripts/embed.ts on every JavaScript bundle.

/** `(<left-over ending in $>1 ?<defProp>(<target>,"default",{value:` — the helper with a broken condition. */
const BROKEN = /([(,])[\w$]*\$(1 \?[\w$]+\([\w$]+,"default",\{value:)/g;

export function repairInteropHelper(js: string): { js: string; repaired: number } {
  let repaired = 0;
  const out = js.replace(BROKEN, (_all, before: string, rest: string) => {
    repaired++;
    return before + rest;
  });
  return { js: out, repaired };
}
