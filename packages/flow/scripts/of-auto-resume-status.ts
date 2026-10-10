/**
 * of-auto-resume-status.ts — Ledger-Auswertung für ~/.openflow/auto-resume.jsonl
 * (Design §2.5: wie viele Resumes, wie viele Karten dadurch gerettet).
 * Aufruf: bun packages/flow/scripts/of-auto-resume-status.ts [ledger-pfad]
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"

const path =
  process.argv[2] ??
  process.env.OPENFLOW_AUTO_RESUME_LEDGER ??
  `${homedir()}/.openflow/auto-resume.jsonl`

if (!existsSync(path)) {
  console.log(`kein Ledger unter ${path} — noch keine Auto-Resumes gelaufen`)
  process.exit(0)
}

let resumes = 0
let exhausted = 0
let last = ""
const sessions = new Set<string>()

for (const line of readFileSync(path, "utf8").split("\n")) {
  if (!line.trim()) continue
  try {
    const e = JSON.parse(line)
    last = typeof e.ts === "string" ? e.ts : last
    if (e.event === "resume") {
      resumes++
      if (typeof e.sessionID === "string") sessions.add(e.sessionID)
    } else if (e.event === "budget_exhausted") {
      exhausted++
    }
  } catch {}
}

console.log(`Auto-Resume Ledger: ${path}`)
console.log(`  Resumes gesamt:   ${resumes}`)
console.log(`  Gerettete Karten: ${sessions.size} (Sessions mit ≥ 1 Resume)`)
console.log(`  Budget erschöpft: ${exhausted}`)
console.log(`  Letzter Eintrag:  ${last || "—"}`)
