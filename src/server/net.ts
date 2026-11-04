// Client address behind the edge: X-Forwarded-For is trusted only from the configured proxies (box contract:
// 127/8, ::1, 172.16/12 — Traefik reaches the container through docker-proxy). Origin check for WebSockets.

function v4(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function v6(ip: string): bigint | null {
  if (!ip.includes(":")) return null;
  const s = ip.replace(/^\[|\]$/g, "").split("%")[0];
  const [head, tail] = s.split("::");
  if (s.split("::").length > 2) return null;
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n);
}

/** Unwrap IPv4-mapped IPv6 (::ffff:1.2.3.4). */
export function normalizeIp(ip: string): string {
  const m = ip.match(/^(?:\[)?::ffff:(\d+\.\d+\.\d+\.\d+)(?:\])?$/i);
  return m ? m[1] : ip.replace(/^\[|\]$/g, "");
}

export function inCidr(ipRaw: string, cidr: string): boolean {
  const ip = normalizeIp(ipRaw);
  const [net, bitsS] = cidr.split("/");
  const a4 = v4(ip), n4 = v4(net);
  if (a4 !== null && n4 !== null) {
    const bits = bitsS === undefined ? 32 : Number(bitsS);
    if (!(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((a4 & mask) >>> 0) === ((n4 & mask) >>> 0);
  }
  const a6 = v6(ip), n6 = v6(net);
  if (a6 !== null && n6 !== null) {
    const bits = bitsS === undefined ? 128 : Number(bitsS);
    if (!(bits >= 0 && bits <= 128)) return false;
    const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
    return (a6 & mask) === (n6 & mask);
  }
  return false;
}

/** The client address: the right-most untrusted hop of X-Forwarded-For when the peer is a trusted proxy. */
export function clientIp(peer: string, xff: string | null, trusted: string[]): string {
  const p = normalizeIp(peer);
  if (!xff || !trusted.some((c) => inCidr(p, c))) return p;
  const hops = xff.split(",").map((s) => normalizeIp(s.trim())).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trusted.some((c) => inCidr(hops[i], c))) return hops[i];
  }
  return hops[0] ?? p;
}

/** Browsers always send Origin on a WebSocket upgrade; it must be ours. Non-browser clients send none. */
export function originAllowed(origin: string | null, baseUrl: string, requestUrl: string): boolean {
  if (origin === null) return true;
  try {
    const o = new URL(origin).origin;
    return o === new URL(baseUrl).origin || o === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}
