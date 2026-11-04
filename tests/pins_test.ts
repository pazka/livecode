// Supply-chain pins stay consistent (box contract rule 12). The Deno version is written in the Dockerfile
// (base image tag + denort download) and in every workflow that installs Deno; Dependabot bumps only the
// Dockerfile base, so a bump that is not carried everywhere must fail here, before it reaches an image.

import { assert, assertEquals } from "@std/assert";

const root = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFile(new URL(p, root));
const WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/workflows/bootstrap.yml",
];

async function dockerfileDeno() {
  const df = await read("Dockerfile");
  const base = df.match(/^FROM denoland\/deno:debian-(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64} AS build$/m);
  const denort = df.match(/releases\/download\/v(\d+\.\d+\.\d+)\/denort-x86_64-unknown-linux-gnu\.zip/);
  assert(base, "Dockerfile build stage: denoland/deno:debian-<version>@sha256:<digest>");
  assert(denort, "Dockerfile: denort download URL");
  return { df, base: base[1], denort: denort[1] };
}

Deno.test("pins: Dockerfile base image and denort are the same Deno version", async () => {
  const { base, denort } = await dockerfileDeno();
  assertEquals(denort, base, "bump the denort ADD (URL + --checksum) together with the base image");
});

Deno.test("pins: every workflow installs the Dockerfile's Deno version with one checksum", async () => {
  const { base } = await dockerfileDeno();
  const sums = new Set<string>();
  for (const wf of WORKFLOWS) {
    const y = await read(wf);
    const urls = [...y.matchAll(/releases\/download\/v(\d+\.\d+\.\d+)\/deno-x86_64-unknown-linux-gnu\.zip/g)];
    assert(urls.length > 0, `${wf}: no pinned Deno install`);
    for (const u of urls) assertEquals(u[1], base, `${wf}: Deno ${u[1]} but Dockerfile has ${base}`);
    for (const n of y.matchAll(/Install Deno (\d+\.\d+\.\d+)/g)) assertEquals(n[1], base, `${wf}: step name`);
    const s = [...y.matchAll(/echo "([0-9a-f]{64}) {2}\/tmp\/deno\.zip" \| sha256sum -c -/g)];
    assertEquals(s.length, urls.length, `${wf}: every Deno download is checksum-verified`);
    for (const m of s) sums.add(m[1]);
  }
  assertEquals(sums.size, 1, "all workflows verify the same deno.zip checksum");
});

Deno.test("pins: the Deno running the tests is the pinned one (CI and the image agree)", async () => {
  const { base } = await dockerfileDeno();
  assertEquals(Deno.version.deno, base);
});

Deno.test("pins: every base image is pinned by digest", async () => {
  const { df } = await dockerfileDeno();
  const froms = [...df.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
  assert(froms.length >= 2);
  for (const f of froms) assert(/@sha256:[0-9a-f]{64}$/.test(f), `unpinned base image ${f}`);
});

Deno.test("pins: deno.json imports are exact versions, lockfile frozen, no install scripts", async () => {
  const cfg = JSON.parse(await read("deno.json"));
  assertEquals(cfg.lock?.frozen, true);
  assertEquals(cfg.allowScripts, false);
  assertEquals(cfg.minimumDependencyAge, "P7D");
  for (const [name, spec] of Object.entries(cfg.imports as Record<string, string>)) {
    assert(/^(jsr|npm):\/?@?[^@]+@\d+\.\d+\.\d+\/?$/.test(spec), `${name}: ${spec} is not an exact pin`);
  }
});
