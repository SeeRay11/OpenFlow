/**
 * Plain-language descriptions for the tool checkboxes, the highest-value
 * tooltips: these boxes decide whether a node can write, edit or run commands,
 * the source of the real-file-write hazard. Keyed by the same names as
 * `TOOLS` (`../server/card-spec`), so `tool-help.test.ts` can assert full
 * coverage. `edit` covers write and patch — they collapse onto one toggle.
 */
export const TOOL_HELP: Record<string, string> = {
  read: "Read files in the project",
  grep: "Search file contents",
  glob: "Find files by name pattern",
  edit: "Create, modify, and delete files",
  bash: "Run shell commands",
  webfetch: "Fetch a web page by URL",
  websearch: "Search the web",
  todowrite: "Keep a running task list while it works",
  skill: "Load a packaged skill's instructions",
  question: "Pause and ask you a question",
}
