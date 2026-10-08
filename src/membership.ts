// The member list: owner-signed records binding each name to a key.
//
// A record is signed by the owner and sealed with the channel key before it
// reaches the relay, so the relay can enforce *who* may connect (by key)
// without learning *what they're called*. Clients verify every record against
// the owner key pinned in the join code, so neither the relay nor a member
// can mint a name: "win" is whoever the owner approved as "win", full stop.

import { openWith, sealWith } from "./crypto.ts";
import { sign, verify, type Identity } from "./identity.ts";

export interface MemberInfo {
  name: string;
  role?: string;
  about?: string;
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
}

export const NAME_RE = /^[\p{L}\p{N}_.\-]{1,32}$/u;

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
    return { pk: rec.member, xpk: rec.mxpk, name: rec.name, role: rec.role, about: rec.about, owner: !!rec.owner && rec.member === ownerPk, at: rec.at, active: true };
  } catch {
    return null;
  }
}

/** A pending join request, as the owner sees it after opening its box. */
export interface JoinRequest extends MemberInfo {
  id: string;
  pk: string;
  xpk: string;
  /** The 6-digit code the requester sees too. */
  code: string;
  ts: number;
}
