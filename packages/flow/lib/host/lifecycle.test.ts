import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { engineRoutes, sessionRoute } from "../../shared/engine"
import { resetOmpCheck } from "../omp/binary"
import { createHost, type Host } from "./index"
import { createLifecycle } from "./lifecycle"

describe("lifecycle", () => {
  test("a closed lifecycle refuses new work with a 503 and never starts it", async () => {
    const life = createLifecycle("test")
    await life.dispose()
    let started = false
    const refused = await life
      .run(async () => {
        started = true
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(refused).toMatchObject({ status: 503, code: "host-closed" })
    expect(started).toBe(false)
    expect(() => life.assertOpen()).toThrow()
  })

  test("dispose runs the stop of each flight in progress and waits for what it returns and for the flight to settle", async () => {
    const life = createLifecycle("test")
    const gone = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<string>()
    const events: string[] = []
    const flight = life.run((scope) => {
      scope.onClose(() => {
        events.push("stop")
        return gone.promise
      })
      return finish.promise
    })
    const disposing = life.dispose().then(() => events.push("disposed"))
    await Promise.resolve()
    expect(events).toEqual(["stop"])
    gone.resolve()
    finish.resolve("done")
    await disposing
    expect(await flight).toBe("done")
    expect(events).toEqual(["stop", "disposed"])
  })

  test("a stop registered after the lifecycle closed runs at once, and a stop that throws does not stop the others", async () => {
    const life = createLifecycle("test")
    const stopped: string[] = []
    let late: (() => void) | undefined
    const flight = life.run((scope) => {
      scope.onClose(() => {
        throw new Error("already gone")
      })
      scope.onClose(() => stopped.push("second"))
      late = () => scope.onClose(() => stopped.push("late"))
      return Promise.resolve("ok")
    })
    await flight
    await life.dispose()
    expect(stopped).toEqual([])
    late?.()
    await Promise.resolve()
    expect(stopped).toEqual(["late"])
  })

  test("dispose is idempotent", async () => {
    const life = createLifecycle("test")
    const first = life.dispose()
    expect(life.dispose()).toBe(first)
    await first
  })
})

// The omp stand-in is a `#!/bin/sh` script wrapping the RPC stub, and the host's children are POSIX process groups: nothing here runs on Windows.
const posix = describe.skipIf(process.platform === "win32")

posix("the host's reach into the project", () => {
  let dir: string
  let project: string
  let host: Host
  let previousState: string | undefined

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "flow-lock-")))
    project = path.join(dir, "project")
    const bin = path.join(dir, "bin")
    mkdirSync(project)
    mkdirSync(bin)
    writeFileSync(path.join(dir, "script.json"), "[]")
    const stub = path.join(import.meta.dir, "..", "omp", "testing", "stub-omp.ts")
    writeFileSync(
      path.join(bin, "omp"),
      [
        "#!/bin/sh",
        'case " $* " in *" --version "*) echo "omp/18.12.2"; exit 0;; esac',
        `case " $* " in *" config path "*) echo "${path.join(dir, "profile")}"; exit 0;; esac`,
        `export STUB_OMP_SCRIPT="${path.join(dir, "script.json")}"`,
        `exec "${process.execPath}" "${stub}" "$@"`,
        "",
      ].join("\n"),
    )
    chmodSync(path.join(bin, "omp"), 0o755)
    previousState = process.env.OPENFLOW_STATE_DIR
    resetOmpCheck()
    host = createHost({
      project: () => project,
      allowRemote: false,
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: dir, OPENFLOW_STATE_DIR: path.join(dir, "state") },
    })
  })

  afterAll(async () => {
    await host.dispose()
    resetOmpCheck()
    if (previousState === undefined) delete process.env.OPENFLOW_STATE_DIR
    else process.env.OPENFLOW_STATE_DIR = previousState
    rmSync(dir, { recursive: true, force: true })
  })

  const call = (route: string, method: string, body?: unknown) =>
    host.handle(
      new Request(`http://127.0.0.1${route}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    ) as Promise<Response>

  test("an idle live session does not lock the project; a running turn does, names its session, and is freed by deleting it", async () => {
    expect(host.projectLocked()).toBe(false)
    const created = await call(engineRoutes.sessions, "POST", { runId: "run-1", nodeId: "n1", card: { key: "card-1", role: "Builder" }, directory: project, permissions: "auto" })
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }
    expect(host.projectLocked()).toBe(false)
    expect(host.projectHolders()).toEqual([])

    // The stub holds a turn open until it is aborted.
    writeFileSync(path.join(dir, "script.json"), JSON.stringify([{ hang: true }]))
    expect((await call(sessionRoute(id, "/prompt"), "POST", { text: "go" })).status).toBeLessThan(300)
    expect(host.projectLocked()).toBe(true)
    expect(host.projectHolders()).toEqual([id])

    expect((await call(sessionRoute(id, ""), "DELETE")).status).toBe(200)
    expect(host.projectLocked()).toBe(false)
    expect(host.projectHolders()).toEqual([])
  })

  test("after dispose the host refuses probes with a 503 and answers a late event stream with an empty closed one", async () => {
    await host.dispose()
    expect((await call(engineRoutes.health, "GET")).status).toBe(503)
    expect((await call(engineRoutes.models, "GET")).status).toBe(503)

    const stream = await call(engineRoutes.events, "GET")
    expect(stream.headers.get("content-type")).toContain("text/event-stream")
    const reader = stream.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    expect((await reader.read()).done).toBe(true)
  })
})
