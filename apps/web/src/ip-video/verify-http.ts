import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { DEFAULT_SOURCE } from './acceptance'
import { createIPVideoRoutes } from './api'
import { hash } from './extraction'
import { ProjectStore, atomicJson } from './store'

// Socket-free HTTP contract verification, deliberately distinct from live 14432 QA.
const store = new ProjectStore()
const source = readFileSync(DEFAULT_SOURCE, 'utf8')
const project = store.import('从骑奴到大乾武圣', source)
const app = new Hono().route('/api/ip-video', createIPVideoRoutes(store))
const full = await app.request(`/api/ip-video/projects/${project.id}/source`)
if (full.status !== 200 || (await full.text()) !== source) throw new Error('全文HTTP响应不一致')
const chapters: { id: string; status: number; utf16: number; sha256: string; matches: boolean }[] =
  []
for (const chapter of project.chapters) {
  const response = await app.request(`/api/ip-video/projects/${project.id}/chapters/${chapter.id}`)
  const text = await response.text()
  const matches = response.status === 200 && text === source.slice(chapter.start, chapter.end)
  chapters.push({
    id: chapter.id,
    status: response.status,
    utf16: text.length,
    sha256: hash(text),
    matches,
  })
  if (!matches) throw new Error(`章节HTTP全文不一致：${chapter.id}`)
}
const state = await app.request(`/api/ip-video/projects/${project.id}`)
const view = (await state.json()) as { status: string; progress: { total: number } }
const result = {
  at: new Date().toISOString(),
  kind: 'in-process Hono HTTP contract; NOT live 14432',
  projectId: project.id,
  fullSourceMatches: true,
  allChaptersMatch: chapters.every((c) => c.matches),
  sections: chapters.length,
  totalChunks: view.progress.total,
  jobStatus: view.status,
  chapters,
}
const path = join(store.directory(project.id), 'http-integration.json')
atomicJson(path, result)
console.log(
  JSON.stringify({
    kind: result.kind,
    fullSourceMatches: true,
    sections: chapters.length,
    allChaptersMatch: result.allChaptersMatch,
    report: path,
  }),
)
