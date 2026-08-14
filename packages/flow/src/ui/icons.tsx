/**
 * The four icons the provider UI needs, inline.
 *
 * opencode's app pulls these from `@opencode-ai/ui`, which brings a whole
 * component library (Kobalte, tailwind, an icon sprite) with it. OpenFlow is a
 * single vite page with hand-written CSS, so the shapes are redrawn here at the
 * same 16px stroke weight rather than dragging that dependency in for four
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
