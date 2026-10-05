import type { Choice, QuestionData, QuestionType, StoredKey, StoredQuestion } from '../shared/types'
import {
  asBlankAnswers,
  asPairMap,
  asProblemKey,
  asStringArray,
  countBlanks
} from '../shared/validation'

/** Human names of the eight types, shared by the card tag and the add buttons. */
export const TYPE_LABELS: Record<QuestionType, string> = {
  mcq: 'Multiple choice',
  tf: 'True / false',
  identification: 'Identification',
  fillin: 'Fill in the blank',
  enumeration: 'Enumeration',
  problem: 'Problem',
  matching: 'Matching',
  connect: 'Connect'
}

/** Short unique id for new questions and choice items. */
export const uid = (prefix: string): string => prefix + Math.random().toString(36).slice(2, 9)

/** A fresh, empty (draft) question of the given type. */
export function newQuestion(type: QuestionType): StoredQuestion {
  const base = { id: uid('q'), type, body: '', points: 1, sourceText: '', status: 'draft' as const }
  switch (type) {
    case 'mcq':
      return { ...base, data: { options: [{ id: uid('o'), text: '' }, { id: uid('o'), text: '' }] }, key: null }
    case 'tf':
      return { ...base, data: {}, key: null }
    case 'identification':
      return { ...base, data: {}, key: [] }
    case 'fillin':
      return { ...base, data: { blanks: 0 }, key: [] }
    case 'enumeration':
      return { ...base, data: { count: 3 }, key: [] }
    case 'problem':
      return { ...base, data: {}, key: { answer: '' } }
    case 'matching':
      return { ...base, data: { left: [], right: [] }, key: {} }
    case 'connect':
      return { ...base, data: { prompts: [], answers: [] }, key: {} }
  }
}

