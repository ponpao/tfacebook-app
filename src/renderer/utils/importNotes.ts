/** Split pasted note text into non-empty lines (trims edges, keeps Unicode). */
export function parseNoteLines(raw: string): string[] {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export type NoteImportPlan =
  | { mode: 'broadcast'; note: string }
  | { mode: 'per_row'; notes: string[] }
  | { mode: 'mismatch'; notes: string[]; selected: number }

/** Decide how pasted lines map onto the selected-row list. */
export function planNoteImport(raw: string, selectedCount: number): NoteImportPlan | { mode: 'empty' } {
  const notes = parseNoteLines(raw)
  if (notes.length === 0 || selectedCount <= 0) return { mode: 'empty' }
  if (notes.length === 1) return { mode: 'broadcast', note: notes[0] }
  if (notes.length === selectedCount) return { mode: 'per_row', notes }
  return { mode: 'mismatch', notes, selected: selectedCount }
}
