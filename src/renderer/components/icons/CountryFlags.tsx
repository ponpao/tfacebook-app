import React from 'react'

/** Crisp SVG Flag of Cambodia 🇰🇭 (Blue/Red stripes with Angkor Wat temple) */
export function CambodiaFlag({ size = 16, className = '' }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={Math.round((size * 2) / 3)}
      viewBox="0 0 640 480"
      className={`shrink-0 rounded-xs shadow-2xs overflow-hidden ${className}`}
      aria-label="Cambodia Flag"
    >
      <rect width="640" height="480" fill="#032ea1" />
      <rect y="120" width="640" height="240" fill="#e00025" />
      {/* Angkor Wat Temple Silhouette */}
      <g fill="#ffffff" transform="translate(320, 240) scale(0.68) translate(-320, -240)">
        {/* Base foundation */}
        <rect x="170" y="300" width="300" height="15" />
        <rect x="185" y="280" width="270" height="20" />
        <rect x="200" y="260" width="240" height="20" />
        {/* Center Tower */}
        <polygon points="320,130 305,175 308,260 332,260 335,175" />
        <polygon points="320,115 314,135 326,135" />
        {/* Left Towers */}
        <polygon points="255,165 243,200 246,260 264,260 267,200" />
        <polygon points="215,190 205,220 208,260 222,260 225,220" />
        {/* Right Towers */}
        <polygon points="385,165 373,200 376,260 394,260 397,200" />
        <polygon points="425,190 415,220 418,260 432,260 435,220" />
      </g>
    </svg>
  )
}

/** Crisp SVG Union Jack Flag of the United Kingdom 🇬🇧 */
export function UKFlag({ size = 16, className = '' }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={Math.round((size * 2) / 3)}
      viewBox="0 0 60 40"
      className={`shrink-0 rounded-xs shadow-2xs overflow-hidden ${className}`}
      aria-label="UK Flag"
    >
      <clipPath id="uk-flag-clip">
        <rect width="60" height="40" rx="1" />
      </clipPath>
      <g clipPath="url(#uk-flag-clip)">
        {/* Blue background */}
        <rect width="60" height="40" fill="#012169" />
        {/* White diagonals */}
        <path d="M0,0 L60,40 M60,0 L0,40" stroke="#fff" strokeWidth="8" />
        {/* Red diagonals */}
        <path d="M0,0 L60,40" stroke="#C8102E" strokeWidth="4" />
        <path d="M60,0 L0,40" stroke="#C8102E" strokeWidth="4" />
        {/* White cross */}
        <path d="M30,0 v40 M0,20 h60" stroke="#fff" strokeWidth="12" />
        {/* Red cross */}
        <path d="M30,0 v40 M0,20 h60" stroke="#C8102E" strokeWidth="6" />
      </g>
    </svg>
  )
}
