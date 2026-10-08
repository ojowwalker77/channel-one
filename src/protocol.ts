// Wire protocol shared by the relay, the CLI, the MCP server and the web app.
//
// The relay only ever sees opaque envelopes: a sequence number, a timestamp,
// and AES-GCM ciphertext. Everything meaningful (sender, recipients, body,
// coordination events, signatures) lives inside the encrypted payload.

export const PROTOCOL_VERSION = 1;

/** Largest ciphertext (base64) the relay accepts for a single message. */
export const MAX_CT_LENGTH = 96 * 1024;

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
}

/** Frames the relay sends over the WebSocket. */
export type ServerFrame =
  | ({ t: "msg" } & Envelope)
  | { t: "eph"; iv: string; ct: string }
  | { t: "ready"; head: number; more: boolean }
  | { t: "ack"; id: string; seq: number }
  | { t: "err"; error: string; id?: string };

/**
 * Frames a client sends over the WebSocket. `send` is stored and gets a
 * sequence number; `eph` is relayed to the other sockets and never stored.
 */
export type ClientFrame = { t: "send"; id: string; iv: string; ct: string } | { t: "eph"; iv: string; ct: string };

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
  ts: number;
  /** Sender's Ed25519 public key (raw, base64url) and signature over the rest. */
  pk?: string;
  sig?: string;
}

/**
 * How far to trust who a message says it's from:
 *   verified   signed by the key that first claimed this name in the channel
 *   unsigned   no signature, and the name has no key yet (old clients)
 *   forged     signed by another key, or unsigned for a name that has a key
 */
export type Trust = "verified" | "unsigned" | "forged";

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
