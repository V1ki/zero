import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillDefinition } from '@zero-os/shared'
import matter from 'gray-matter'

/**
 * Load all skills from `.zero/skills/` directory.
 * Each subdirectory should contain a `SKILL.md` file with YAML frontmatter.
 */
export function loadSkills(skillsDir: string): SkillDefinition[] {
  if (!existsSync(skillsDir)) return []

  const entries = readdirSync(skillsDir)
  const skills: SkillDefinition[] = []

  for (const entry of entries) {
    const entryPath = join(skillsDir, entry)
    if (!statSync(entryPath).isDirectory()) continue

    const skillFile = join(entryPath, 'SKILL.md')
    if (!existsSync(skillFile)) continue

    try {
      const raw = readFileSync(skillFile, 'utf-8')
      const { data, content } = matter(raw)

      skills.push({
        name: data.name ?? entry,
        description: data.description ?? '',
        allowedTools: data['allowed-tools'] ?? [],
        content: content.trim(),
        sourcePath: skillFile,
      })
    } catch (err) {
      console.warn(`[skill] Failed to load ${skillFile}:`, err)
    }
  }

  return skills
}
