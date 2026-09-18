/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./src/renderer/**/*.{html,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          sunken: 'rgb(var(--surface-sunken) / <alpha-value>)'
        },
        edge: 'rgb(var(--edge) / <alpha-value>)',
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)'
        },
        accent: 'rgb(var(--accent) / <alpha-value>)',
        // Status colors (kept for badges) — semantic, not theme colors
        live: '#1e9e4a',
        checkpoint: '#c98a00',
        die: '#c81e1e',
        changed: '#d1721c',
        unknown: '#6b7280'
      },
      fontFamily: {
        sans: ['Kantumruy Pro', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Tahoma', 'system-ui', 'sans-serif'],
        mono: ['Consolas', 'monospace']
      },
      fontSize: {
        '2xs': ['11px', '15px']
      }
    }
  },
  plugins: []
}
