import type { Asset, Evidence, Project } from './types'

// Character n-grams retrieve narrative anchors (objects, actions, relationships),
// not just names. They only retrieve text; the model must establish identity.
export const narrativeTerms = (s: string) => {
  const out = new Set<string>()
  for (const word of s.match(/[\p{L}\p{N}]+/gu) ?? [])
    for (let n = 2; n <= 4; n++)
      for (let i = 0; i + n <= word.length; i++) out.add(word.slice(i, i + n))
  return out
}
const reveal = /就是|正是|原来|原名|真名|本名|名叫|唤作|当初|那晚|那名|声音|认出|先前|之前|曾经/g

export function narrativePassages(
  project: Project,
  source: string,
  subject: Asset,
  own: Evidence[],
) {
  const passages: { chapterId: string; start: number; end: number; text: string }[] = []
  for (const chapter of project.chapters)
    for (let start = chapter.start; start < chapter.end; start += 600) {
      const end = Math.min(chapter.end, start + 1000)
      passages.push({ chapterId: chapter.id, start, end, text: source.slice(start, end) })
    }
  const semantic = narrativeTerms(subject.descriptions.join('\n'))
  const query = narrativeTerms(
    [
      ...subject.descriptions,
      ...own.map((e) =>
        source.slice(Math.max(0, e.start - 500), Math.min(source.length, e.end + 1800)),
      ),
    ].join('\n'),
  )
  const frequency = new Map<string, number>()
  const indexed = passages.map((p) => {
    const terms = [...narrativeTerms(p.text)].filter((g) => query.has(g))
    for (const g of terms) frequency.set(g, (frequency.get(g) ?? 0) + 1)
    return { p, terms }
  })
  const ranked = indexed
    .map(({ p, terms }) => {
      const score = terms.reduce(
        (s, g) =>
          s + Math.log(1 + passages.length / (frequency.get(g) ?? 1)) * (semantic.has(g) ? 5 : 1),
        0,
      )
      const cues = Math.min(6, [...p.text.matchAll(reveal)].length)
      return { ...p, score: score * (1 + cues * 0.3) }
    })
    .sort((a, b) => b.score - a.score || a.start - b.start)
  const selected: typeof ranked = []
  for (const p of ranked) {
    if (
      !p.score ||
      selected.some((s) => s.chapterId === p.chapterId && Math.abs(s.start - p.start) < 1000)
    )
      continue
    selected.push(p)
    if (selected.length === 16) break
  }
  return {
    passages: selected,
    searchedPassages: passages.length,
    selectedPassages: selected.length,
  }
}
