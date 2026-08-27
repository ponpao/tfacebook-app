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
  try {
    steps = JSON.parse(row.steps_json)
  } catch {
    steps = []
  }
  return {
    id: row.id,
    name: row.name,
    steps,
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
    .run({ name: input.name.trim(), steps: JSON.stringify(input.steps) })
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
  if (patch.steps != null) {
    entries.push('steps_json = @steps')
    params.steps = JSON.stringify(patch.steps)
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
