// What a brand-new room contains (seeded once by the server, so two people opening a fresh room at the
// same time never get the starter twice).

export const STARTER = {
  html: `<main>
  <h1>Hello, live code!</h1>
  <p>Everyone in this room edits the same page. Change anything: the preview refreshes for all.</p>
  <button id="btn" type="button">Click me</button>
  <p id="out" aria-live="polite"></p>
</main>
`,
  css: `:root {
  font-family: system-ui, sans-serif;
  color-scheme: light dark;
}

main {
  max-width: 40rem;
  margin: 3rem auto;
  padding: 0 1rem;
  line-height: 1.5;
}

button {
  font: inherit;
  padding: 0.5rem 1rem;
}
`,
  js: `const btn = document.getElementById("btn");
const out = document.getElementById("out");
let clicks = 0;

btn.addEventListener("click", () => {
  clicks += 1;
  out.textContent = \`Clicked \${clicks} time\${clicks === 1 ? "" : "s"}\`;
  console.log("click", clicks);
});
`,
};
