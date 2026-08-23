/**
 * The icon set the interface needs, inline.
 *
 * opencode's app pulls these from `@opencode-ai/ui`, which brings a whole
 * component library (Kobalte, tailwind, an icon sprite) with it. OpenFlow is a
 * single vite page with hand-written CSS, so the shapes are redrawn here at the
 * same 16px stroke weight rather than dragging that dependency in for a dozen
 * glyphs. `currentColor` everywhere, so they inherit the row's text colour.
 */
function Svg(props: { children: any; size?: number }) {
  return (
    <svg
      class="oc-icon"
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.25"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  )
}

export function IconSearch() {
  return (
    <Svg>
      <circle cx="7.2" cy="7.2" r="4.2" />
      <path d="M10.4 10.4 13.5 13.5" />
    </Svg>
  )
}

export function IconClose() {
  return (
    <Svg>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  )
}

export function IconChevron() {
  return (
    <Svg>
      <path d="M4.5 6.5 8 10l3.5-3.5" />
    </Svg>
  )
}

export function IconBack() {
  return (
    <Svg>
      <path d="M9.5 4.5 6 8l3.5 3.5" />
    </Svg>
  )
}

export function IconSliders() {
  return (
    <Svg>
      <path d="M2.5 5h11M2.5 11h11" />
      <circle cx="6" cy="5" r="1.6" />
      <circle cx="10.5" cy="11" r="1.6" />
    </Svg>
  )
}

export function IconCheck() {
  return (
    <Svg>
      <path d="M3.5 8.5 6.5 11.5 12.5 5" />
    </Svg>
  )
}

export function IconPlus() {
  return (
    <Svg>
      <path d="M8 3.5v9M3.5 8h9" />
    </Svg>
  )
}

/** Save — a disk, the same shape opencode uses for a write action. */
export function IconSave() {
  return (
    <Svg>
      <path d="M3.25 2.75h7.25L13.25 5.5v7.75a.5.5 0 0 1-.5.5H3.25a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5Z" />
      <path d="M5.5 2.75v3.5h5v-3.5" />
      <path d="M5.5 13.25V9.5h5v3.75" />
    </Svg>
  )
}

export function IconFolder() {
  return (
    <Svg>
      <path d="M2.25 12.5v-9h4l1.5 2h6v7a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5Z" />
    </Svg>
  )
}

/** Export — a downward arrow dropping into a tray, saving the graph to a file. */
export function IconExport() {
  return (
    <Svg>
      <path d="M8 2.5v6.5" />
      <path d="M5.25 6.25 8 9l2.75-2.75" />
      <path d="M3 11v1.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V11" />
    </Svg>
  )
}

/** Import — an upward arrow lifting out of a tray, loading a graph from a file. */
export function IconImport() {
  return (
    <Svg>
      <path d="M8 9V2.5" />
      <path d="M5.25 5.25 8 2.5l2.75 2.75" />
      <path d="M3 11v1.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V11" />
    </Svg>
  )
}

/** Merge — two stacked layers folding into one, for the agent merge action. */
export function IconLayers() {
  return (
    <Svg>
      <path d="M8 2.25 14 5.5 8 8.75 2 5.5Z" />
      <path d="m2 9 6 3.25L14 9" />
    </Svg>
  )
}

export function IconKey() {
  return (
    <Svg>
      <circle cx="5.75" cy="10.25" r="2.75" />
      <path d="m7.75 8.25 5-5M11 5l1.5 1.5M9.5 6.5 11 8" />
    </Svg>
  )
}

export function IconPlay() {
  return (
    <Svg>
      <path d="M5.25 3.5 12 8l-6.75 4.5Z" />
    </Svg>
  )
}

export function IconStop() {
  return (
    <Svg>
      <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.25" />
    </Svg>
  )
}

export function IconEdit() {
  return (
    <Svg>
      <path d="M9.75 3.25 12.75 6.25 5.5 13.5H2.5v-3Z" />
      <path d="M8.5 4.5 11.5 7.5" />
    </Svg>
  )
}

export function IconTrash() {
  return (
    <Svg>
      <path d="M2.75 4.5h10.5M6.25 4.5V3.25a.5.5 0 0 1 .5-.5h2.5a.5.5 0 0 1 .5.5V4.5" />
      <path d="M4.25 4.5v8.25a.5.5 0 0 0 .5.5h6.5a.5.5 0 0 0 .5-.5V4.5" />
      <path d="M6.75 7v4M9.25 7v4" />
    </Svg>
  )
}

/** Run history — a clock with a rewind hand. */
export function IconHistory() {
  return (
    <Svg>
      <path d="M2.9 6.4A5.5 5.5 0 1 1 2.75 9" />
      <path d="M2.75 3v3.5h3.5" />
      <path d="M8 5.25V8l2 1.25" />
    </Svg>
  )
}

export function IconAlert() {
  return (
    <Svg>
      <path d="M8 2.75 14.25 13.25H1.75Z" />
      <path d="M8 6.5v3.25M8 11.6v.15" />
    </Svg>
  )
}

export function IconInfo() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 7.25v3.5M8 5.15v.15" />
    </Svg>
  )
}

/** The brand mark — three nodes wired left to right, the pipeline in miniature. */
export function IconFlow() {
  return (
    <Svg>
      <circle cx="3.25" cy="8" r="1.75" />
      <circle cx="12.75" cy="4.25" r="1.75" />
      <circle cx="12.75" cy="11.75" r="1.75" />
      <path d="M4.9 7.35 11.1 4.9M4.9 8.65l6.2 2.45" />
    </Svg>
  )
}

export function IconPlug() {
  return (
    <Svg>
      <path d="M6 2v3.2M10 2v3.2" />
      <path d="M3.8 5.2h8.4v2.1a4.2 4.2 0 0 1-4.2 4.2 4.2 4.2 0 0 1-4.2-4.2z" />
      <path d="M8 11.5V14" />
    </Svg>
  )
}

export function IconPaperclip() {
  return (
    <Svg>
      <path d="M11.6 7.3 7 11.9a2.6 2.6 0 0 1-3.7-3.7l5.2-5.2a1.8 1.8 0 0 1 2.5 2.5l-5.1 5.1a0.9 0.9 0 0 1-1.3-1.3l4.6-4.6" />
    </Svg>
  )
}

export function IconRestart() {
  return (
    <Svg>
      <path d="M13.25 8a5.25 5.25 0 1 1-1.6-3.78" />
      <path d="M13.4 2.4v3.1h-3.1" />
    </Svg>
  )
}

export function IconCoin() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M9.75 6.1A2.4 2.4 0 0 0 8 5.4c-1 0-1.75.5-1.75 1.3S7 8 8 8s1.75.5 1.75 1.3-.75 1.3-1.75 1.3a2.4 2.4 0 0 1-1.75-.7" />
      <path d="M8 4.3v1.1M8 10.6v1.1" />
    </Svg>
  )
}

export function IconQuestion() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M6.3 6.3a1.8 1.8 0 0 1 3.4.7c0 1.2-1.7 1.4-1.7 2.6" />
      <path d="M8 12.1h.01" />
    </Svg>
  )
}
