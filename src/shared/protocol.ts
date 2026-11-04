// Wire protocol shared by the server and the browser. Messages are binary (lib0 encoding):
//   varUint type, then the payload of that type.
//   MSG_SYNC      y-protocols sync message (step 1 / step 2 / update), the y-websocket convention
//   MSG_AWARENESS y-protocols awareness update (cursors, names, colours, current file)
//   MSG_NOTICE    server → client only: varString JSON { code, message } (limits, room full …)

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_NOTICE = 3;

/** The three shared files of a room, each a Y.Text of the same name. */
export const FILES = ["html", "css", "js"] as const;
export type FileId = typeof FILES[number];

/** Room ids are capability URLs: random ids from /new, or a name someone typed. */
export const ROOM_ID_RE = /^[a-z0-9][a-z0-9-]{3,39}$/;

export function isRoomId(s: string): boolean {
  return ROOM_ID_RE.test(s) && !s.endsWith("-") && !s.includes("--");
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no l, o, 0, 1: readable aloud

/** 12 characters from a 32-letter alphabet = 60 bits: not guessable. */
export function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (const b of bytes) s += ALPHABET[b & 31];
  return s;
}

export type NoticeCode =
  | "doc-too-large" // the room reached its size limit: further edits are refused
  | "room-full" // too many people in this room
  | "server-full" // too many connections or rooms on the server
  | "rate-limited" // too many messages: the connection is closed, the client reconnects
  | "too-many-new-rooms" // room creation rate limit for this address
  | "bad-message"; // undecodable message: the connection is closed

export interface Notice {
  code: NoticeCode;
  message: string;
}

/** Notices after which reconnecting immediately would only fail again. */
export const FATAL_NOTICES: ReadonlySet<NoticeCode> = new Set([
  "room-full",
  "server-full",
  "too-many-new-rooms",
]);

/** Close codes used by the server (4000–4999 = application range). */
export const CLOSE_POLICY = 4008;
export const CLOSE_FULL = 4009;
