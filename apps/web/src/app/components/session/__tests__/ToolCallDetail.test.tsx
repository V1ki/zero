import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolCallDetail, summarizeToolInput } from '../ToolCallDetail'

describe('ToolCallDetail', () => {
  test('renders bash output with separated stdout and stderr panes', () => {
    const html = renderToStaticMarkup(
      <ToolCallDetail
        name="bash"
        input={{ command: 'ls -la', timeout: 5000 }}
        result={'stdout line\n[stderr]\nstderr line'}
        durationMs={1280}
      />,
    )

    expect(html).toContain('data-tool-renderer="bash"')
    expect(html).toContain('ls -la')
    expect(html).toContain('stdout line')
    expect(html).toContain('stderr')
    expect(html).toContain('stderr line')
    expect(html).toContain('ran 1.3s')
  })

  test('renders edit payloads as a diff-like replacement preview', () => {
    const html = renderToStaticMarkup(
      <ToolCallDetail
        name="edit"
        input={{
          path: 'apps/web/src/demo.ts',
          oldText: 'const version = 1\nconsole.log(version)\n',
          newText: 'const version = 2\nconsole.log(version)\n',
        }}
        result="Updated successfully"
      />,
    )

    expect(html).toContain('data-tool-renderer="edit"')
    expect(html).toContain('apps/web/src/demo.ts')
    expect(html).toContain('Patch Preview')
    expect(html).toContain('const version = 1')
    expect(html).toContain('const version = 2')
    expect(html).toContain('Updated successfully')
  })

  test('suppresses generic success markers and shows tool-specific summaries', () => {
    const writeHtml = renderToStaticMarkup(
      <ToolCallDetail
        name="write"
        input={{ path: '/tmp/demo.py', content: 'print("hello")\n' }}
        result="✓ success"
        summary="Wrote /tmp/demo.py"
      />,
    )

    const bashHtml = renderToStaticMarkup(
      <ToolCallDetail
        name="bash"
        input={{ command: 'pwd' }}
        result="✓ success"
        summary="Executed: pwd"
      />,
    )

    expect(writeHtml).toContain('Write Target')
    expect(writeHtml).toContain('Wrote /tmp/demo.py')
    expect(writeHtml).not.toContain('✓ success')
    expect(bashHtml).toContain('did not persist stdout/stderr')
    expect(bashHtml).not.toContain('✓ success')
  })

  test('lets bash fall back to a meaningful summary when stdout was not persisted separately', () => {
    const html = renderToStaticMarkup(
      <ToolCallDetail
        name="bash"
        input={{ command: 'scp demo.py remote:/tmp/demo.py' }}
        result="✓ success"
        summary="Copied demo.py to remote:/tmp/demo.py"
      />,
    )

    expect(html).toContain('Copied demo.py to remote:/tmp/demo.py')
    expect(html).not.toContain('did not persist stdout/stderr')
  })

  test('renders fetch responses with status and formatted json', () => {
    const html = renderToStaticMarkup(
      <ToolCallDetail
        name="fetch"
        input={{ method: 'POST', url: 'https://example.com/api', format: 'json' }}
        result={'HTTP 200\n\n{"ok":true,"items":[1,2]}'}
      />,
    )

    expect(html).toContain('data-tool-renderer="fetch"')
    expect(html).toContain('POST')
    expect(html).toContain('HTTP 200')
    expect(html).toContain('https://example.com/api')
    expect(html).toContain('&quot;ok&quot;: true')
    expect(html).toContain('&quot;items&quot;: [')
  })

  test('renders dedicated memory tool details for writes and searches', () => {
    const memoryHtml = renderToStaticMarkup(
      <ToolCallDetail
        name="memory"
        input={{
          action: 'create',
          type: 'note',
          title: 'Rollback checklist',
          tags: ['deploy', 'rollback'],
          content: 'Remember to pause rollout before restoring the image.',
        }}
        summary="Created memory: Rollback checklist"
      />,
    )

    const searchHtml = renderToStaticMarkup(
      <ToolCallDetail
        name="memory_search"
        input={{ query: 'deployment rollback' }}
        summary="Found 2 relevant memories"
      />,
    )

    expect(memoryHtml).toContain('data-tool-renderer="memory"')
    expect(memoryHtml).toContain('Rollback checklist')
    expect(memoryHtml).toContain('deploy')
    expect(memoryHtml).toContain('Memory Content')
    expect(searchHtml).toContain('data-tool-renderer="memory_search"')
    expect(searchHtml).toContain('deployment rollback')
    expect(searchHtml).toContain('Found 2 relevant memories')
  })

  test('summarizes tool inputs using tool-specific metadata', () => {
    expect(summarizeToolInput('bash', { command: 'echo hello' })).toBe('echo hello')
    expect(summarizeToolInput('read', { path: '/tmp/demo.txt' })).toBe('/tmp/demo.txt')
    expect(summarizeToolInput('fetch', { method: 'POST', url: 'https://example.com' })).toBe(
      'POST https://example.com',
    )
    expect(
      summarizeToolInput('memory', {
        action: 'create',
        type: 'note',
        title: 'Rollback checklist',
      }),
    ).toBe('create note Rollback checklist')
  })
})
