// Wire protocol shared by the relay and the client.
//
// The relay only ever sees opaque envelopes: a sequence number, a timestamp,
// and AES-GCM ciphertext. Everything meaningful (sender, recipients, body)
// lives inside the encrypted payload.

export const PROTOCOL_VERSION = 1;

/** Largest ciphertext (base64) the relay accepts for a single message. */
export const MAX_CT_LENGTH = 96 * 1024;

/** How many messages a room keeps before pruning the oldest. */
export const ROOM_RETENTION = 10_000;

/** Most messages returned by one history read or replayed on connect. */
export const PAGE_LIMIT = 1_000;

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
  | { t: "ready"; head: number; more: boolean }
  | { t: "ack"; id: string; seq: number }
  | { t: "err"; error: string; id?: string };

/** Frames a client sends over the WebSocket. */
export type ClientFrame = { t: "send"; id: string; iv: string; ct: string };

export const KINDS = ["msg", "ask", "blocking", "ack", "status", "done"] as const;
export type Kind = (typeof KINDS)[number];

/** The decrypted message body. */
export interface Payload {
  v: typeof PROTOCOL_VERSION;
  id: string;
  from: string;
  /** Recipients by agent name; omitted means everyone. */
  to?: string[];
  kind: Kind;
  body: string;
  /** Sequence numbers this message replies to. */
  re?: number[];
  ts: number;
}

export interface Message extends Payload {
  seq: number;
}

export function isRoomId(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s);
}
