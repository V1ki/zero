import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceCard } from '@zero-os/shared'
import { SourceCardManager, SourceCardService, toPublicSourceCard } from '../index'

const tempDirs: string[] = []

function createHarness(): {
  manager: SourceCardManager
  service: SourceCardService
} {
  const dir = mkdtempSync(join(tmpdir(), 'zero-source-card-service-'))
  tempDirs.push(dir)
  const manager = new SourceCardManager(dir)
  const service = new SourceCardService(manager)
  return { manager, service }
}

function createCard(overrides: Partial<SourceCard> = {}): SourceCard {
  return {
    schemaVersion: 1,
    id: 'mail-doc',
    title: 'Mail metadata doc',
    state: 'draft',
    sensitivity: 'private',
    tags: ['mail', 'himalaya'],
    sourceDoc: {
      format: 'markdown',
      body: '# Mail metadata doc\n\n## When to use\n- Use for mailbox metadata.\n\n## How to use\n- Use himalaya CLI metadata commands first.\n\n## Safety boundary\n- Do not read body content or attachments without explicit approval.',
    },
    source: {
      sessionId: 'sess_20260512_0000_web_mail',
      summary: 'Mined from existing mail metadata evidence.',
    },
    ...overrides,
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('SourceCardService', () => {
  test('list and get return only the Markdown document card', () => {
    const { manager, service } = createHarness()
    manager.create(createCard())

    const listed = service.list()
    const loaded = service.get('mail-doc')
    const text = JSON.stringify({ listed, loaded })

    expect(loaded?.sourceDoc.format).toBe('markdown')
    expect(loaded?.sourceDoc.body).toContain('himalaya CLI metadata commands')
    expect(text).not.toContain('"credentials"')
    expect(text).not.toContain('"adapter"')
    expect(text).not.toContain('"health"')
    expect(text).not.toContain('external:himalaya/account/qq')
  })

  test('public views redact source document secret material defensively', () => {
    const loaded = toPublicSourceCard({
      ...createCard(),
      sourceDoc: {
        format: 'markdown',
        body: '# Broken note\n\n- authorization=Bearer secret-token',
      },
    })

    expect(loaded.sourceDoc.body).not.toContain('secret-token')
    expect(loaded.sourceDoc.body).toContain('[REDACTED_SECRET]')
  })

  test('validate, activate, and retire form the service surface', () => {
    const { manager, service } = createHarness()
    manager.create(createCard())

    expect(service.validateStored('mail-doc')).toEqual({ ok: true, errors: [] })
    expect(service.activate('mail-doc', { reason: 'manual doc review passed' }).state).toBe(
      'active',
    )
    expect(service.retire('mail-doc', 'source no longer used').state).toBe('retired')
  })

  test('activate and retire require reasons', () => {
    const { manager, service } = createHarness()
    manager.create(createCard())

    expect(() => service.activate('mail-doc', { reason: '' })).toThrow(
      'Activation reason is required',
    )
    expect(() => service.retire('mail-doc', '')).toThrow('Retire reason is required')
  })
})
