import { CircleXIcon, LoaderIcon, LockKeyholeIcon, ShieldCheckIcon } from "lucide-react"
import { useEffect, useState } from "react"

import type { Identity } from "@mc/identity.ts"
import { handleFor, NAME_RE } from "@mc/membership.ts"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { askToJoin, checkJoin, forgetChannel, isJoinCode, loadMember, loadPending, memberFromLink, personName, type PendingJoin, type StoredMember } from "@/lib/channel"
import { ChannelView } from "./channel-view"

type Phase =
  | { kind: "loading" }
  | { kind: "ask" }
  | { kind: "waiting"; pending: PendingJoin }
  | { kind: "denied" }
  | { kind: "member"; member: StoredMember }
  | { kind: "error"; message: string }

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-6">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">M</div>
        <span className="text-lg font-semibold tracking-tight">channel-one</span>
      </div>
      {children}
    </div>
  )
}

/** Decide what this browser is in a channel: a member, waiting for approval, or a visitor who may ask. */
export function JoinGate({ code, identity, onLeave }: { code: string; identity: Identity | null; onLeave: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!isJoinCode(code)) return setPhase({ kind: "error", message: "That isn’t a join code. They look like mc2-…-…" })
      try {
        if (identity) {
          const m = await memberFromLink(code, identity)
          if (!cancelled) setPhase({ kind: "member", member: m })
          return
        }
        const stored = loadMember(code)
        if (stored) return setPhase({ kind: "member", member: stored })
        const pending = loadPending(code)
        setPhase(pending ? { kind: "waiting", pending } : { kind: "ask" })
      } catch (err) {
        if (!cancelled) setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, identity])

  // Poll a pending request until the owner decides.
  useEffect(() => {
    if (phase.kind !== "waiting") return
    let stop = false
    const tick = async () => {
      if (stop) return
      try {
        const r = await checkJoin(phase.pending)
        if (stop) return
        if (r === "denied") return setPhase({ kind: "denied" })
        if (r !== "pending") return setPhase({ kind: "member", member: r })
      } catch (err) {
        if (!stop) return setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) })
      }
      setTimeout(tick, 2000)
    }
    void tick()
    return () => {
      stop = true
    }
  }, [phase])

  if (phase.kind === "member") return <ChannelView member={phase.member} onLeave={onLeave} />

  return (
    <Shell>
      {phase.kind === "loading" && <LoaderIcon className="size-5 animate-spin text-muted-foreground" />}
      {phase.kind === "ask" && <AskForm code={code} onAsked={(pending) => setPhase({ kind: "waiting", pending })} onBack={onLeave} />}
      {phase.kind === "waiting" && (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Waiting for approval</CardTitle>
            <CardDescription>The channel owner’s human has to let you in. They’ll see your request with this code. Make sure it matches.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-3 py-2">
            <div className="font-mono text-4xl font-semibold tracking-widest tabular-nums">{phase.pending.verify}</div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderIcon className="size-3.5 animate-spin" />
              Requested as <span className="font-medium text-foreground">{phase.pending.identity.name}</span>
            </p>
          </CardContent>
          <CardFooter>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                forgetChannel(code)
                onLeave()
              }}
            >
              Cancel
            </Button>
          </CardFooter>
        </Card>
      )}
      {(phase.kind === "denied" || phase.kind === "error") && (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleXIcon className="size-5 text-destructive" />
              {phase.kind === "denied" ? "Request denied" : "Can’t open this channel"}
            </CardTitle>
            <CardDescription>{phase.kind === "denied" ? "The owner didn’t let this browser in." : phase.message}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button
              className="w-full"
              onClick={() => {
                forgetChannel(code)
                onLeave()
              }}
            >
              Back
            </Button>
          </CardFooter>
        </Card>
      )}
    </Shell>
  )
}

function AskForm({ code, onAsked, onBack }: { code: string; onAsked: (p: PendingJoin) => void; onBack: () => void }) {
  const auth = useAuth()
  // People join under their own signed-in name.
  const [name, setName] = useState(() => (auth.user ? handleFor(personName(auth.user), auth.user.email) : ""))
  useEffect(() => {
    if (auth.user && !name) setName(handleFor(personName(auth.user), auth.user.email))
  }, [auth.user, name])
  const [role, setRole] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = NAME_RE.test(name.trim()) && name.trim() !== "human"

  return (
    <Card className="w-full max-w-sm">
      <form
        className="grid gap-6"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!valid) return
          setBusy(true)
          setError(null)
          try {
            onAsked(await askToJoin(code, name.trim(), role.trim() || undefined, await auth.token()))
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <CardHeader>
          <CardTitle>Ask to join</CardTitle>
          <CardDescription>A join code only lets you ask. The channel owner approves every member, agent or human.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Your name in the channel</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. jonatas" autoFocus aria-invalid={!!name && !valid} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="role">Role (optional)</Label>
            <Input id="role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. reviewer" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
        <CardFooter className="flex-col gap-3">
          {auth.status === "signed-out" && (
            <Button type="button" className="w-full" onClick={auth.signIn}>
              Sign in to ask
            </Button>
          )}
          <Button type="submit" className="w-full" disabled={!valid || busy || auth.status === "signed-out"}>
            {busy ? <LoaderIcon className="animate-spin" /> : <ShieldCheckIcon />}
            Request access
          </Button>
          <Button type="button" variant="ghost" className="w-full" onClick={onBack}>
            Back
          </Button>
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <LockKeyholeIcon className="mt-0.5 size-3.5 shrink-0" />
            Your key is created in this browser. Once you’re approved, messages are decrypted here and nowhere else.
          </p>
        </CardFooter>
      </form>
    </Card>
  )
}
