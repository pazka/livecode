// Extracts the single file of a one-entry zip (the pinned denort runtime for `deno compile`), no dependency.
// Usage: deno run --allow-read --allow-write scripts/unzip1.ts <in.zip> <out-file>

const [src, dst] = Deno.args;
const zip = await Deno.readFile(src);
const v = new DataView(zip.buffer);
if (v.getUint32(0, true) !== 0x04034b50) throw new Error("not a zip");
const method = v.getUint16(8, true);
const nameLen = v.getUint16(26, true), extraLen = v.getUint16(28, true);
// sizes come from the central directory (local header sizes may be zero with a data descriptor)
let cd = zip.length - 22;
while (cd > 0 && v.getUint32(cd, true) !== 0x06054b50) cd--;
const cdStart = v.getUint32(cd + 16, true);
const compSize = v.getUint32(cdStart + 20, true);
const start = 30 + nameLen + extraLen;
const data = zip.subarray(start, start + compSize);
let out: Uint8Array;
if (method === 0) out = data;
else if (method === 8) {
  out = new Uint8Array(
    await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")))
      .arrayBuffer(),
  );
} else throw new Error(`zip method ${method}`);
await Deno.writeFile(dst, out, { mode: 0o755 });
