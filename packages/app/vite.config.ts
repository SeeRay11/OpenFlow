import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "vite"
import desktopPlugin from "./vite"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

// The opencode server the app talks to in dev — same pattern as the Flow canvas
// (packages/flow/vite.config.ts). The browser speaks same-origin; the dev proxy
// forwards /api, /global and /event to the running `opencode serve`, so no CORS
// or password plumbing is needed. Dev-only: production/desktop paths unchanged.
const server = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096"

// The engine may sit behind basic auth (OPENCODE_SERVER_PASSWORD) — same hop as
// the canvas (mirrors `authorize()` in flow/server.ts): this proxy carries the
// password so the browser never sees a login prompt.
const authorized = (() => {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return {}
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  return { headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` } }
})()

const forward = { target: server, changeOrigin: true, ws: false, ...authorized }

export default defineConfig({
  plugins: [desktopPlugin, sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
    proxy: {
      "/api": forward,
      "/global": forward,
      "/event": forward,
    },
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
})
