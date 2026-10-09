import { useSyncExternalStore } from "react"

// Light, dark, or whatever the system says. The choice is per browser, and
// "system" leaves <html> without data-theme so the CSS media query decides.

export type Appearance = "system" | "light" | "dark"

const KEY = "mc.appearance"
const listeners = new Set<() => void>()

function read(): Appearance {
  const v = localStorage.getItem(KEY)
  return v === "light" || v === "dark" ? v : "system"
}

function apply(a: Appearance) {
  if (a === "system") delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = a
}

export function setAppearance(a: Appearance) {
  if (a === "system") localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, a)
  apply(a)
  for (const l of listeners) l()
}

/** Run once before the first render, so the page never paints in the wrong theme. */
export function applyStoredAppearance() {
  apply(read())
}

export function useAppearance(): Appearance {
  return useSyncExternalStore((l) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }, read)
}
