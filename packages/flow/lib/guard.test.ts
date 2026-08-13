import { describe, expect, test } from "bun:test"
import { allowsRemote, isLoopback, remoteBindRefusal } from "./guard"

describe("isLoopback", () => {
  test("treats vite's defaults as local", () => {
    // undefined and false are what vite uses when --host is not passed.
    expect(isLoopback(undefined)).toBe(true)
    expect(isLoopback(false)).toBe(true)
  })

  test("knows the loopback names", () => {
    for (const host of ["127.0.0.1", "::1", "[::1]", "localhost", "LOCALHOST", " localhost "]) {
      expect(isLoopback(host)).toBe(true)
    }
  })

  test("treats anything else as exposed", () => {
    for (const host of [true, "0.0.0.0", "::", "192.168.1.10", "10.0.0.4", "example.com"]) {
      expect(isLoopback(host as any)).toBe(false)
    }
  })
})

describe("remoteBindRefusal", () => {
  const project = "/home/me/repo"

  test("says nothing about a loopback bind", () => {
    expect(remoteBindRefusal({ host: undefined, project, env: {} })).toBeUndefined()
    expect(remoteBindRefusal({ host: "127.0.0.1", project, env: {} })).toBeUndefined()
  })

  test("refuses an exposed bind, naming the project it would expose", () => {
    const refusal = remoteBindRefusal({ host: "0.0.0.0", project, env: {} })
    expect(refusal).toContain("0.0.0.0")
    expect(refusal).toContain(project)
    expect(refusal).toContain("FLOW_ALLOW_REMOTE=1")
  })

  test("describes vite's --host as every interface", () => {
    expect(remoteBindRefusal({ host: true, project, env: {} })).toContain("every interface")
  })

  test("lets it through when it was asked for explicitly", () => {
    expect(remoteBindRefusal({ host: "0.0.0.0", project, env: { FLOW_ALLOW_REMOTE: "1" } })).toBeUndefined()
  })

  test("only the exact opt-in counts", () => {
    for (const value of ["true", "yes", "0", ""]) {
      expect(allowsRemote({ FLOW_ALLOW_REMOTE: value })).toBe(false)
      expect(remoteBindRefusal({ host: "0.0.0.0", project, env: { FLOW_ALLOW_REMOTE: value } })).toBeDefined()
    }
  })
})
