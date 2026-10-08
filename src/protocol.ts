// Wire protocol shared by the relay, the CLI, the MCP server and the web app.
//
// The relay only ever sees opaque envelopes: a sequence number, a timestamp,
// and AES-GCM ciphertext. Everything meaningful (sender, recipients, body,
// coordination events, signatures) lives inside the encrypted payload.

export const PROTOCOL_VERSION = 1;

/** Largest ciphertext (base64) the relay accepts for a single message. */
export const MAX_CT_LENGTH = 512 * 1024;

/** Largest raw image (per file) a client will attach: must survive two base64 trips inside this budget. */
export const MAX_IMAGE_BYTES = 256 * 1024;

/** Most images on one message. */
export const MAX_IMAGES = 8;

/** Largest ephemeral (unstored) frame. */
export const MAX_EPH_LENGTH = 4 * 1024;

/** How many messages a room keeps before pruning the oldest. */
export const ROOM_RETENTION = 10_000;

/** Most messages returned by one history read or replayed on connect. */
export const PAGE_LIMIT = 1_000;

/**
 * WebSocket subprotocol. Clients offer [WS_PROTOCOL, token] so the token
 * travels in a header (browsers can't set Authorization on WebSockets, and
 * query strings end up in logs); the relay answers with WS_PROTOCOL alone.
 */
export const WS_PROTOCOL = "modelchannel.v1";

/** Heartbeat frames. The relay answers these without waking the room. */
export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';

/** A stored message as the relay sees it. */
export interface Envelope {
  seq: number;
  ts: number;
  iv: string;
  ct: string;
  /** Key epoch (membership channels): which channel key sealed this message. */
  e?: number;
}

/** Frames the relay sends over the WebSocket. */
export type ServerFrame =
  | ({ t: "msg" } & Envelope)
  | { t: "eph"; iv: string; ct: string }
  | { t: "ready"; head: number; more: boolean }
  | { t: "ack"; id: string; seq: number }
  | { t: "err"; error: string; id?: string }
  /** Membership channels: the member list changed; refetch it. */
  | { t: "roster" }
  /** Membership channels: the channel key rotated; fetch the new one. */
  | { t: "epoch"; epoch: number }
  /** Membership channels: someone asked to join; the owner should look. */
  | { t: "request" };

/**
 * Frames a client sends over the WebSocket. `send` is stored and gets a
 * sequence number; `eph` is relayed to the other sockets and never stored.
 */
export type ClientFrame = { t: "send"; id: string; iv: string; ct: string; e?: number } | { t: "eph"; iv: string; ct: string };

/** WebSocket close codes the relay uses for membership changes. */
export const CLOSE_REMOVED = 4403;
export const CLOSE_CLOSED = 4410;

/**
 * Message kinds. Chat kinds carry intent for the reader; "event" marks a
 * coordination event (task, claim, fact, hello) whose meaning is in `ev`.
 */
export const KINDS = ["msg", "ask", "blocking", "ack", "status", "done", "event"] as const;
export type Kind = (typeof KINDS)[number];
export const CHAT_KINDS: readonly Kind[] = KINDS.filter((k) => k !== "event");

export const TASK_STATES = ["todo", "doing", "blocked", "review", "done"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Coordination events. Clients fold these, in sequence order, into shared state. */
export type Event =
  | { op: "hello"; role?: string; about?: string }
  | { op: "task.add"; title: string; detail?: string; owner?: string; after?: number[] }
  | { op: "task.claim"; task: number }
  | { op: "task.update"; task: number; state?: TaskState; owner?: string | null; title?: string; note?: string }
  | { op: "claim"; paths: string[]; ttl: number; note?: string }
  | { op: "release"; paths?: string[] }
  | { op: "fact.set"; key: string; value: string }
  | { op: "fact.del"; key: string };

/** One image attached to a message, encrypted with everything else. */
export interface ImageAttachment {
  name: string;
  /** e.g. "image/png". */
  mime: string;
  /** Raw bytes, base64. */
  data: string;
}

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
}

/** One-line marker for an image, e.g. `[image: shot.png (84KB)]`. */
export function imageMarker(img: Pick<ImageAttachment, "name" | "data">): string {
  return `[image: ${img.name} (${kb(Math.ceil((img.data.length * 3) / 4))})]`;
}

/** The decrypted message body. */
export interface Payload {
  v: typeof PROTOCOL_VERSION;
  id: string;
  from: string;
  /** Recipients by agent name; omitted means everyone. */
  to?: string[];
  kind: Kind;
  /** Human-readable text. For events, a one-line summary. */
  body: string;
  /** Sequence numbers this message replies to. */
  re?: number[];
  ev?: Event;
  /** Attached images, in order. Never present on events. */
  imgs?: ImageAttachment[];
  ts: number;
  /** Sender's Ed25519 public key (raw, base64url) and signature over the rest. */
  pk?: string;
  sig?: string;
}

/**
 * How far to trust who a message says it's from:
 *   verified   signed by the key the owner admitted under that name
 *   forged     anything else: another key, no signature, or not a member
 */
export type Trust = "verified" | "forged";

export interface Message extends Payload {
  seq: number;
  /** When the relay stored it (one clock for everyone, unlike `ts`). */
  rts?: number;
  /** Signature checks out for `pk` (binding pk to the name is the fold's job). */
  sigOk: boolean;
}

/** Ephemeral, unstored payloads: presence beacons and queries. */
export interface Presence {
  v: typeof PROTOCOL_VERSION;
  type: "presence";
  from: string;
  role?: string;
  /** What the sender's listener is: "tail", "wait", "mcp", "web". */
  client: string;
  /** Ask everyone listening to announce themselves. */
  query?: boolean;
  ts: number;
  pk?: string;
  sig?: string;
}

export function isRoomId(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s);
}
