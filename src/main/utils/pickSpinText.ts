// ---------------------------------------------------------------------------
// pickSpinText.ts  — flat pipe-delimited variant picker for Change Info
// fields ("Washington|New York|Houston" -> one of the three, chosen at
// random). Distinct from spinSyntax.ts's nested {a|b} inline-caption syntax:
// this always treats the WHOLE string as a plain list of alternatives, with
// no braces and no partial substitution.
// ---------------------------------------------------------------------------

/** Pick one random '|'-delimited alternative from `text`. A single value (no '|') is returned as-is. */
export function pickSpinText(text: string): string {
  if (!text) return text
  const options = text.split('|').map((s) => s.trim()).filter(Boolean)
  if (options.length === 0) return text
  return options[Math.floor(Math.random() * options.length)]
}
