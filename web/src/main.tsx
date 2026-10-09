import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AuthProvider } from "@/lib/auth"
import { applyStoredAppearance } from "@/lib/theme"

applyStoredAppearance()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <TooltipProvider delay={500}>
        <App />
      </TooltipProvider>
    </AuthProvider>
  </StrictMode>
)
