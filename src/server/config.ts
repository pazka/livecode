// Configuration from env only (box contract rule 6). The variable list is also the compiled --allow-env list
// (deno.json `compile` task) — tests/config_test.ts keeps the two in step.

export const ENV_VARS = [
  "APP_DATA_DIR",
  "APP_PORT",
  "APP_LOG_LEVEL",
  "APP_BASE_URL",
  "APP_TRUSTED_PROXIES",
  "LIVECODE_MAX_ROOMS",
  "LIVECODE_MAX_DOC_KB",
  "LIVECODE_MAX_PEERS_PER_ROOM",
  "LIVECODE_MAX_CONNS",
  "LIVECODE_MAX_CONNS_PER_IP",
  "LIVECODE_NEW_ROOMS_PER_HOUR",
  "LIVECODE_ROOM_TTL_DAYS",
  "LIVECODE_VERSION",
] as const;

export interface Limits {
  /** Rooms kept on disk; beyond it, new rooms are refused (existing ones keep working). */
  maxRooms: number;
  /** Encoded size of one room's document (all three files + history tombstones). */
  maxDocBytes: number;
  maxPeersPerRoom: number;
  /** WebSocket connections on the whole server / per client address. */
  maxConns: number;
  maxConnsPerIp: number;
  /** Rooms one address may create per hour. */
  newRoomsPerHour: number;
  /** A room nobody opened for this many days is deleted. */
  roomTtlDays: number;
  /** One message (sync or awareness) larger than this closes the connection. */
  maxMessageBytes: number;
  /** Token bucket per connection: burst size and refill per second. */
  msgBurst: number;
  msgPerSecond: number;
}

export interface Config {
  dataDir: string;
  port: number;
  logLevel: string;
  /** Public origin; WebSocket upgrades from a browser must come from it. */
  baseUrl: string;
  trustedProxies: string[];
  version: string;
  limits: Limits;
}

function int(v: string | undefined, def: number, lo: number, hi: number): number {
  const n = v === undefined || v === "" ? def : Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : def;
}

export function loadConfig(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): Config {
  return {
    dataDir: env("APP_DATA_DIR") || "/data",
    port: int(env("APP_PORT"), 8000, 0, 65535),
    logLevel: env("APP_LOG_LEVEL") || "info",
    baseUrl: (env("APP_BASE_URL") || "https://code.hosh.it").replace(/\/+$/, ""),
    trustedProxies: (env("APP_TRUSTED_PROXIES") ?? "127.0.0.0/8,::1/128,172.16.0.0/12")
      .split(",").map((s) => s.trim()).filter(Boolean),
    version: env("LIVECODE_VERSION") || "dev",
    limits: {
      maxRooms: int(env("LIVECODE_MAX_ROOMS"), 5000, 1, 1_000_000),
      maxDocBytes: int(env("LIVECODE_MAX_DOC_KB"), 1024, 16, 65536) * 1024,
      maxPeersPerRoom: int(env("LIVECODE_MAX_PEERS_PER_ROOM"), 32, 1, 1000),
      maxConns: int(env("LIVECODE_MAX_CONNS"), 500, 1, 100_000),
      maxConnsPerIp: int(env("LIVECODE_MAX_CONNS_PER_IP"), 24, 1, 10_000),
      newRoomsPerHour: int(env("LIVECODE_NEW_ROOMS_PER_HOUR"), 30, 1, 100_000),
      roomTtlDays: int(env("LIVECODE_ROOM_TTL_DAYS"), 90, 1, 3650),
      maxMessageBytes: 512 * 1024,
      msgBurst: 300,
      msgPerSecond: 100,
    },
  };
}
