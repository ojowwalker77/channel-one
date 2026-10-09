// Cached channel icons. Members read them through the sealed API; everyone else sees a letter.

import { useEffect, useState } from "react"

import { Channel } from "@mc/client.ts"
import type { ChannelIcon } from "@mc/protocol.ts"

import { loadMember, type StoredMember } from "./channel"
import { ICON_LIVE } from "./icon-event"

const CHANGED = "mc-icons"
const keyOf = (room: string) => `mc.icon.${room}`

interface Stored {
  at: number | null
  icon: ChannelIcon | null
}

function read(room: string): Stored | null {
  try {
    return JSON.parse(localStorage.getItem(keyOf(room)) ?? "null") as Stored | null
  } catch {
    return null
  }
}

function write(room: string, stored: Stored): void {
  localStorage.setItem(keyOf(room), JSON.stringify(stored))
  window.dispatchEvent(new Event(CHANGED))
}

/** The icon last seen for this room, or null when it has none. */
export function cachedIcon(room: string): ChannelIcon | null {
  return read(room)?.icon ?? null
}

/** Refetch when iconAt moved. A channel that never had an icon stays a letter. */
export async function refreshIcon(member: StoredMember): Promise<void> {
  const room = member.access.roomId
  const ch = new Channel(member.access, location.origin, member.identity)
  const at = (await ch.info()).iconAt ?? null
  const prev = read(room)
  if (prev && prev.at === at) return
  write(room, { at, icon: at === null ? null : await ch.icon() })
}

function allIcons(): Map<string, ChannelIcon | null> {
  const icons = new Map<string, ChannelIcon | null>()
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith("mc.icon.")) continue
    const room = key.slice("mc.icon.".length)
    icons.set(room, read(room)?.icon ?? null)
  }
  return icons
}

/** Icons for the rooms this browser has cached, updating when one is refetched. */
export function useIcons(): Map<string, ChannelIcon | null> {
  const [icons, setIcons] = useState(allIcons)
  useEffect(() => {
    const bump = () => setIcons(allIcons())
    window.addEventListener(CHANGED, bump)
    return () => window.removeEventListener(CHANGED, bump)
  }, [])
  return icons
}

/** Load icons for the channels this browser is in. Others stay letters. */
export function useMemberIcons(codes: string[]): void {
  const list = codes.join("\n")
  useEffect(() => {
    for (const code of list.split("\n")) {
      if (!code) continue
      const member = loadMember(code)
      if (member) void refreshIcon(member).catch(() => {})
    }
  }, [list])
}

/** The open channel refetches when the relay says the icon changed. */
export function useLiveIcon(member: StoredMember): void {
  useEffect(() => {
    const load = () => void refreshIcon(member).catch(() => {})
    load()
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === member.code) load()
    }
    window.addEventListener(ICON_LIVE, on)
    return () => window.removeEventListener(ICON_LIVE, on)
  }, [member])
}
