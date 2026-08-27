// ---------------------------------------------------------------------------
// pickSpinText.ts  — flat pipe-delimited variant picker for Change Info form
// previews ("Washington|New York|Houston" -> one of the three). Mirrors
// src/main/utils/pickSpinText.ts (kept separate rather than shared across
// the main/renderer process boundary — it's a 5-line pure function).
// ---------------------------------------------------------------------------

/** Pick one random '|'-delimited alternative from `text`. A single value (no '|') is returned as-is. */
export function pickSpinText(text: string): string {
  if (!text) return text
  const options = text.split('|').map((s) => s.trim()).filter(Boolean)
  if (options.length === 0) return text
  return options[Math.floor(Math.random() * options.length)]
}
