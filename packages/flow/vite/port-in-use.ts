/**
 * What to print when the canvas port is already held.
 *
 * Neither host slides to a free port — vite runs with `strictPort` and the
 * built host binds a fixed `FLOW_PORT` — because both READMEs document one URL
 * and a silent relocation makes that URL a lie. So an occupied port is a stop,
 * and a stop is only useful if it says what to do next.
 *
 * Shared by the vite dev server and `server.ts` so the two hosts cannot drift
 * into two different explanations of the same failure.
 */
export function portInUse(port: number, url: string) {
  const holder =
    process.platform === "win32"
      ? `  netstat -ano | findstr :${port}\n  taskkill /pid <pid> /T /F`
      : `  lsof -ti tcp:${port}\n  kill -9 <pid>`
  return [
    `port ${port} is already in use, so OpenFlow cannot start.`,
    ``,
    `If another OpenFlow is already serving it, nothing is wrong — open ${url}.`,
    ``,
    `Otherwise start OpenFlow with the launcher, which frees a stale holder and`,
    `reuses a live one:`,
    `  bun openflow.ts`,
    ``,
    `Or find the process holding the port yourself:`,
    holder,
  ].join("\n")
}
