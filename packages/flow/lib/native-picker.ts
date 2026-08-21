import { spawn } from "node:child_process"
import fs from "node:fs"

/**
 * Opens the operating system's own folder chooser, on the host.
 *
 * The in-app browser ([./store.ts] `browseDirectory`) exists because a page
 * cannot hand back a real OS path — but the *host* can, and it is the same
 * process that already reads and writes the project. So when OpenFlow runs on
 * the machine the user is sitting at (the loopback default), asking the OS is
 * both faster and less surprising than drilling through a list.
 *
 * Returns the chosen absolute path, or `undefined` when the user cancels.
 * Throws when no picker exists on this platform, so the caller can fall back
 * to the server-side browser rather than pretend the dialog was dismissed.
 */
export async function pickFolderNative(start?: string): Promise<string | undefined> {
  const command = pickerCommand(start)
  if (!command) throw new Error(`no native folder picker on ${process.platform}`)

  const output = await run(command.file, command.args)
  const picked = output.trim()
  if (!picked) return undefined
  return picked
}

/** True when this platform has a picker, so a host can advertise the route. */
export function hasNativePicker(): boolean {
  return Boolean(pickerCommand())
}

function pickerCommand(start?: string): { file: string; args: string[] } | undefined {
  if (process.platform === "win32") {
    // -STA is required: FolderBrowserDialog is a single-threaded-apartment
    // control and silently fails to show without it. The throwaway TopMost
    // form is the dialog's owner so it lands in front of the browser window
    // instead of behind it.
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Select the OpenFlow project folder'",
      "$dialog.ShowNewFolderButton = $true",
      start ? `$dialog.SelectedPath = ${quotePowerShell(start)}` : "",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.TopMost = $true",
      "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
      "$owner.Dispose()",
    ]
      .filter(Boolean)
      .join("; ")
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", script] }
  }

  if (process.platform === "darwin") {
    const target = start ? ` default location POSIX file ${quoteAppleScript(start)}` : ""
    const script =
      `try\n` +
      `  set chosen to choose folder with prompt "Select the OpenFlow project folder"${target}\n` +
      `  POSIX path of chosen\n` +
      `end try`
    return { file: "osascript", args: ["-e", script] }
  }

  for (const file of ["zenity", "kdialog"] as const) {
    if (!hasBinary(file)) continue
    if (file === "zenity") {
      const args = ["--file-selection", "--directory", "--title=Select the OpenFlow project folder"]
      if (start) args.push(`--filename=${start.endsWith("/") ? start : `${start}/`}`)
      return { file, args }
    }
    return { file, args: ["--getexistingdirectory", start ?? "."] }
  }

  return undefined
}

function hasBinary(name: string): boolean {
  const paths = (process.env.PATH ?? "").split(":").filter(Boolean)
  for (const dir of paths) {
    try {
      // Sync on purpose: this runs once per picker request, off any hot path.
      fs.accessSync(`${dir}/${name}`, fs.constants.X_OK)
      return true
    } catch {}
  }
  return false
}

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function quoteAppleScript(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: false })
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (err += chunk))
    child.on("error", (error) => reject(error))
    child.on("close", (code) => {
      // A cancelled dialog is a non-zero exit on zenity/kdialog and an empty
      // stdout everywhere else — neither is an error worth surfacing.
      if (code !== 0 && !out.trim() && err.trim()) return reject(new Error(err.trim()))
      resolve(out)
    })
  })
}
