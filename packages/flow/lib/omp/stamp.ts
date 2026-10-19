import { stat } from "node:fs/promises"
import path from "node:path"

/**
 * A cheap fingerprint of a profile's stored logins. omp keeps them in
 * `agent.db` (plus its write-ahead log) inside the profile's config directory,
 * so a login, a logout or an `auth import` anywhere changes that file's mtime
 * or size. Cached answers that depend on the logins (the model catalog, the
 * provider list) fold the stamp into their key, so they notice changes the host
 * never heard about, such as `/login` typed in the terminal.
 */

/** What to call before every cached read: resolves the profile's current stamp. */
export type CredentialStamp = () => Promise<string>

const FILES = ["agent.db", "agent.db-wal"]

async function part(file: string): Promise<string> {
  const info = await stat(file).catch(() => undefined)
  return info ? `${info.mtimeMs}:${info.size}` : ""
}

/** `mtimeMs:size` of each credential file in `dir`, joined; a missing file or directory contributes an empty part. */
export async function credentialStamp(dir: string | undefined): Promise<string> {
  if (!dir) return ""
  return (await Promise.all(FILES.map((name) => part(path.join(dir, name))))).join("|")
}

/** The stamp, or the empty stamp when none is wired or it fails: a broken stamp must never break the read it guards. */
export async function readStamp(stamp: CredentialStamp | undefined): Promise<string> {
  try {
    return (await stamp?.()) ?? ""
  } catch {
    return ""
  }
}
