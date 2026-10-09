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

/** A channel's icon: an emoji, or a small image (never SVG, which can carry script). Sealed like the title. */
export type ChannelIcon = { kind: "emoji"; emoji: string } | { kind: "image"; mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string };
export const MAX_ICON_BYTES = 32 * 1024;
const ICON_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Whether a decrypted icon is one of the two shapes, within limits. */
export function wellFormedIcon(x: unknown): x is ChannelIcon {
  if (!x || typeof x !== "object") return false;
  const i = x as Record<string, unknown>;
  if (i.kind === "emoji") return typeof i.emoji === "string" && i.emoji.length > 0 && [...new Intl.Segmenter().segment(i.emoji)].length === 1 && i.emoji.length <= 16;
  return i.kind === "image" && typeof i.mime === "string" && ICON_MIMES.includes(i.mime) && typeof i.data === "string" && Math.ceil((i.data.length * 3) / 4) <= MAX_ICON_BYTES;
}

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
export const WS_PROTOCOL = "channel-one.v1";

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
  | { t: "request" }
  /** The channel's info changed (its icon); refetch it. */
  | { t: "info" };

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
 * coordination event (task, claim, fact, hello, role) whose meaning is in `ev`.
 */
export const KINDS = ["msg", "ask", "blocking", "ack", "status", "done", "event"] as const;
export type Kind = (typeof KINDS)[number];
export const CHAT_KINDS: readonly Kind[] = KINDS.filter((k) => k !== "event");

export const TASK_STATES = ["todo", "doing", "blocked", "review", "done"] as const;

/**
 * The colours a person can pick: ids, not values (the web app maps each to its
 * light and dark shades), and few enough to tell apart at avatar size. No two
 * people in a channel share one; their agents wear their person's.
 */
export const COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "indigo", "violet", "pink", "brown"] as const;
export type Color = (typeof COLORS)[number];
export const isColor = (x: unknown): x is Color => typeof x === "string" && (COLORS as readonly string[]).includes(x);
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
  | { op: "fact.del"; key: string }
  /** Owner only: set a member's role (and rules), or allow the one they asked for. */
  | { op: "role.set"; member: string; role: string | null; about?: string | null }
  /** Owner only: turn down the role a member asked for. */
  | { op: "role.refuse"; member: string }
  /** Owner only: a member's seat moved to a new key (fingerprints, for the record). */
  | { op: "seat.reclaim"; member: string; from: string; to: string }
  /** A person's colour (null clears it): set by that person, or by the owner for anyone. */
  | { op: "color.set"; member: string; color: Color | null };

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

const str = (x: unknown, max = 10_000): x is string => typeof x === "string" && x.length <= max;
const strs = (x: unknown, n: number): x is string[] => Array.isArray(x) && x.length <= n && x.every((y) => str(y, 512));
const nums = (x: unknown, n: number): x is number[] => Array.isArray(x) && x.length <= n && x.every((y) => Number.isSafeInteger(y) && y >= 0);
const opt = <T>(x: unknown, ok: (v: unknown) => v is T): boolean => x === undefined || ok(x);

/** Whether an event has the shape its op promises (anything else is dropped, not folded). */
export function wellFormedEvent(ev: unknown): ev is Event {
  if (!ev || typeof ev !== "object") return false;
  const e = ev as Record<string, unknown>;
  const n = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
  switch (e.op) {
    case "hello":
      return opt(e.role, (x): x is string => str(x, 200)) && opt(e.about, (x): x is string => str(x, 2000));
    case "task.add":
      return str(e.title, 500) && opt(e.detail, (x): x is string => str(x)) && opt(e.owner, (x): x is string => str(x, 64)) && opt(e.after, (x): x is number[] => nums(x, 50));
    case "task.claim":
      return n(e.task);
    case "task.update":
      return n(e.task) && opt(e.state, (x): x is string => typeof x === "string" && (TASK_STATES as readonly string[]).includes(x)) && (e.owner === undefined || e.owner === null || str(e.owner, 64)) && opt(e.title, (x): x is string => str(x, 500)) && opt(e.note, (x): x is string => str(x));
    case "claim":
      return strs(e.paths, 100) && (e.paths as string[]).length > 0 && Number.isFinite(e.ttl) && (e.ttl as number) > 0 && opt(e.note, (x): x is string => str(x, 500));
    case "release":
      return opt(e.paths, (x): x is string[] => strs(x, 100));
    case "fact.set":
      return str(e.key, 200) && str(e.value, 10_000);
    case "fact.del":
      return str(e.key, 200);
    case "role.set":
      return str(e.member, 64) && (e.role === null || str(e.role, 200)) && (e.about === undefined || e.about === null || str(e.about, 2000));
    case "role.refuse":
      return str(e.member, 64);
    case "seat.reclaim":
      return str(e.member, 64) && str(e.from, 64) && str(e.to, 64);
    case "color.set":
      return str(e.member, 64) && (e.color === null || isColor(e.color));
    default:
      return false;
  }
}

/** Whether a decrypted payload has the shape every client relies on. Malformed ones are dropped. */
export function wellFormed(p: unknown): p is Payload {
  if (!p || typeof p !== "object") return false;
  const m = p as Record<string, unknown>;
  return (
    m.v === PROTOCOL_VERSION &&
    str(m.id, 100) &&
    str(m.from, 64) &&
    str(m.body, 100_000) &&
    typeof m.kind === "string" &&
    (KINDS as readonly string[]).includes(m.kind) &&
    Number.isFinite(m.ts) &&
    opt(m.to, (x): x is string[] => strs(x, 50)) &&
    opt(m.re, (x): x is number[] => nums(x, 20)) &&
    (m.ev === undefined || wellFormedEvent(m.ev)) &&
    (m.kind !== "event" || m.ev !== undefined)
  );
}
