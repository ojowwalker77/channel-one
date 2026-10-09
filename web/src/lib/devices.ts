import { decodeJoinCode } from "@mc/crypto.ts"
import { offerToDevice, parseOfferHash, takeOffer, type DeviceOffer } from "@mc/devices.ts"
import { allMembers, loadMember, saveMember, type StoredMember } from "./channel"

// Your channels, handed to another of your devices through a QR code. What
// travels: this browser's identity and keys for each channel, owner keys
// included, so the other device can do everything this one can.

interface Bundle {
  v: 1
  channels: StoredMember[]
}

/** What this browser would hand over. */
export function handover(): { channels: number; owned: number } {
  const all = allMembers()
  return { channels: all.length, owned: all.filter((m) => m.identity.pk === m.access.ownerPk).length }
}

export async function offerChannels(token: string): Promise<DeviceOffer> {
  const bundle: Bundle = { v: 1, channels: allMembers() }
  return offerToDevice(location.origin, token, JSON.stringify(bundle))
}

function wellFormed(m: StoredMember): boolean {
  try {
    return (
      typeof m.identity?.pk === "string" &&
      typeof m.identity.sk === "string" &&
      typeof m.identity.name === "string" &&
      typeof m.access?.ownerPk === "string" &&
      typeof m.access.keys === "object" &&
      decodeJoinCode(m.code).roomId === m.access.roomId
    )
  } catch {
    return false
  }
}

/**
 * Take the channels another device offered and keep the ones this browser
 * doesn't have. A key this browser already holds is never replaced.
 */
export async function takeChannels(token: string, offer: Pick<DeviceOffer, "id" | "secret">): Promise<{ added: number; kept: number }> {
  const bundle = JSON.parse(await takeOffer(location.origin, token, offer.id, offer.secret)) as Bundle
  if (bundle?.v !== 1 || !Array.isArray(bundle.channels)) throw new Error("This came from a newer version of Channels. Reload both pages and try again.")
  let added = 0
  let kept = 0
  for (const m of bundle.channels) {
    if (!wellFormed(m)) continue
    if (loadMember(m.code)) {
      kept++
      continue
    }
    saveMember({ ...m, at: m.at || Date.now() })
    added++
  }
  return { added, kept }
}

// The link's secret leaves the address bar at once, and stays out of sign-in's
// return address, which goes to WorkOS: it waits in this tab's session storage.
const STASH = "mc.device-offer"

/** `#device=<id>.<secret>`, or `#device` after it was set aside. */
export function readOfferHash(): Pick<DeviceOffer, "id" | "secret"> | null {
  const fresh = parseOfferHash(location.hash)
  if (fresh) {
    sessionStorage.setItem(STASH, JSON.stringify(fresh))
    history.replaceState(null, "", "/#device")
    return fresh
  }
  if (location.hash !== "#device") return null
  try {
    const o = JSON.parse(sessionStorage.getItem(STASH) ?? "null") as DeviceOffer | null
    return o ? parseOfferHash(`#device=${o.id}.${o.secret}`) : null
  } catch {
    return null
  }
}

export function clearOffer(): void {
  sessionStorage.removeItem(STASH)
}
