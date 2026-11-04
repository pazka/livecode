// Configuration from env only (box contract rule 6). The variable list is also the compiled --allow-env list
// (deno.json `compile` task) — tests/config_test.ts keeps the two in step.

export const ENV_VARS = [
  "APP_DATA_DIR",
  "APP_PORT",
  "APP_LOG_LEVEL",
  "APP_BASE_URL",
  "APP_TRUSTED_PROXIES",
  "LIVECODE_MAX_ROOMS",
  "LIVECODE_MAX_STORAGE_MB",
  "LIVECODE_MAX_LIVE_ROOMS",
  "LIVECODE_MAX_RSS_MB",
  "LIVECODE_MAX_FILE_KB",
  "LIVECODE_MAX_DOC_KB",
  "LIVECODE_MAX_PEERS_PER_ROOM",
  "LIVECODE_MAX_CONNS",
  "LIVECODE_MAX_CONNS_PER_IP",
  "LIVECODE_NEW_ROOMS_PER_HOUR",
  "LIVECODE_NEW_ROOMS_PER_HOUR_TOTAL",
  "LIVECODE_ROOM_TTL_DAYS",
  "LIVECODE_VERSION",
] as const;

/** Read by dependencies at import (lib0: colours, production flag). Harmless; allowed in the binary too. */
export const LIBRARY_ENV_VARS = ["PRODUCTION", "NO_COLOR", "FORCE_COLOR", "COLORTERM", "TERM", "LOG", "NODE_ENV"];

export interface Limits {
  /** Rooms kept on disk; beyond it, new rooms are refused (existing ones keep working). */
  maxRooms: number;
  /** Bytes of all stored rooms; beyond it, new rooms are refused. */
  maxStorageBytes: number;
  /** Rooms held in memory at once (open by someone, or in their unload grace period). */
  maxLiveRooms: number;
  /** Process memory above which new rooms and connections are refused (container limit: 512 MiB). */
  maxRssBytes: number;
  /** Characters in one file (html, css or js); the server cuts anything beyond it. */
  maxFileChars: number;
  /** Encoded size of one room's document (all three files + history tombstones). */
  maxDocBytes: number;
  maxPeersPerRoom: number;
  /** WebSocket connections on the whole server / per client address. */
  maxConns: number;
  maxConnsPerIp: number;
  /** Rooms one address may create per hour, and all addresses together. */
  newRoomsPerHour: number;
  newRoomsPerHourTotal: number;
  /** A room idle (not opened, not edited) for this many days is deleted. */
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
      maxRooms: int(env("LIVECODE_MAX_ROOMS"), 2000, 1, 1_000_000),
      maxStorageBytes: int(env("LIVECODE_MAX_STORAGE_MB"), 512, 1, 1_000_000) * 1024 * 1024,
      maxLiveRooms: int(env("LIVECODE_MAX_LIVE_ROOMS"), 100, 1, 100_000),
      maxRssBytes: int(env("LIVECODE_MAX_RSS_MB"), 384, 32, 1_000_000) * 1024 * 1024,
      maxFileChars: int(env("LIVECODE_MAX_FILE_KB"), 128, 1, 16384) * 1024,
      maxDocBytes: int(env("LIVECODE_MAX_DOC_KB"), 640, 16, 65536) * 1024,
      maxPeersPerRoom: int(env("LIVECODE_MAX_PEERS_PER_ROOM"), 32, 1, 1000),
      maxConns: int(env("LIVECODE_MAX_CONNS"), 500, 1, 100_000),
      maxConnsPerIp: int(env("LIVECODE_MAX_CONNS_PER_IP"), 24, 1, 10_000),
      newRoomsPerHour: int(env("LIVECODE_NEW_ROOMS_PER_HOUR"), 20, 1, 100_000),
      newRoomsPerHourTotal: int(env("LIVECODE_NEW_ROOMS_PER_HOUR_TOTAL"), 200, 1, 1_000_000),
      roomTtlDays: int(env("LIVECODE_ROOM_TTL_DAYS"), 7, 1, 3650),
      maxMessageBytes: 512 * 1024,
      msgBurst: 300,
      msgPerSecond: 100,
    },
  };
}
