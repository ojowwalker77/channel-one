import { useEffect, useState } from "react"

import { ChannelView } from "@/components/channel/channel-view"
import { JoinScreen } from "@/components/channel/join-screen"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

// The join code lives in the URL fragment, which browsers never send to the server.
const codeFromHash = () => decodeURIComponent(location.hash.slice(1)).trim()

export default function App() {
  const [code, setCode] = useState(codeFromHash)

  useEffect(() => {
    const onHash = () => setCode(codeFromHash())
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      {code ? (
        <ChannelView
          key={code}
          code={code}
          onLeave={() => {
            history.replaceState(null, "", location.pathname)
            setCode("")
          }}
        />
      ) : (
        <JoinScreen onJoin={(c) => (location.hash = encodeURIComponent(c))} />
      )}
      <Toaster position="top-center" />
    </TooltipProvider>
  )
}
