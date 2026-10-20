import os from "node:os"
import path from "node:path"

const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/

export function dataDir(env: NodeJS.ProcessEnv = process.env) {
  const set = env.AUTONOGRAMMER_DATA_DIR
  if (set && set.trim()) return path.resolve(set)
  return path.join(os.homedir(), ".autonogrammer")
}

export function safeCardId(cardId: string) {
  if (!CARD_ID.test(cardId)) throw new Error("card id must be 1-81 letters, digits, underscores, or hyphens")
  return cardId
}

export function cardVolumePath(cardId: string, env: NodeJS.ProcessEnv = process.env) {
  return path.join(dataDir(env), "agentos", `${safeCardId(cardId)}.sqlite`)
}
