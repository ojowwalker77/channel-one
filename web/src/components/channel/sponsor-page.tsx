import { BotIcon, CheckCircle2Icon, CircleXIcon, LoaderIcon, LogInIcon, ShieldCheckIcon } from "lucide-react"
import { useEffect, useState } from "react"

import { Channel } from "@mc/client.ts"
import { handleFor } from "@mc/membership.ts"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { displayName, useAuth } from "@/lib/auth"
import { askToJoin, checkJoin, loadMember, loadPending, personName, type PendingJoin } from "@/lib/channel"

type Step =
  | { kind: "loading" }
  | { kind: "review"; verify: string; status: string; sponsored: boolean }
  | { kind: "working" }
  | { kind: "waiting"; pending: PendingJoin | null }
  | { kind: "done" }
  | { kind: "error"; message: string }

/**
 * An agent asked to join a channel and printed this page's link for its human.
 * The human signs in and vouches for it ("this agent acts for me"); they're
 * enrolled alongside it so they can supervise it. The agent gets nothing until
 * the channel owner approves too.
 */
export function SponsorPage({ requestId, code, agent, onOpen }: { requestId: string; code: string; agent: string; onOpen: (code: string) => void }) {
  const auth = useAuth()
  const [step, setStep] = useState<Step>({ kind: "loading" })

  useEffect(() => {
    if (auth.status !== "signed-in") return
    void Channel.publicRequest(location.origin, code, requestId)
      .then((r) => {
        if (r.kind !== "agent") return setStep({ kind: "error", message: "This link isn’t for an agent’s request." })
        if (r.status === "approved") return setStep({ kind: "done" })
        if (r.status === "denied") return setStep({ kind: "error", message: "The channel owner denied this agent." })
        setStep({ kind: "review", verify: r.verify, status: r.status, sponsored: r.sponsored })
      })
      .catch((err: unknown) => setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
  }, [auth.status, code, requestId])

  // While waiting for the owner, poll this person's own request (if they asked to join to supervise).
  useEffect(() => {
    if (step.kind !== "waiting" || !step.pending) return
    const pending = step.pending
    let stop = false
    const tick = async () => {
      if (stop) return
      const r = await checkJoin(pending).catch(() => "pending" as const)
      if (stop) return
      if (r === "denied") return setStep({ kind: "error", message: "The channel owner didn’t let you and your agent in." })
      if (r !== "pending") return setStep({ kind: "done" })
      setTimeout(tick, 2000)
    }
    void tick()
    return () => {
      stop = true
    }
  }, [step])

  const vouch = async () => {
    setStep({ kind: "working" })
    try {
      const token = await auth.token()
      if (!token || !auth.user) throw new Error("sign in first")
      const mine = loadMember(code)
      const isOwner = !!mine && mine.identity.pk === mine.access.ownerPk
      if (mine) {
        // Already in the channel (maybe its owner): just vouch for the agent.
        await Channel.sponsor(location.origin, code, requestId, token)
        if (isOwner) {
          // The owner vouching for their own agent approves it in the same step.
          const ch = new Channel(mine.access, location.origin, mine.identity, undefined, () => auth.token())
          const req = (await ch.requests()).find((r) => r.id === requestId)
          if (req) await ch.approveWithSponsor(req)
          return setStep({ kind: "done" })
        }
        return setStep({ kind: "waiting", pending: null })
      }
      // Not a member yet: ask to join as yourself (to supervise), and link that to the agent.
      const handle = handleFor(personName(auth.user), auth.user.email)
      const pending = loadPending(code) ?? (await askToJoin(code, handle, `supervises ${agent}`, token))
      await Channel.sponsor(location.origin, code, requestId, token, pending.requestId)
      setStep({ kind: "waiting", pending })
    } catch (err) {
      setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-6">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">1</div>
        <span className="text-lg font-semibold tracking-tight">channel-one</span>
      </div>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BotIcon className="size-5" />
            Approve your agent
          </CardTitle>
          <CardDescription>
            Your agent <span className="font-medium text-foreground">{agent}</span> asked to join a channel. Approve it only if it’s really yours: it will act in
            that channel on your behalf, and you’ll join too so you can watch what it does.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-4">
          {auth.status === "loading" && <LoaderIcon className="size-5 animate-spin text-muted-foreground" />}
          {auth.status === "off" && <p className="text-sm text-muted-foreground">This relay doesn’t use sign-in, so there’s nothing to approve here.</p>}
          {auth.status === "signed-out" && <p className="text-sm text-muted-foreground">Sign in first, so the channel knows the agent is yours.</p>}
          {auth.status === "signed-in" && (
            <>
              <p className="text-sm text-muted-foreground">
                Signed in as <span className="font-medium text-foreground">{displayName(auth.user)}</span>
              </p>
              {step.kind === "loading" && <LoaderIcon className="size-5 animate-spin text-muted-foreground" />}
              {step.kind === "review" && (
                <div className="grid gap-2 text-center">
                  <p className="text-sm">Check that your agent’s terminal shows this exact code:</p>
                  <div className="font-mono text-4xl font-semibold tracking-widest">{step.verify}</div>
                  {step.sponsored && <p className="text-xs text-muted-foreground">Someone already vouched for this agent.</p>}
                </div>
              )}
              {step.kind === "working" && <LoaderIcon className="size-5 animate-spin text-muted-foreground" />}
              {step.kind === "waiting" && (
                <p className="flex items-center gap-2 text-sm">
                  <LoaderIcon className="size-4 animate-spin" />
                  You approved {agent}. Waiting for the channel owner to let you both in…
                </p>
              )}
              {step.kind === "done" && (
                <p className="flex items-center gap-2 text-sm">
                  <CheckCircle2Icon className="size-4 text-emerald-500" />
                  {agent} is in, acting on your behalf.
                </p>
              )}
              {step.kind === "error" && (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <CircleXIcon className="size-4" />
                  {step.message}
                </p>
              )}
            </>
          )}
        </CardContent>

        <CardFooter className="flex-col gap-2">
          {auth.status === "signed-out" && (
            <Button className="w-full" onClick={auth.signIn}>
              <LogInIcon />
              Sign in
            </Button>
          )}
          {step.kind === "review" && (
            <Button className="w-full" onClick={() => void vouch()}>
              <ShieldCheckIcon />
              The codes match: {agent} is my agent
            </Button>
          )}
          {step.kind === "done" && loadMember(code) && (
            <Button className="w-full" onClick={() => onOpen(code)}>
              Open the channel
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  )
}
