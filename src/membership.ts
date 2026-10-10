// The member list: owner-signed records binding each name to a key.
//
// A record is signed by the owner and sealed with the channel key before it
// reaches the relay, so the relay can enforce *who* may connect (by key)
// without learning *what they're called*. Clients verify every record against
// the owner key pinned in the join code, so neither the relay nor a member
// can mint a name: "win" is whoever the owner approved as "win", full stop.

import { openWith, sealWith } from "./crypto.ts";
import { sign, verify, type Identity } from "./identity.ts";
import { isColor, type Color } from "./protocol.ts";
import { readScopes, wireScopes, type Scope } from "./scopes.ts";

/** The signed-in person an agent acts for, as the relay verified them with WorkOS. */
export interface Sponsor {
  /** WorkOS user id. */
  user: string;
  /** Their name as WorkOS knows it ("Jonatas Walker"). */
  name: string;
  /** Their handle in this channel, when they're a member too ("jonatas"). */
  handle?: string;
}

export interface MemberInfo {
  /** Handle in the channel: what messages show and what --to uses. */
  name: string;
  role?: string;
  about?: string;
  /** People and agents are different kinds of member. Absent means agent (CLI-run channels). */
  kind?: "human" | "agent";
  /** A person's full name from sign-in. */
  display?: string;
  /** For an agent: the person it acts for. For a person: themself. */
  sponsor?: Sponsor;
  /** A person's colour, if the owner set one when admitting them (later changes are color.set events). */
  color?: Color;
  /** What they may do besides read, as the owner signed it. Absent: everything (see scopes.ts). */
  scopes?: Scope[];
  /** In a join request only: the requester means to take over the seat under this name with a new key. */
  reclaim?: boolean;
}

/** The member a request's name already belongs to: approving it would move their seat to the new key. */
export interface ReclaimTarget {
  name: string;
  pk: string;
  kind?: "human" | "agent";
  owner: boolean;
  sponsor?: Sponsor;
}

/** "jonatas" from "Jonatas Walker" or "jonatas@x.com": a channel handle for a signed-in person. */
export function handleFor(name: string, email?: string): string {
  // The whole name, not just the first: "Jonatas Filho" and "Jonatas Walker" must not both be @jonatas.
  const base = (name.trim() || email?.split("@")[0] || "person").toLowerCase().replace(/\s+/g, "-");
  const h = base.normalize("NFKD").replace(/[^\p{L}\p{N}_.-]/gu, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  return h || "person";
}

/** What the owner signs when admitting a key. */
export interface MemberRecord extends MemberInfo {
  room: string;
  /** The member's Ed25519 key (`pk` itself is the signer's, i.e. the owner's). */
  member: string;
  /** The member's X25519 key. */
  mxpk: string;
  owner?: boolean;
  at: number;
  pk: string;
  sig: string;
}

export interface Member extends MemberInfo {
  pk: string;
  xpk: string;
  owner: boolean;
  at: number;
  /** False once they've left or been removed. */
  active: boolean;
  /** The relay lists this key as a member, but there's no record the owner signed for it. */
  unverified?: boolean;
}

export const NAME_RE = /^[\p{L}\p{N}_.\-]{1,32}$/u;

/** Names nobody may be admitted under: they'd read as someone or something else. */
export const RESERVED_NAMES = new Set(["human", "owner", "you", "me", "all", "everyone", "system", "kiwi", "admin"]);

/** How names compare: two names that look the same are the same. */
export function nameKey(n: string): string {
  return n.normalize("NFKC").toLowerCase();
}

/**
 * Text someone else wrote, made safe for one line of agent-facing output: no
 * control or direction characters, no line breaks (so it can't pose as another
 * message), bounded length.
 */
export function inlineText(s: unknown, max = 120): string {
  if (typeof s !== "string") return "";
  const flat = s
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const ad = (room: string) => `mc-member\n${room}`;

export async function makeRecord(owner: Identity, room: string, m: MemberInfo & { pk: string; xpk: string; owner?: boolean }): Promise<MemberRecord> {
  return sign(owner, {
    room,
    member: m.pk,
    mxpk: m.xpk,
    name: m.name,
    ...(m.role ? { role: m.role } : {}),
    ...(m.about ? { about: m.about } : {}),
    ...(m.owner ? { owner: true } : {}),
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.display ? { display: m.display } : {}),
    ...(m.sponsor ? { sponsor: m.sponsor } : {}),
    ...(m.color && (m.kind === "human" || m.owner) ? { color: m.color } : {}),
    ...(!m.owner && wireScopes(m.scopes) ? { scopes: wireScopes(m.scopes)! } : {}),
    at: Date.now(),
  });
}

export async function sealRecord(key: string, rec: MemberRecord): Promise<string> {
  return sealWith(key, JSON.stringify(rec), ad(rec.room));
}

/** Open and verify a sealed record: it must be the owner's signature, for this room and this key. */
export async function openRecord(key: string, sealed: string, room: string, ownerPk: string, pk: string): Promise<Member | null> {
  const raw = await openWith(key, sealed, ad(room));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as MemberRecord;
    if (rec.pk !== ownerPk || rec.room !== room || rec.member !== pk || !NAME_RE.test(rec.name)) return null;
    if (!(await verify(rec))) return null;
    const owner = !!rec.owner && rec.member === ownerPk;
    // Scopes the record can't be read as are none at all: a garbled grant gives nothing.
    const scopes = owner || rec.scopes === undefined ? undefined : (readScopes(rec.scopes) ?? []);
    return {
      pk: rec.member,
      xpk: rec.mxpk,
      name: rec.name,
      role: rec.role,
      about: rec.about,
      kind: rec.kind,
      display: rec.display,
      sponsor: rec.sponsor,
      ...(isColor(rec.color) ? { color: rec.color } : {}),
      ...(scopes ? { scopes } : {}),
      owner,
      at: rec.at,
      active: true,
    };
  } catch {
    return null;
  }
}

/** A pending join request, as the owner sees it after opening its box. */
export interface JoinRequest extends MemberInfo {
  id: string;
  pk: string;
  xpk: string;
  /** The 6-digit code the requester sees too; null until both halves of the check are in. */
  code: string | null;
  /**
   * Where the code check stands: "unchecked" until an owner device signs its half (a click,
   * once a device has signed its day's share on its own), "waiting" for the joiner's half.
   */
  check: "unchecked" | "waiting" | "ready";
  /** The joiner's commitment, which the owner signs. */
  commit: string;
  ts: number;
  /** The signed-in person it acts for: themself for a person, or whose linked computer an agent joined from. */
  sponsoredBy: { user: string; name: string; email?: string | null } | null;
  /**
   * Set when the name already belongs to a current member: this is a RECLAIM of
   * their seat, never a plain join. Its code check is never signed automatically.
   */
  reclaims?: ReclaimTarget;
  /** The requester said it means to reclaim (--reclaim); `reclaims` is what counts. */
  reclaim?: boolean;
}

/** How a member reads in lists: "win · key QRskRn4Z · agent of @jonatas" / "Jonatas Walker (@jonatas)". */
export function describeMember(m: { name: string; pk: string; kind?: string; display?: string; sponsor?: Sponsor; owner?: boolean }): string {
  const key = `key ${m.pk.slice(0, 8)}`;
  if (m.kind === "human") return `${m.display ?? m.name} (@${m.name})${m.owner ? " · owner" : ""} · ${key}`;
  const sponsor = m.sponsor ? ` · agent of @${m.sponsor.handle ?? handleFor(m.sponsor.name)}` : "";
  return `${m.name} · ${key}${sponsor}`;
}
