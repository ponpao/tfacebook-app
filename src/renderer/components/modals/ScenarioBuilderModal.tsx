// ---------------------------------------------------------------------------
// ScenarioBuilderModal.tsx  — WinForms-style dialog for building account
// "warm-up" action pipelines: left panel lists saved scenarios, right panel
// is the step editor (add/remove/reorder/enable + min-max parameters).
// Scenarios persist to SQLite via window.api.scenarios.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import {
  X,
  FileText,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Save,
  ScrollText,
  ThumbsUp,
  Clapperboard,
  CircleDot,
  Timer
} from 'lucide-react'
import { useAccountStore } from '../../store/useAccountStore'
import type { Scenario, ScenarioStep, ScenarioStepType } from '../../../types/scenario'
import { STEP_LABELS, defaultStep } from '../../../types/scenario'
import { HEADER_HEX_PATTERN_URL } from '../../assets/headerHexPattern'

const STEP_TYPES: ScenarioStepType[] = [
  'scroll_newsfeed',
  'like_random_posts',
  'watch_reels',
  'view_stories',
  'random_delay'
]

const STEP_ICONS: Record<ScenarioStepType, typeof ScrollText> = {
  scroll_newsfeed: ScrollText,
  like_random_posts: ThumbsUp,
  watch_reels: Clapperboard,
  view_stories: CircleDot,
  random_delay: Timer
}

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 3600
}: {
  label: string
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
      {/* Fixed label width so every NumberField's input starts at the same
          x-offset regardless of label text length ("Min (s)" vs "Min
          count" vs "Min dur (s)") — this is what actually keeps every step
          type's inputs aligned into clean columns when stacked in the list,
          not just the input's own fixed width. */}
      <span className="w-[62px] shrink-0 text-right">{label}</span>
      <input
        type="number"
        className="win-input w-16 shrink-0 py-0.5 text-center"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

/** Renders the min/max parameter inputs for one step, typed per step kind. */
function StepParams({
  step,
  onChange
}: {
  step: ScenarioStep
  onChange: (next: ScenarioStep) => void
}): React.JSX.Element {
  switch (step.type) {
    case 'scroll_newsfeed':
      return (
        <>
          <NumberField
            label="Min (s)"
            value={step.minSeconds}
            onChange={(n) => onChange({ ...step, minSeconds: n })}
          />
          <NumberField
            label="Max (s)"
            value={step.maxSeconds}
            onChange={(n) => onChange({ ...step, maxSeconds: n })}
          />
        </>
      )
    case 'like_random_posts':
      return (
        <>
          <NumberField
            label="Min count"
            value={step.minCount}
            onChange={(n) => onChange({ ...step, minCount: n })}
            max={20}
          />
          <NumberField
            label="Max count"
            value={step.maxCount}
            onChange={(n) => onChange({ ...step, maxCount: n })}
            max={20}
          />
        </>
      )
    case 'watch_reels':
      return (
        <>
          <NumberField
            label="Min count"
            value={step.minCount}
            onChange={(n) => onChange({ ...step, minCount: n })}
            max={20}
          />
          <NumberField
            label="Max count"
            value={step.maxCount}
            onChange={(n) => onChange({ ...step, maxCount: n })}
            max={20}
          />
          <NumberField
            label="Min dur (s)"
            value={step.minDurationSeconds}
            onChange={(n) => onChange({ ...step, minDurationSeconds: n })}
          />
          <NumberField
            label="Max dur (s)"
            value={step.maxDurationSeconds}
            onChange={(n) => onChange({ ...step, maxDurationSeconds: n })}
          />
        </>
      )
    case 'view_stories':
      return (
        <>
          <NumberField
            label="Min count"
            value={step.minCount}
            onChange={(n) => onChange({ ...step, minCount: n })}
            max={20}
          />
          <NumberField
            label="Max count"
            value={step.maxCount}
            onChange={(n) => onChange({ ...step, maxCount: n })}
            max={20}
          />
        </>
      )
    case 'random_delay':
      return (
        <>
          <NumberField
            label="Min (s)"
            value={step.minSeconds}
            onChange={(n) => onChange({ ...step, minSeconds: n })}
          />
          <NumberField
            label="Max (s)"
            value={step.maxSeconds}
            onChange={(n) => onChange({ ...step, maxSeconds: n })}
          />
        </>
      )
  }
}

export function ScenarioBuilderModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const scenarios = useAccountStore((s) => s.scenarios)
  const refreshScenarios = useAccountStore((s) => s.refreshScenarios)
  const activeScenarioId = useAccountStore((s) => s.activeScenarioId)
  const setActiveScenarioId = useAccountStore((s) => s.setActiveScenarioId)
  const showToast = useAccountStore((s) => s.showToast)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [steps, setSteps] = useState<ScenarioStep[]>([])
  const [dirty, setDirty] = useState(false)
  const [addType, setAddType] = useState<ScenarioStepType>('scroll_newsfeed')

  useEffect(() => {
    if (!open) return
    void refreshScenarios()
  }, [open, refreshScenarios])

  // Load the active (or first) scenario into the editor whenever the list
  // changes or the modal opens.
  useEffect(() => {
    if (!open || scenarios.length === 0) return
    if (selectedId != null && scenarios.some((s) => s.id === selectedId)) return
    const initial = scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0]
    setSelectedId(initial.id)
    setName(initial.name)
    setSteps(initial.steps)
    setDirty(false)
  }, [open, scenarios, activeScenarioId, selectedId])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const selectScenario = (s: Scenario): void => {
    setSelectedId(s.id)
    setName(s.name)
    setSteps(s.steps)
    setDirty(false)
  }

  const addStep = (): void => {
    setSteps((prev) => [...prev, defaultStep(addType)])
    setDirty(true)
  }
  const removeStep = (id: string): void => {
    setSteps((prev) => prev.filter((s) => s.id !== id))
    setDirty(true)
  }
  const toggleStep = (id: string): void => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)))
    setDirty(true)
  }
  const updateStep = (next: ScenarioStep): void => {
    setSteps((prev) => prev.map((s) => (s.id === next.id ? next : s)))
    setDirty(true)
  }
  const moveStep = (index: number, dir: -1 | 1): void => {
    setSteps((prev) => {
      const target = index + dir
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
    setDirty(true)
  }

  const createNew = async (): Promise<void> => {
    const base = 'New Scenario'
    let candidate = base
    let n = 2
    while (scenarios.some((s) => s.name === candidate)) {
      candidate = `${base} ${n}`
      n += 1
    }
    const created = await window.api.scenarios.create({ name: candidate, steps: [] })
    await refreshScenarios()
    selectScenario(created)
  }

  const saveScenario = async (): Promise<void> => {
    if (selectedId == null) return
    if (!name.trim()) {
      showToast('Scenario name cannot be empty')
      return
    }
    await window.api.scenarios.update(selectedId, { name: name.trim(), steps })
    await refreshScenarios()
    setDirty(false)
    showToast(`Saved scenario "${name.trim()}"`)
  }

  const deleteScenario = async (): Promise<void> => {
    if (selectedId == null) return
    const target = scenarios.find((s) => s.id === selectedId)
    if (!target) return
    if (target.is_default) {
      showToast('The default scenario cannot be deleted')
      return
    }
    if (!confirm(`Delete scenario "${target.name}"?`)) return
    const ok = await window.api.scenarios.delete(selectedId)
    if (!ok) {
      showToast('Could not delete this scenario')
      return
    }
    setSelectedId(null)
    await refreshScenarios()
  }

  const useAsActive = (): void => {
    if (selectedId == null) return
    setActiveScenarioId(selectedId)
    showToast(`"${name}" set as the active warm-up scenario`)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex h-full max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded border border-slate-400 border-t-4 border-t-indigo-600 bg-[#f0f2f5] shadow-2xl">
        {/* Header */}
        <div
          className="flex items-center justify-between border-b border-[#e4d8bc] bg-[#fdf9f0] px-4 py-2"
          style={{
            backgroundImage: HEADER_HEX_PATTERN_URL,
            backgroundSize: '56px 98px',
            backgroundRepeat: 'repeat'
          }}
        >
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-[#0067c0]" />
            <h2 className="text-[13px] font-semibold text-slate-900">Scenario Builder</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-[#e81123]">
            <X size={16} />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-[200px_1fr] overflow-hidden">
          {/* Left panel: saved scenarios */}
          <div className="flex flex-col border-r border-slate-300 bg-[#f6f6f6]">
            <div className="flex items-center justify-between px-2 py-1.5 text-[11px] font-semibold text-slate-600">
              Saved Scenarios
              <button
                className="win-btn-sq h-6 w-6"
                title="New scenario"
                onClick={() => void createNew()}
              >
                <Plus size={13} className="text-[#1e9e4a]" />
              </button>
            </div>
            <div className="flex-1 overflow-auto px-1 pb-1">
              {scenarios.map((s) => (
                <button
                  key={s.id}
                  onClick={() => selectScenario(s)}
                  className={`flex w-full flex-col items-start rounded px-2 py-1.5 text-left text-[12px] ${
                    selectedId === s.id
                      ? 'bg-[#0078d4] text-white'
                      : 'text-slate-800 hover:bg-[#e5f1fb]'
                  }`}
                >
                  <span className="truncate font-medium">{s.name}</span>
                  <span
                    className={`text-[10px] ${
                      selectedId === s.id ? 'text-white/80' : 'text-slate-500'
                    }`}
                  >
                    {s.steps.length} step{s.steps.length === 1 ? '' : 's'}
                    {s.is_default ? ' · default' : ''}
                    {activeScenarioId === s.id ? ' · active' : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Right panel: step pipeline editor */}
          <div className="flex flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-slate-300 px-3 py-2">
              <input
                className="win-input flex-1"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setDirty(true)
                }}
                placeholder="Scenario name"
              />
              <select
                className="win-select"
                value={addType}
                onChange={(e) => setAddType(e.target.value as ScenarioStepType)}
              >
                {STEP_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {STEP_LABELS[t]}
                  </option>
                ))}
              </select>
              <button className="win-btn" onClick={addStep}>
                <Plus size={13} className="text-[#1e9e4a]" />
                Add Step
              </button>
            </div>

            <div className="flex-1 overflow-auto p-2">
              {steps.length === 0 && (
                <div className="flex h-full items-center justify-center text-[12px] text-slate-400">
                  No steps yet — add one above.
                </div>
              )}
              {steps.map((step, i) => {
                const Icon = STEP_ICONS[step.type]
                return (
                  <div
                    key={step.id}
                    // Strict grid, not flex — a fixed track per column (checkbox,
                    // icon, title, params, actions) means every step type's
                    // columns line up in exactly the same place regardless of
                    // how many NumberFields a given step type has, instead of
                    // flex's content-driven sizing letting each row's layout
                    // drift independently.
                    className={`mb-1.5 grid grid-cols-[20px_18px_190px_1fr_88px] items-center gap-2 rounded border border-slate-300 bg-white px-2 py-2 ${
                      step.enabled ? '' : 'opacity-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-[#0078d4]"
                      checked={step.enabled}
                      onChange={() => toggleStep(step.id)}
                      title="Enabled"
                    />
                    <Icon size={14} className="shrink-0 text-[#4a6a8a]" />
                    <span className="truncate text-[12px] font-medium text-slate-800">
                      {STEP_LABELS[step.type]}
                    </span>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <StepParams step={step} onChange={updateStep} />
                    </div>
                    <div className="flex shrink-0 items-center justify-end gap-0.5">
                      <button
                        className="win-btn-sq h-6 w-6"
                        disabled={i === 0}
                        onClick={() => moveStep(i, -1)}
                        title="Move up"
                      >
                        <ChevronUp size={13} />
                      </button>
                      <button
                        className="win-btn-sq h-6 w-6"
                        disabled={i === steps.length - 1}
                        onClick={() => moveStep(i, 1)}
                        title="Move down"
                      >
                        <ChevronDown size={13} />
                      </button>
                      <button
                        className="win-btn-sq h-6 w-6"
                        onClick={() => removeStep(step.id)}
                        title="Remove step"
                      >
                        <Trash2 size={13} className="text-[#c81e1e]" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-slate-300 bg-[#f6f6f6] px-4 py-2.5">
          <div className="flex gap-2">
            <button
              className="win-btn"
              onClick={() => void deleteScenario()}
              disabled={selectedId == null}
            >
              <Trash2 size={13} className="text-[#c81e1e]" />
              Delete
            </button>
            <button
              className="win-btn-accent"
              onClick={useAsActive}
              disabled={selectedId == null}
              title="Use this scenario when Start / Run is clicked"
            >
              Use as Active Scenario
            </button>
          </div>
          <div className="flex gap-2">
            <button
              className="win-btn"
              onClick={() => void saveScenario()}
              disabled={selectedId == null || !dirty}
            >
              <Save size={13} className="text-[#0067c0]" />
              Save
            </button>
            <button className="win-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
