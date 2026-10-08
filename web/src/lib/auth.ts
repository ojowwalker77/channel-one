import { createClient, type User } from "@workos-inc/authkit-js"
import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

import { relayConfig } from "@mc/client.ts"

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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<AuthClient | null>(null)
  const [status, setStatus] = useState<Auth["status"]>("loading")
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { workosClientId } = await relayConfig(location.origin).catch(() => ({ workosClientId: null }))
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
    () => ({
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
    }),
    [client, status, user]
  )

  return createElement(AuthContext.Provider, { value }, children)
}

export function useAuth(): Auth {
  return useContext(AuthContext)
}

export function displayName(u: User | null): string {
  if (!u) return ""
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email
}
