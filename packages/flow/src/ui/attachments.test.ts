import { describe, expect, test } from "bun:test"
import { ATTACHMENT_BUDGET, MAX_ATTACHMENT, planAttachments } from "./attachments"

const MB = 1024 * 1024

/**
 * Attachments ride inline in the pipeline JSON as base64, so the total is what
 * decides whether the pipeline can still be saved — a per-file limit alone lets
 * two legal files add up to a body the host refuses.
 */
describe("attachment budget", () => {
  test("the total budget stays clear of the 8 MB host body cap once base64 inflates it", () => {
    expect((ATTACHMENT_BUDGET * 4) / 3).toBeLessThan(8 * MB)
    expect(MAX_ATTACHMENT).toBeLessThanOrEqual(ATTACHMENT_BUDGET)
  })

  test("counts what is already attached, not just this batch", () => {
    const plan = planAttachments(4 * MB, [{ name: "notes.pdf", size: 2 * MB }])
    expect(plan.accepted).toEqual([])
    expect(plan.errors[0].name).toBe("notes.pdf")
    expect(plan.errors[0].reason).toBe(
      "2.0 MB would pass the 5.0 MB total attachment limit — 4.0 MB is already attached. Remove an attachment before adding this one.",
    )
  })

  test("accumulates within one batch, so two legal files cannot together cross the cap", () => {
    const plan = planAttachments(0, [
      { name: "a.pdf", size: 3 * MB },
      { name: "b.pdf", size: 3 * MB },
    ])
    expect(plan.accepted.map((file) => file.name)).toEqual(["a.pdf"])
    expect(plan.errors[0].reason).toContain("3.0 MB is already attached")
  })

  test("a later small file still fits after a big one is refused", () => {
    const plan = planAttachments(0, [
      { name: "big.pdf", size: 4 * MB },
      { name: "huge.pdf", size: 4 * MB },
      { name: "small.png", size: 512 * 1024 },
    ])
    expect(plan.accepted.map((file) => file.name)).toEqual(["big.pdf", "small.png"])
    expect(plan.errors).toHaveLength(1)
  })

  test("the per-file limit is reported separately from the total", () => {
    const plan = planAttachments(0, [{ name: "video.mp4", size: 6 * MB }])
    expect(plan.accepted).toEqual([])
    expect(plan.errors[0].reason).toBe("6.0 MB is over the 4.0 MB per-file limit")
  })

  test("a pasted blob with no name is still named in the refusal", () => {
    const plan = planAttachments(5 * MB, [{ name: "", size: 1024 }])
    expect(plan.errors[0].name).toBe("pasted file")
  })
})