/** Rows of free-text answers (identification accepted answers, enum items, ...). */
function StringList({
  values,
  set,
  placeholder,
  addLabel
}: {
  values: string[]
  set: (next: string[]) => void
  placeholder: string
  addLabel: string
}): React.JSX.Element {
  return (
    <div className="string-list">
      {values.map((value, i) => (
        <div className="choice-row" key={i}>
          <input
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => set(values.map((v, j) => (j === i ? e.target.value : v)))}
          />
          <button className="mini" title="Remove" onClick={() => set(values.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="secondary" onClick={() => set([...values, ''])}>
        {addLabel}
      </button>
    </div>
  )
}

/** A side list of {id, text} items (mcq options, matching sides, connect columns). */
function ChoiceList({
  items,
  set,
  placeholder,
  addLabel
}: {
  items: Choice[]
  set: (next: Choice[]) => void
  placeholder: string
  addLabel: string
}): React.JSX.Element {
  return (
    <div className="string-list">
      {items.map((item, i) => (
        <div className="choice-row" key={item.id}>
          <input
            type="text"
            value={item.text}
            placeholder={`${placeholder} ${i + 1}`}
            onChange={(e) => set(items.map((c, j) => (j === i ? { ...c, text: e.target.value } : c)))}
          />
          <button className="mini" title="Remove" onClick={() => set(items.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="secondary" onClick={() => set([...items, { id: uid('c'), text: '' }])}>
        {addLabel}
      </button>
    </div>
  )
}

/** Body, points, and the type-specific fields of one question. */
export function QuestionForm({
  question,
  onChange
}: {
  question: StoredQuestion
  onChange: (next: StoredQuestion) => void
}): React.JSX.Element {
  // Editing a fill-in body keeps the per-blank answer lists in step with the ___ count.
  const changeBody = (body: string): void => {
    let key = question.key
    if (question.type === 'fillin') {
      const current = asBlankAnswers(question.key)
      key = Array.from({ length: countBlanks(body) }, (_, i) => current[i] ?? [])
    }
    onChange({ ...question, body, key })
  }

  const changePoints = (raw: string): void => {
    const n = Number(raw)
    onChange({ ...question, points: raw === '' || !Number.isFinite(n) ? 0 : n })
  }

  return (
    <div className="q-form">
      <div className="q-form-head">
        <label className="field grow">
          <span>Question</span>
          <textarea
            rows={2}
            value={question.body}
            placeholder="Type the question…"
            onChange={(e) => changeBody(e.target.value)}
          />
        </label>
        <label className="field points">
          <span>Points</span>
          <input
            type="number"
            min={1}
            step={1}
            value={question.points}
            onChange={(e) => changePoints(e.target.value)}
          />
        </label>
      </div>
      {renderTypeForm(question, onChange)}
    </div>
  )
}

function renderTypeForm(
  q: StoredQuestion,
  change: (next: StoredQuestion) => void
): React.JSX.Element {
  switch (q.type) {
    case 'mcq':
      return <McqForm q={q} change={change} />
    case 'tf':
      return <TfForm q={q} change={change} />
    case 'identification':
      return <IdentificationForm q={q} change={change} />
    case 'fillin':
      return <FillinForm q={q} change={change} />
    case 'enumeration':
      return <EnumerationForm q={q} change={change} />
    case 'problem':
      return <ProblemForm q={q} change={change} />
    case 'matching':
      return (
        <PairEditor q={q} change={change} from="left" to="right" fromLabel="Left items" toLabel="Right items (extras are allowed)" />
      )
    case 'connect':
      return (
        <PairEditor q={q} change={change} from="prompts" to="answers" fromLabel="Prompts" toLabel="Answers (decoys are allowed)" />
      )
  }
}

/** mcq: options with exactly one marked correct. */
function McqForm({
  q,
  change
}: {
  q: StoredQuestion
  change: (next: StoredQuestion) => void
}): React.JSX.Element {
  const options = q.data.options ?? []
  const correct = typeof q.key === 'string' ? q.key : null
  const setOptions = (next: Choice[], key: StoredKey = q.key): void =>
    change({ ...q, data: { ...q.data, options: next }, key })

  return (
    <div className="type-form">
      <span className="field-label">Options — mark the correct one</span>
      <div className="string-list">
        {options.map((option, i) => (
          <div className="choice-row" key={option.id}>
            <input
              type="radio"
              name={`correct-${q.id}`}
              title="Correct answer"
              checked={correct === option.id}
              onChange={() => change({ ...q, key: option.id })}
            />
            <input
              type="text"
              value={option.text}
              placeholder={`Option ${i + 1}`}
              onChange={(e) =>
                setOptions(options.map((o, j) => (j === i ? { ...o, text: e.target.value } : o)))
              }
            />
            <button
              className="mini"
              title="Remove"
              onClick={() =>
                setOptions(
                  options.filter((_, j) => j !== i),
                  correct === option.id ? null : q.key
                )
              }
            >
              ✕
            </button>
          </div>
        ))}
        <button className="secondary" onClick={() => setOptions([...options, { id: uid('o'), text: '' }])}>
          Add option
        </button>
      </div>
    </div>
  )
}

/** tf: pick true or false. */
function TfForm({
  q,
  change
}: {
  q: StoredQuestion
  change: (next: StoredQuestion) => void
}): React.JSX.Element {
  return (
    <div className="type-form">
      <span className="field-label">Correct answer</span>
      <label className="tf-choice">
        <input type="radio" checked={q.key === true} onChange={() => change({ ...q, key: true })} /> True
      </label>
      <label className="tf-choice">
        <input type="radio" checked={q.key === false} onChange={() => change({ ...q, key: false })} /> False
      </label>
    </div>
  )
}

/** identification: one or more accepted answers (compared ignoring case/spacing). */
function IdentificationForm({
  q,
  change
}: {
  q: StoredQuestion
  change: (next: StoredQuestion) => void
}): React.JSX.Element {
  const accepted = asStringArray(q.key)
  return (
    <div className="type-form">
      <span className="field-label">Accepted answers (case and spacing are ignored)</span>
      <StringList
        values={accepted}
        set={(next) => change({ ...q, key: next })}
        placeholder="Accepted answer"
        addLabel="Add answer"
      />
    </div>
  )
}

/** fillin: accepted answers per ___ blank of the body. */
function FillinForm({
  q,
  change
}: {
  q: StoredQuestion
  change: (next: StoredQuestion) => void
}): React.JSX.Element {
  const blanks = countBlanks(q.body)
  const perBlank = asBlankAnswers(q.key)
  const setBlank = (index: number, answers: string[]): void => {
    const next = Array.from({ length: blanks }, (_, i) => perBlank[i] ?? [])
    next[index] = answers
    change({ ...q, key: next })
  }

  return (
    <div className="type-form">
      <span className="field-label">
        Accepted answers per blank — the question text needs a ___ for each blank
      </span>
      {blanks === 0 && <p className="muted">No blanks yet.</p>}
      {Array.from({ length: blanks }, (_, i) => (
        <div className="blank-group" key={i}>
          <span className="blank-label">Blank {i + 1}</span>
          <StringList
            values={perBlank[i] ?? []}
            set={(answers) => setBlank(i, answers)}
            placeholder="Accepted answer"
            addLabel="Add answer"
          />
        </div>
      ))}
    </div>
  )
}

/** enumeration: how many items to collect plus the accepted items (order ignored). */
function EnumerationForm({
  q,
  change
}: {
  q: StoredQuestion
  change: (next: StoredQuestion) => void
}): React.JSX.Element {
  const accepted = asStringArray(q.key)
  const setCount = (raw: string): void => {
    const n = Number(raw)
    change({ ...q, data: { ...q.data, count: raw === '' || !Number.isFinite(n) ? 0 : n } })
  }

  return (
    <div className="type-form">
      <div className="inline-fields">
        <label className="field narrow">
          <span>How many items</span>
          <input type="number" min={1} step={1} value={q.data.count ?? ''} onChange={(e) => setCount(e.target.value)} />
        </label>
      </div>
      <span className="field-label">Accepted items (the order does not matter)</span>
      <StringList
        values={accepted}
        set={(next) => change({ ...q, key: next })}
        placeholder="Accepted item"
        addLabel="Add item"
      />
    </div>
  )
}

/** problem: the final answer text plus an optional numeric tolerance. */
function ProblemForm({
  q,
  change
}: {
  q: StoredQuestion
  change: (next: StoredQuestion) => void
}): React.JSX.Element {
  const key = asProblemKey(q.key)
  return (
    <div className="type-form">
      <div className="inline-fields">
        <label className="field grow">
          <span>Final answer</span>
          <input
            type="text"
            value={key.answer}
            placeholder="e.g. 15 €"
            onChange={(e) => change({ ...q, key: { ...key, answer: e.target.value } })}
          />
        </label>
        <label className="field narrow">
          <span>Tolerance (optional)</span>
          <input
            type="number"
            min={0}
            step="any"
            value={key.tolerance ?? ''}
            placeholder="0"
            onChange={(e) => {
              const raw = e.target.value
              if (raw === '') {
                const { tolerance: _drop, ...rest } = key
                change({ ...q, key: rest })
                return
              }
              const n = Number(raw)
              if (Number.isFinite(n)) change({ ...q, key: { ...key, tolerance: n } })
            }}
          />
        </label>
      </div>
    </div>
  )
}

/**
 * matching and connect: two lists plus one pair selector per from-item.
 * Extra to-items (right decoys / unused answers) are allowed.
 */
function PairEditor({
  q,
  change,
  from,
  to,
  fromLabel,
  toLabel
}: {
  q: StoredQuestion
  change: (next: StoredQuestion) => void
  from: 'left' | 'prompts'
  to: 'right' | 'answers'
  fromLabel: string
  toLabel: string
}): React.JSX.Element {
  const fromItems = q.data[from] ?? []
  const toItems = q.data[to] ?? []
  const map = asPairMap(q.key)

  const setFromItems = (next: typeof fromItems): void => {
    const ids = new Set(next.map((c) => c.id))
    const key = Object.fromEntries(Object.entries(map).filter(([id]) => ids.has(id)))
    change({ ...q, data: { ...q.data, [from]: next }, key })
  }

  const setToItems = (next: typeof toItems): void => {
    const ids = new Set(next.map((c) => c.id))
    const key = Object.fromEntries(Object.entries(map).filter(([, target]) => ids.has(target)))
    change({ ...q, data: { ...q.data, [to]: next }, key })
  }

  const setPair = (fromId: string, toId: string): void => {
    const key = { ...map }
    if (toId === '') delete key[fromId]
    else key[fromId] = toId
    change({ ...q, key })
  }

  return (
    <div className="type-form">
      <div className="pair-grid">
        <div className="pair-col">
          <span className="field-label">{fromLabel}</span>
          <ChoiceList items={fromItems} set={setFromItems} placeholder="Item" addLabel={`Add ${from === 'left' ? 'left item' : 'prompt'}`} />
        </div>
        <div className="pair-col">
          <span className="field-label">{toLabel}</span>
          <ChoiceList items={toItems} set={setToItems} placeholder="Item" addLabel={`Add ${to === 'right' ? 'right item' : 'answer'}`} />
        </div>
      </div>
      <span className="field-label">Pairs</span>
      {fromItems.length === 0 && <p className="muted">Add items first.</p>}
      {fromItems.map((item, i) => (
        <div className="pair-row" key={item.id}>
          <span className="pair-name">{item.text || `#${i + 1}`}</span>
          <select value={map[item.id] ?? ''} onChange={(e) => setPair(item.id, e.target.value)}>
            <option value="">— not paired —</option>
            {toItems.map((target, j) => (
              <option key={target.id} value={target.id}>
                {target.text || `#${j + 1}`}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  )
}