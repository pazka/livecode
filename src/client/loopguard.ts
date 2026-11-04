// Infinite-loop protection for the JS file: every for / while / do-while body gets a cheap check that breaks
// out when the page has not been able to breathe for 1.5 s (runtime: compose.ts → __lcLoop). Parsed with
// CodeMirror's own JavaScript parser (error-tolerant); line numbers are kept (nothing adds a newline).

import { javascriptLanguage } from "@codemirror/lang-javascript";

/** lezer SyntaxNode, without importing @lezer/common directly (it comes with the CodeMirror packages). */
type SyntaxNode = ReturnType<typeof javascriptLanguage.parser.parse>["topNode"];

const LOOPS = new Set(["ForStatement", "WhileStatement", "DoStatement"]);

function bodyOf(node: SyntaxNode): SyntaxNode | null {
  const stmts: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.type.is("Statement")) stmts.push(c);
  if (stmts.length === 0) return null;
  return node.name === "DoStatement" ? stmts[0] : stmts[stmts.length - 1];
}

export function guardLoops(src: string, fn = "__lcLoop"): string {
  const tree = javascriptLanguage.parser.parse(src);
  const ins: { at: number; text: string }[] = [];
  tree.iterate({
    enter(ref) {
      if (!LOOPS.has(ref.name)) return;
      const node = ref.node;
      const body = bodyOf(node);
      if (!body || body.type.isError || body.from >= body.to) return;
      let hasError = false;
      body.toTree().iterate({
        enter(n) {
          if (n.type.isError) hasError = true;
          return !hasError;
        },
      });
      if (hasError && body.name !== "Block") return; // never wrap a half-typed statement
      const line = src.slice(0, node.from).split("\n").length;
      const guard = `if (${fn}(${line})) break;`;
      if (body.name === "Block") {
        if (src[body.from] !== "{") return;
        ins.push({ at: body.from + 1, text: guard });
      } else {
        ins.push({ at: body.from, text: `{${guard}` });
        ins.push({ at: body.to, text: "}" });
      }
    },
  });
  ins.sort((a, b) => b.at - a.at);
  let out = src;
  for (const i of ins) out = out.slice(0, i.at) + i.text + out.slice(i.at);
  return out;
}
