/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // MaxCare WinForms light-theme palette
        mc: {
          bg: '#f0f0f0', // window chrome gray
          panel: '#ffffff', // white title bar / panels
          ribbon: '#f4f4f4', // ribbon background
          border: '#a0a0a0', // grid outer border
          gridline: '#b8cbb0', // pastel green inner gridline
          headbg: '#f5f5f5', // grid header gray
          row: '#e2efda', // pastel green normal row
          rowAlt: '#eaf4e6', // alt pastel green
          sel: '#0078d4', // classic blue selection
          selText: '#ffffff',
          title: '#1a1a1a', // bold black title text
          banner: '#c81e1e', // red announcement text
          menu: '#333333' // menu strip text
        },
        // Status colors (kept for badges)
        live: '#1e9e4a',
        checkpoint: '#c98a00',
        die: '#c81e1e',
        changed: '#d1721c',
        unknown: '#6b7280'
      },
      fontFamily: {
        sans: ['Segoe UI', 'Tahoma', 'system-ui', 'sans-serif'],
        mono: ['Consolas', 'monospace']
      },
      fontSize: {
        '2xs': ['11px', '15px']
      }
    }
  },
  plugins: []
}
