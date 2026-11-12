export const HOUR = 3600_000
export const DAY = 24 * HOUR

export const digits = (s?: string | null) => (s ?? '').split('@')[0].split(':')[0].replace(/\D/g, '')
export const pnJid = (pn?: string | null) => (pn ? `${pn}@s.whatsapp.net` : null)
export const toCsv = (v: unknown) => (Array.isArray(v) && v.length ? `,${v.join(',')},` : '')
export const fromCsv = (s?: string | null) => (s ?? '').split(',').filter(Boolean)
export const firstName = (name?: string | null) => (name ?? '').trim().split(/\s+/)[0] || 'there'

const COMPANY_NOISE = new Set([
  'pvt', 'ltd', 'limited', 'private', 'inc', 'llp', 'llc', 'corp', 'corporation', 'co', 'company',
  'technologies', 'technology', 'tech', 'solutions', 'services', 'india', 'global', 'group', 'the',
])

/** "Infosys Ltd." and "infosys" should count as the same company. */
export function normCompany(name?: string | null): string {
  const tokens = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  const kept = tokens.filter((t) => !COMPANY_NOISE.has(t))
  return (kept.length ? kept : tokens).join(' ')
}

export function sameCompany(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  const [x, y] = [a.split(' '), b.split(' ')]
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.every((t) => long.includes(t))
}
