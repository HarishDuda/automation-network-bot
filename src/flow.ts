// A small question engine: which question is next, is the reply valid, and how to show it.

export type Option = { value: string; label: string; min?: number; max?: number; exclusive?: boolean }
export type Cond = { q: string; in?: string[]; notIn?: string[]; matches?: string; notMatches?: string }
export type Question = {
  id: string
  label: string
  text: string
  type: 'text' | 'number' | 'choice' | 'multi' | 'url'
  options?: Option[]
  optionsFrom?: string
  optional?: boolean
  allowOther?: boolean
  min?: number
  max?: number
  maxLength?: number
  showIf?: Cond[]
}
export type Answer = string | number | string[] | null
export type Answers = Record<string, Answer>
export type Parsed = { ok: true; value: Answer; other?: string } | { ok: false; error: string }

const SKIP = new Set(['skip', '-', 'na', 'n/a', 'none', 'no'])

export function visible(q: Question, a: Answers): boolean {
  return (q.showIf ?? []).every((c) => {
    const v = a[c.q]
    const vals = Array.isArray(v) ? v : v == null ? [] : [String(v).trim()]
    if (c.in && !vals.some((x) => c.in!.includes(x))) return false
    if (c.notIn && vals.some((x) => c.notIn!.includes(x))) return false
    if (c.matches && !vals.some((x) => new RegExp(c.matches!, 'i').test(x))) return false
    if (c.notMatches && vals.some((x) => new RegExp(c.notMatches!, 'i').test(x))) return false
    return true
  })
}

/** The first question that should be shown and has no answer yet. */
export function nextQuestion(qs: Question[], a: Answers): Question | undefined {
  return qs.find((q) => visible(q, a) && !(q.id in a))
}

/** Drop answers to questions that are no longer shown (e.g. notice period after "not open to work"). */
export function prune(qs: Question[], a: Answers) {
  for (const q of qs) {
    if (!visible(q, a)) {
      delete a[q.id]
      delete a[q.id + '_other']
    }
  }
}

export function renderQuestion(q: Question, position?: string): string {
  const lines = [position ? `${q.text}  _(${position})_` : q.text]
  if (q.options) {
    lines.push('')
    q.options.forEach((o, i) => lines.push(`*${i + 1}.* ${o.label}`))
  }
  const hints: string[] = []
  if (q.type === 'choice') hints.push('Reply with a number.')
  if (q.type === 'multi') {
    hints.push('Reply with the numbers, separated by commas (e.g. 1,3).')
    if (q.allowOther) hints.push("You can also type one that isn't listed.")
  }
  if (q.optional) hints.push('Reply *skip* to leave it blank.')
  if (hints.length) lines.push('', `_${hints.join(' ')}_`)
  return lines.join('\n')
}

export function parseAnswer(q: Question, raw: string): Parsed {
  const input = raw.trim()
  if (q.optional && SKIP.has(input.toLowerCase())) return { ok: true, value: null }
  if (!input) return { ok: false, error: "I didn't get that." }
  const opts = q.options ?? []

  switch (q.type) {
    case 'text': {
      const max = q.maxLength ?? 100
      if (input.length < 2) return { ok: false, error: 'That looks too short.' }
      if (input.length > max) return { ok: false, error: `Please keep it under ${max} characters.` }
      return { ok: true, value: input.replace(/\s+/g, ' ') }
    }
    case 'number': {
      if (!/^\d{1,3}$/.test(input)) return { ok: false, error: 'Please reply with a number.' }
      const n = Number(input)
      if (n < (q.min ?? 0) || n > (q.max ?? 999)) {
        return { ok: false, error: `Please reply with a number between ${q.min ?? 0} and ${q.max ?? 999}.` }
      }
      return { ok: true, value: n }
    }
    case 'choice': {
      const n = /^\d+$/.test(input) ? Number(input) : 0
      const hit = opts[n - 1] ?? opts.find((o) => o.label.toLowerCase() === input.toLowerCase())
      if (!hit) return { ok: false, error: `Please reply with a number from 1 to ${opts.length}.` }
      return { ok: true, value: hit.value }
    }
    case 'multi': {
      const values: string[] = []
      const other: string[] = []
      const tokens = input
        .split(/[,;\n]+/)
        .flatMap((t) => (/^[\d\s]+$/.test(t) ? t.trim().split(/\s+/) : [t.trim()]))
        .filter(Boolean)
      for (const t of tokens) {
        if (/^\d+$/.test(t)) {
          const o = opts[Number(t) - 1]
          if (!o) return { ok: false, error: `${t} isn't one of the options (1 to ${opts.length}).` }
          if (!values.includes(o.value)) values.push(o.value)
        } else {
          const o = opts.find((x) => x.label.toLowerCase() === t.toLowerCase())
          if (o) {
            if (!values.includes(o.value)) values.push(o.value)
          } else if (q.allowOther) {
            other.push(t)
          } else {
            return { ok: false, error: 'Please reply with the option numbers, e.g. 1,3.' }
          }
        }
      }
      const exclusive = opts.find((o) => o.exclusive && values.includes(o.value))
      if (exclusive && values.length > 1) return { ok: false, error: `"${exclusive.label}" can't be combined with other options.` }
      if (!values.length && !other.length) return { ok: false, error: 'Please pick at least one.' }
      const otherText = other.join(', ').slice(0, 100)
      return other.length ? { ok: true, value: values, other: otherText } : { ok: true, value: values }
    }
    case 'url': {
      if (!/^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(input)) {
        return { ok: false, error: "That doesn't look like a link." }
      }
      return { ok: true, value: /^https?:\/\//i.test(input) ? input : 'https://' + input }
    }
  }
}

/** A readable version of one answer, for summaries. */
export function displayAnswer(q: Question, a: Answers): string {
  const v = a[q.id]
  const other = a[q.id + '_other'] as string | undefined
  const label = (x: string) => q.options?.find((o) => o.value === x)?.label ?? x
  if (Array.isArray(v)) return [...v.map(label), ...(other ? [other] : [])].join(', ') || '—'
  if (v == null || v === '') return '—'
  return q.options ? label(String(v)) : String(v)
}

export function summarize(qs: Question[], a: Answers, numbered = false): string {
  return qs
    .filter((q) => visible(q, a))
    .map((q, i) => `${numbered ? `*${i + 1}.* ` : '• '}${q.label}: ${displayAnswer(q, a)}`)
    .join('\n')
}
