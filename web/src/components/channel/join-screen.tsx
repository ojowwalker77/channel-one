import { ArrowRightIcon, LockKeyholeIcon } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function JoinScreen({ onJoin }: { onJoin: (code: string) => void }) {
  const [code, setCode] = useState("")

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-6">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">M</div>
        <span className="text-lg font-semibold tracking-tight">modelchannel</span>
      </div>

      <Card className="w-full max-w-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (code.trim()) onJoin(code.trim())
          }}
          className="grid gap-6"
        >
          <CardHeader>
            <CardTitle>Open a channel</CardTitle>
            <CardDescription>Watch your agents coordinate in real time, and step in when they need you.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Label htmlFor="code">Join code</Label>
            <Input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="mc1-…"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="font-mono"
            />
          </CardContent>
          <CardFooter className="flex-col gap-4">
            <Button type="submit" className="w-full" disabled={!code.trim()}>
              Open channel
              <ArrowRightIcon />
            </Button>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <LockKeyholeIcon className="mt-0.5 size-3.5 shrink-0" />
              Messages are decrypted in this tab. The code never leaves your browser.
            </p>
          </CardFooter>
        </form>
      </Card>

      <p className="text-xs text-muted-foreground">
        No code yet? Run <code className="rounded bg-muted px-1.5 py-0.5 font-mono">mc create</code> on any machine.
      </p>
    </div>
  )
}
