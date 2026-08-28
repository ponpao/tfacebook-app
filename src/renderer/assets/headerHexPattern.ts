// ---------------------------------------------------------------------------
// headerHexPattern.ts  — subtle repeating hexagon-outline background pattern
// for the app's top header band (title bar + menu bar), as an inline SVG
// data URI (no binary asset/pipeline wiring, crisp at any DPI/zoom). Distinct
// from titlebarPattern.ts's wavy contour lines — this is the flat-top
// honeycomb grid used across the "Studio"-style toolbar redesign.
// ---------------------------------------------------------------------------

/**
 * A tileable flat-top hexagon grid: thin warm-tan outlines on a soft cream
 * background, sized so the seam is invisible when repeated as a CSS
 * background-image across the full header width.
 */
export const HEADER_HEX_PATTERN_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="56" height="98" viewBox="0 0 56 98">
  <rect width="56" height="98" fill="#fdf9f0"/>
  <g fill="none" stroke="#efdfc0" stroke-width="1.5">
    <path d="M14 0 L28 8 L28 24 L14 32 L0 24 L0 8 Z"/>
    <path d="M42 0 L56 8 L56 24 L42 32 L28 24 L28 8 Z"/>
    <path d="M14 32 L28 40 L28 56 L14 64 L0 56 L0 40 Z"/>
    <path d="M42 32 L56 40 L56 56 L42 64 L28 56 L28 40 Z"/>
    <path d="M14 64 L28 72 L28 88 L14 96 L0 88 L0 72 Z"/>
    <path d="M42 64 L56 72 L56 88 L42 96 L28 88 L28 72 Z"/>
  </g>
</svg>
`.trim()

/** `url(...)` value ready to drop straight into a CSS backgroundImage. */
export const HEADER_HEX_PATTERN_URL = `url("data:image/svg+xml,${encodeURIComponent(HEADER_HEX_PATTERN_SVG)}")`
