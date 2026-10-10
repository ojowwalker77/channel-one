import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { Boundary } from "@/components/kit"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AuthProvider } from "@/lib/auth"
import { noteSignInGone } from "@/lib/session"
import { applyStoredAppearance } from "@/lib/theme"

applyStoredAppearance()

// A call nobody caught that failed because the sign-in ended: ask to sign in again, quietly.
window.addEventListener("unhandledrejection", (e) => {
  if (noteSignInGone(e.reason)) e.preventDefault()
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boundary whole>
      <AuthProvider>
        <TooltipProvider delay={500}>
          <App />
        </TooltipProvider>
      </AuthProvider>
    </Boundary>
  </StrictMode>
)
