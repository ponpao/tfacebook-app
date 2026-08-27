// ---------------------------------------------------------------------------
// titlebarPattern.ts  — the wavy/organic title-bar background pattern,
// recreated as an inline SVG data URI (no binary asset file needed: no
// asset-pipeline wiring, crisp at any DPI/zoom, and a few hundred bytes
// instead of a multi-KB JPEG). Visually matches the supplied reference
// pattern: soft cream background, light warm-grey wavy contour lines.
// ---------------------------------------------------------------------------

/**
 * A tileable ~200x200 SVG "topographic contour" pattern: a handful of
 * smooth, organic wavy paths on a warm off-white background. Referenced as a
 * CSS background-image so it repeats seamlessly across the full title bar
 * width regardless of window size.
 */
export const TITLEBAR_PATTERN_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <rect width="200" height="200" fill="#fbfaf7"/>
  <g fill="none" stroke="#e4e0d8" stroke-width="10" stroke-linecap="round">
    <path d="M-20 30 Q 20 0, 50 30 T 110 30 Q 140 60, 120 90 T 90 140 Q 60 170, 90 200"/>
    <path d="M-10 90 Q 30 60, 70 90 T 150 90 Q 180 120, 160 150"/>
    <path d="M30 -10 Q 60 20, 40 60 T 60 130 Q 90 160, 130 150 T 210 170"/>
    <path d="M150 -10 Q 120 20, 150 50 T 130 110 Q 100 140, 130 180 T 120 210"/>
  </g>
</svg>
`.trim()

/** `url(...)` value ready to drop straight into a CSS backgroundImage. */
export const TITLEBAR_PATTERN_URL = `url("data:image/svg+xml,${encodeURIComponent(TITLEBAR_PATTERN_SVG)}")`
