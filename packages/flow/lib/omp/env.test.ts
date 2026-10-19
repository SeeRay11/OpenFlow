import { describe, expect, test } from "bun:test"
import { filterEnv, terminalEnv } from "./env"

describe("filterEnv", () => {
  test("passes the allowlisted basics and prefixes", () => {
    const host = {
      PATH: "/usr/bin",
      HOME: "/home/a",
      USER: "a",
      LOGNAME: "a",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TERM: "xterm",
      COLORTERM: "truecolor",
      TMPDIR: "/tmp",
      TZ: "UTC",
      XDG_CONFIG_HOME: "/x",
      PI_CODING_AGENT_DIR: "/pi",
      OMP_PROFILE: "work",
      BUN_INSTALL: "/bun",
      NODE_OPTIONS: "--no-warnings",
      GIT_AUTHOR_NAME: "A",
      SSH_AUTH_SOCK: "/sock",
      HTTP_PROXY: "http://p",
      https_proxy: "http://q",
      ALL_PROXY: "socks5://r",
      no_proxy: "localhost",
      SSL_CERT_FILE: "/ca.pem",
      REQUESTS_CA_BUNDLE: "/ca.pem",
    }
    expect(filterEnv(host)).toEqual(host)
  })

  test("passes the Windows basics in any case", () => {
    const host = { SystemRoot: "C:\\Windows", ComSpec: "cmd.exe", PATHEXT: ".EXE", USERPROFILE: "C:\\u", APPDATA: "a", LOCALAPPDATA: "l", Path: "C:\\bin" }
    expect(filterEnv(host)).toEqual(host)
  })

  test("passes provider API keys, since omp resolves providers from the environment", () => {
    const host = { ANTHROPIC_API_KEY: "dummy-a", OPENROUTER_API_KEY: "dummy-o", GOOGLE_VERTEX_API_KEY: "dummy-g", lowercase_api_key: "no" }
    expect(filterEnv(host)).toEqual({ ANTHROPIC_API_KEY: "dummy-a", OPENROUTER_API_KEY: "dummy-o", GOOGLE_VERTEX_API_KEY: "dummy-g" })
  })

  test("drops everything that is not named", () => {
    const host = { PATH: "/bin", AWS_ACCESS_KEY_ID: "x", DATABASE_URL: "postgres://u:p@h/db", EDITOR: "vim", PWD: "/p", FOO: "bar" }
    expect(filterEnv(host)).toEqual({ PATH: "/bin" })
  })

  test("the deny rules beat every allow rule", () => {
    const host = {
      PATH: "/bin",
      SUBSTRATE_TOKEN: "dummy",
      SUBSTRATE_URL: "http://s",
      SUBSTRATE_API_KEY: "dummy",
      SWARM_ED25519_KEY: "dummy",
      SWARM_ROOT: "/swarm",
      ULTRATHINK_ROOT: "/ut",
      AIO_UPLIFT: "1",
      AIO_API_KEY: "dummy",
      ANTHROPIC_OAUTH_TOKEN: "dummy",
      OMP_AUTH_BROKER_TOKEN: "dummy",
      PI_SOME_SECRET: "dummy",
      GIT_ASKPASS_TOKEN: "dummy",
      github_token: "dummy",
      NODE_SECRET: "dummy",
    }
    expect(filterEnv(host)).toEqual({ PATH: "/bin" })
  })

  test("extra is applied on top, and is the only way a denied name gets through", () => {
    const host = { PATH: "/bin", HOME: "/h", SWARM_ED25519_KEY: "from-host" }
    expect(filterEnv(host, { HOME: "/override", SWARM_ED25519_KEY: "explicit", OPENFLOW_RUN: "r1" })).toEqual({
      PATH: "/bin",
      HOME: "/override",
      SWARM_ED25519_KEY: "explicit",
      OPENFLOW_RUN: "r1",
    })
  })

  test("undefined host values are skipped, and the host object is not mutated", () => {
    const host: NodeJS.ProcessEnv = { PATH: "/bin", HOME: undefined }
    const before = { ...host }
    expect(filterEnv(host)).toEqual({ PATH: "/bin" })
    expect(host).toEqual(before)
  })

  test("a variable named like an Object.prototype member is not an allowlist hit", () => {
    const host = JSON.parse('{"constructor":"x","toString":"y","__proto__":"z","PATH":"/bin"}')
    expect(filterEnv(host)).toEqual({ PATH: "/bin" })
  })
})

describe("terminalEnv", () => {
  test("keeps the allowlist, forces a drawable terminal and carries no API keys", () => {
    const host = {
      PATH: "/bin",
      HOME: "/h",
      TERM: "dumb",
      COLORTERM: "",
      LANG: "C",
      ANTHROPIC_API_KEY: "dummy",
      SUBSTRATE_TOKEN: "dummy",
      SWARM_ROOT: "/s",
      FOO: "bar",
    }
    expect(terminalEnv(host)).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C", TERM: "xterm-256color", COLORTERM: "truecolor" })
  })

  test("an API key behind an allowed prefix is still not carried into a shell, while a card keeps it", () => {
    const host = { PATH: "/bin", PI_API_KEY: "dummy", OMP_X_API_KEY: "dummy", PI_THEME: "dark" }
    expect(terminalEnv(host)).toEqual({ PATH: "/bin", PI_THEME: "dark", TERM: "xterm-256color", COLORTERM: "truecolor" })
    expect(filterEnv(host)).toEqual(host)
  })

  test("works for an empty host", () => {
    expect(terminalEnv({})).toEqual({ TERM: "xterm-256color", COLORTERM: "truecolor" })
  })
})
