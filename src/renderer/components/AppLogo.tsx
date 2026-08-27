// ---------------------------------------------------------------------------
// AppLogo.tsx  — TFACEBOOK brand mark (matches build/icon.svg) as inline SVG,
// so the title bar badge stays crisp at any size with no asset pipeline.
// ---------------------------------------------------------------------------
export function AppLogo({ size = 20 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1400 1400"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="tfb-logo-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#EC2D8A" />
          <stop offset="50%" stopColor="#9B3DC4" />
          <stop offset="100%" stopColor="#2E2E9E" />
        </linearGradient>
      </defs>
      <rect x="20" y="20" width="1360" height="1360" rx="280" fill="url(#tfb-logo-bg)" />
      <circle cx="700" cy="358" r="82" fill="#ffffff" />
      <path
        fill="#ffffff"
        d="M 700 470 C 668 470 638 486 620 512 L 340 942 C 312 984 322 1041 364 1069
           C 406 1097 463 1087 491 1045 L 700 726 L 909 1045 C 937 1087 994 1097 1036 1069
           C 1078 1041 1088 984 1060 942 L 780 512 C 762 486 732 470 700 470 Z"
      />
    </svg>
  )
}
