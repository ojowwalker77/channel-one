import { useCallback, useEffect, useMemo, useState } from "react"

import { Boundary, Toaster } from "@/components/kit"
import { ComputersModal, LinkComputerPage } from "@/components/computers"
import { AddDeviceModal, TakeChannelsPage } from "@/components/devices"
import { ChannelGate, JoinWithCode, NewChannel, Welcome } from "@/components/onboarding"
import { Sidebar } from "@/components/sidebar"
import { Palette, usePaletteShortcut, type Command } from "@/components/ui/palette"
import { UsageModal } from "@/components/usage"
import { useAuth } from "@/lib/auth"
import { parseHash, useChannelList } from "@/lib/channel"
import { parseLinkHash } from "@/lib/computers"
import { readOfferHash } from "@/lib/devices"
import { formatShort } from "@/lib/format"
import { setAppearance } from "@/lib/theme"
import { useUsage } from "@/lib/usage"
import { cx } from "@/lib/utils"

// The join code (and optionally a signing identity) live in the URL
// fragment, which browsers never send to the server.
function readHash() {
  const parsed = parseHash(location.hash)
  // Don't leave a private key sitting in the address bar or history.
  if (parsed.identity) history.replaceState(null, "", `#${encodeURIComponent(parsed.code)}`)
  return parsed
}

const open = (code: string) => (location.hash = encodeURIComponent(code))

export default function App() {
  const auth = useAuth()
  const [link, setLink] = useState(() => parseLinkHash(location.hash))
  const [offer, setOffer] = useState(readOfferHash)
  const [{ code, identity }, setHash] = useState(readHash)
  const [sheet, setSheet] = useState<"new" | "join" | "computers" | "usage" | "device" | null>(null)
  const rows = useChannelList(auth.status === "signed-in", auth.token)
  const usage = useUsage(auth.status === "signed-in", auth.token)
  const [palette, setPalette] = useState(false)
  usePaletteShortcut(useCallback(() => setPalette(true), []))
  const signedIn = auth.status === "signed-in"
  const commands = useMemo(() => {
    const list: Command[] = rows.map((r) => ({ id: `c-${r.room}`, group: "Channels", label: r.title, hint: r.state === "member" ? formatShort(r.ts) : undefined, keywords: r.recent?.text, run: () => open(r.code) }))
    const act = (id: string, label: string, run: () => void) => list.push({ id, group: "Actions", label, run })
    act("new", "New channel", () => setSheet("new"))
    act("join", "Join with a code", () => setSheet("join"))
    if (signedIn) {
      act("computers", "Your computers", () => setSheet("computers"))
      act("device", "Add a device", () => setSheet("device"))
    }
    if (usage) act("usage", "Usage", () => setSheet("usage"))
    if (auth.status === "signed-out") act("signin", "Sign in", auth.signIn)
    list.push(
      { id: "light", group: "Appearance", label: "Light", run: () => setAppearance("light") },
      { id: "dark", group: "Appearance", label: "Dark", run: () => setAppearance("dark") },
      { id: "system", group: "Appearance", label: "Match system", run: () => setAppearance("system") }
    )
    return list
  }, [rows, signedIn, usage, auth.status, auth.signIn])

  useEffect(() => {
    const onHash = () => {
      setLink(parseLinkHash(location.hash))
      setOffer(readOfferHash())
      setHash(readHash())
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  const close = () => {
    history.replaceState(null, "", location.pathname)
    setHash({ code: "", identity: null })
  }

  return (
    <>
      {offer ? (
        <TakeChannelsPage
          offer={offer}
          onDone={() => {
            history.replaceState(null, "", location.pathname)
            setOffer(null)
          }}
        />
      ) : link ? (
        <LinkComputerPage
          pk={link}
          onDone={() => {
            history.replaceState(null, "", location.pathname)
            setLink(null)
          }}
        />
      ) : (
        <div className="flex h-svh overflow-hidden">
          <Sidebar
            rows={rows}
            active={code}
            onSelect={open}
            onNew={() => setSheet("new")}
            onJoin={() => setSheet("join")}
            onComputers={() => setSheet("computers")}
            onAddDevice={() => setSheet("device")}
            usage={usage}
            onUsage={() => setSheet("usage")}
            onPalette={() => setPalette(true)}
            className={code ? "hidden md:flex" : "flex"}
          />
          <main className={cx("min-w-0 flex-1", code ? "flex" : "hidden md:flex")}>
            {code ? (
              <Boundary resetKey={code}>
                <ChannelGate key={code} code={code} identity={identity} listed={rows.find((r) => r.code === code)} onBack={close} onGone={close} />
              </Boundary>
            ) : (
              <Welcome onNew={() => setSheet("new")} onJoin={() => setSheet("join")} />
            )}
          </main>
        </div>
      )}
      <NewChannel
        open={sheet === "new"}
        usage={usage}
        onClose={() => setSheet(null)}
        onCreated={(c) => {
          setSheet(null)
          open(c)
        }}
      />
      <JoinWithCode
        open={sheet === "join"}
        onClose={() => setSheet(null)}
        onJoin={(c) => {
          setSheet(null)
          open(c)
        }}
      />
      <ComputersModal open={sheet === "computers"} onClose={() => setSheet(null)} />
      {sheet === "device" && <AddDeviceModal onClose={() => setSheet(null)} />}
      <UsageModal open={sheet === "usage"} onClose={() => setSheet(null)} usage={usage} rows={rows} />
      <Palette open={palette} onClose={() => setPalette(false)} commands={commands} />
      <Toaster />
    </>
  )
}
