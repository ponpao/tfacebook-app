// ---------------------------------------------------------------------------
// scenariosRepo.ts  — SQL for the `scenarios` table (warm-up action pipelines).
// Steps are stored as JSON text; parsed/serialized at the repo boundary so
// callers work with typed ScenarioStep[] everywhere else.
// ---------------------------------------------------------------------------
import { getDb } from './database'
import type { Scenario, NewScenario, ScenarioStep } from '../../types/scenario'

interface ScenarioRow {
  id: number
  name: string
  steps_json: string
  is_default: number
  created_at: string
  updated_at: string
}

function toScenario(row: ScenarioRow): Scenario {
  let steps: ScenarioStep[] = []
  let randomize_order = false
  try {
    const parsed = JSON.parse(row.steps_json)
    if (Array.isArray(parsed)) {
      steps = parsed
    } else if (parsed && typeof parsed === 'object') {
      steps = Array.isArray(parsed.steps) ? parsed.steps : []
      randomize_order = !!parsed.randomize_order
    }
  } catch {
    steps = []
  }
  return {
    id: row.id,
    name: row.name,
    steps,
    randomize_order,
    is_default: row.is_default === 1,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export function getAllScenarios(): Scenario[] {
  const rows = getDb()
    .prepare(`SELECT * FROM scenarios ORDER BY is_default DESC, id ASC`)
    .all() as ScenarioRow[]
  return rows.map(toScenario)
}

export function getScenario(id: number): Scenario | null {
  const row = getDb().prepare(`SELECT * FROM scenarios WHERE id = ?`).get(id) as
    | ScenarioRow
    | undefined
  return row ? toScenario(row) : null
}

export function createScenario(input: NewScenario): Scenario {
  const db = getDb()
  const info = db
    .prepare(`INSERT INTO scenarios (name, steps_json) VALUES (@name, @steps)`)
    .run({
      name: input.name.trim(),
      steps: JSON.stringify({ steps: input.steps, randomize_order: !!input.randomize_order })
    })
  return getScenario(Number(info.lastInsertRowid)) as Scenario
}

export function updateScenario(
  id: number,
  patch: Partial<NewScenario>
): Scenario | null {
  const db = getDb()
  const entries: string[] = []
  const params: Record<string, unknown> = { id }
  if (patch.name != null) {
    entries.push('name = @name')
    params.name = patch.name.trim()
  }
  if (patch.steps != null || patch.randomize_order !== undefined) {
    entries.push('steps_json = @steps')
    const current = getScenario(id)
    const steps = patch.steps ?? current?.steps ?? []
    const randomize_order =
      patch.randomize_order !== undefined
        ? patch.randomize_order
        : (current?.randomize_order ?? false)
    params.steps = JSON.stringify({ steps, randomize_order })
  }
  if (entries.length === 0) return getScenario(id)
  db.prepare(`UPDATE scenarios SET ${entries.join(', ')} WHERE id = @id`).run(params)
  return getScenario(id)
}

/** The default scenario (id 1's slot, or whichever row is flagged) can be renamed but not deleted. */
export function deleteScenario(id: number): boolean {
  const db = getDb()
  const row = db.prepare(`SELECT is_default FROM scenarios WHERE id = ?`).get(id) as
    | { is_default: number }
    | undefined
  if (!row || row.is_default === 1) return false
  db.prepare(`DELETE FROM scenarios WHERE id = ?`).run(id)
  return true
}
