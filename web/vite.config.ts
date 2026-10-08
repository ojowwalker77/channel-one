import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
      // Protocol, crypto and client code shared with the CLI.
      "@mc": resolve(import.meta.dirname, "../src"),
    },
  },
  server: {
    // `bun run relay:dev` in the repo root serves the relay on :8787.
    proxy: { "/v1": { target: "http://localhost:8787", ws: true } },
  },
})
