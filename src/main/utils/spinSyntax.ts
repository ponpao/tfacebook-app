// ---------------------------------------------------------------------------
// spinSyntax.ts  — nested "spin syntax" parser for unique post/share captions.
//   "Hello {world|everyone}! {Have a {great|nice} day|Good morning}!"
// Each {a|b|c} group picks one variant at random, independently, on every
// call — so repeated calls with the same input template produce different
// output text (used to avoid Facebook spam detection on duplicate captions).
// ---------------------------------------------------------------------------

/**
 * Parse spin syntax into one randomly-resolved string. Supports arbitrary
 * nesting — inner {..|..} groups are resolved before the outer pick is made,
 * since we resolve innermost-first via repeated passes.
 *
 * Malformed input (unbalanced braces) is returned as-is for that segment
 * rather than throwing, so a typo in one post never blocks the whole batch.
 */
export function parseSpinSyntax(text: string): string {
  if (!text) return text

  let result = text
  // A group with no nested '{' inside it — the innermost level.
  const innermost = /\{([^{}]*)\}/

  // Repeatedly resolve the innermost groups until none remain. Each pass
  // shrinks the string (or leaves it unchanged if braces are unbalanced),
  // so this always terminates.
  let previous: string
  do {
    previous = result
    result = result.replace(innermost, (_match, group: string) => {
      const options = group.split('|')
      const choice = options[Math.floor(Math.random() * options.length)]
      return choice
    })
  } while (result !== previous && result.includes('{'))

  return result
}

/**
 * Generate N independent spin results from the same template — handy for a
 * "Test Spin" preview that shows a few example outputs at once.
 */
export function previewSpins(text: string, count = 3): string[] {
  const n = Math.max(1, Math.min(20, count))
  return Array.from({ length: n }, () => parseSpinSyntax(text))
}

/** Count how many total combinations a spin template can produce (rough estimate, caps at a large number to avoid overflow). */
export function countSpinVariants(text: string): number {
  const groups = text.match(/\{[^{}]*\}/g) ?? []
  let total = 1
  for (const g of groups) {
    const options = g.slice(1, -1).split('|')
    total *= Math.max(1, options.length)
    if (total > 1_000_000) return 1_000_000 // cap for display purposes
  }
  return total
}
