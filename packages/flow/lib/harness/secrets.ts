import fs from "node:fs/promises"
import path from "node:path"
import { dataDir } from "../agentos/paths"

const SECRET = /token|secret|password|api[-_]?key|authorization|credential/i

export function redactSecrets(value: unknown): { clean: unknown; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {}
  const walk = (node: unknown, prefix: string): unknown => {
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${prefix}${index}.`))
    if (typeof node !== "object" || node === null) return node
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(node)) {
      if (SECRET.test(key) && (typeof child === "string" || typeof child === "number")) {
        secrets[`${prefix}${key}`] = String(child)
        continue
      }
      out[key] = walk(child, `${prefix}${key}.`)
    }
    return out
  }
  return { clean: walk(value, ""), secrets }
}

export function secretsPath(env: NodeJS.ProcessEnv = process.env) {
  return path.join(dataDir(env), "secrets.json")
}

export async function writeSecrets(secrets: Record<string, string>, env: NodeJS.ProcessEnv = process.env) {
  const file = secretsPath(env)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const next = { ...(await readSecrets(env)), ...secrets }
  await fs.writeFile(file, JSON.stringify(next), { mode: 0o600 })
  await fs.chmod(file, 0o600)
  return file
}

export async function readSecrets(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(secretsPath(env), "utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") out[key] = value
    return out
  } catch {
    return {}
  }
}
