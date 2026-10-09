import { createClient, type User } from "@workos-inc/authkit-js"
import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

import { relayConfig } from "@mc/client.ts"

import { DevSignIn } from "@/components/dev-sign-in"

/**
 * Human sign-in with WorkOS AuthKit (authorization code + PKCE, all in the
 * browser). When the relay advertises a WorkOS client, channels are created and
 * run by signed-in humans; otherwise sign-in is simply off.
 */

type AuthClient = Awaited<ReturnType<typeof createClient>>

export interface Auth {
  /** "off": the relay doesn't use sign-in. */
  status: "loading" | "off" | "signed-out" | "signed-in"
  user: User | null
  signIn: () => void
  signOut: () => void
  /** A fresh access token for owner actions, or null when not signed in. */
  token: () => Promise<string | null>
}

const AuthContext = createContext<Auth>({
  status: "loading",
  user: null,
  signIn: () => {},
  signOut: () => {},
  token: async () => null,
})

/** Only return to same-origin locations after the redirect (the state isn't integrity-protected). */
function safeReturn(state: unknown): string {
  const raw = (state as { returnTo?: unknown } | undefined)?.returnTo
  if (typeof raw !== "string") return "/"
  try {
    const url = new URL(raw, location.origin)
    return url.origin === location.origin ? url.pathname + url.hash : "/"
  } catch {
    return "/"
  }
}

// Dev sign-in (a local relay run with --dev-sign-in): the name you give, kept in this browser.
const DEV_KEY = "mc.dev-user"

/** The user a dev name stands for: dev_<name> to the relay, shown with "(dev)" so nobody mistakes it for a real sign-in. */
function devUser(name: string): User {
  return { id: `dev_${name}`, email: `${name}@dev.invalid`, firstName: `${name} (dev)`, lastName: null } as unknown as User
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<AuthClient | null>(null)
  const [status, setStatus] = useState<Auth["status"]>("loading")
  const [user, setUser] = useState<User | null>(null)
  const [dev, setDev] = useState<{ name: string | null; asking: boolean } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const config: { workosClientId: string | null; dev?: boolean } = await relayConfig(location.origin).catch(() => ({ workosClientId: null }))
      const { workosClientId } = config
      if (config.dev) {
        if (cancelled) return
        const name = localStorage.getItem(DEV_KEY)
        setDev({ name, asking: false })
        setUser(name ? devUser(name) : null)
        setStatus(name ? "signed-in" : "signed-out")
        return
      }
      if (!workosClientId) {
        if (!cancelled) setStatus("off")
        return
      }
      const c = await createClient(workosClientId, {
        redirectUri: `${location.origin}/auth/callback`,
        // No custom auth domain on workers.dev, so the refresh token lives in this browser's storage.
        devMode: true,
        // Back from sign-in: restore the page the person was on (say, an agent's vouch link). Changing the
        // address this way doesn't fire hashchange, so announce it, or the app keeps showing the old page.
        onRedirectCallback: ({ state }) => {
          history.replaceState(null, "", safeReturn(state))
          window.dispatchEvent(new HashChangeEvent("hashchange"))
        },
        onRefresh: ({ user }) => setUser(user),
      })
      if (cancelled) return c.dispose()
      // Landed on the callback without a code (or it failed): don't stay on /auth/callback.
      if (location.pathname === "/auth/callback") {
        history.replaceState(null, "", "/" + location.hash)
        window.dispatchEvent(new HashChangeEvent("hashchange"))
      }
      setClient(c)
      const u = c.getUser()
      setUser(u)
      setStatus(u ? "signed-in" : "signed-out")
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo<Auth>(
    () =>
      dev
        ? {
            status,
            user,
            signIn: () => setDev((d) => d && { ...d, asking: true }),
            signOut: () => {
              localStorage.removeItem(DEV_KEY)
              setDev({ name: null, asking: false })
              setUser(null)
              setStatus("signed-out")
            },
            token: async () => (dev.name ? `dev:${dev.name}` : null),
          }
        : {
            status,
            user,
            signIn: () => void client?.signIn({ state: { returnTo: location.pathname + location.hash } }),
            signOut: () => client?.signOut({ returnTo: location.origin + "/" }),
            token: async () => {
              if (!client || !client.getUser()) return null
              try {
                return await client.getAccessToken()
              } catch {
                return null
              }
            },
          },
    [client, status, user, dev]
  )

  const signInDev = (name: string) => {
    localStorage.setItem(DEV_KEY, name)
    setDev({ name, asking: false })
    setUser(devUser(name))
    setStatus("signed-in")
  }
  return createElement(
    AuthContext.Provider,
    { value },
    children,
    dev ? createElement(DevSignIn, { open: dev.asking, onClose: () => setDev((d) => d && { ...d, asking: false }), onSignIn: signInDev }) : null
  )
}

export function useAuth(): Auth {
  return useContext(AuthContext)
}

export function displayName(u: User | null): string {
  if (!u) return ""
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email
}
