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

  test('shows an abort action for a running bash call and disables it while abort is pending', () => {
    const html = renderToStaticMarkup(
      <ToolCallDetail
        name="bash"
        input={{ command: 'sleep 30' }}
        status="running"
        abortPending
        onAbort={() => {}}
      />,
    )

    expect(html).toContain('Aborting...')
    expect(html).toContain('disabled=""')
  })

  test('renders aborted bash output with the abort footer', () => {
    const html = renderToStaticMarkup(
      <ToolCallDetail
        name="bash"
        input={{ command: 'sleep 30' }}
        result={'start\n\n[abort]\nCommand aborted by user from Session Detail.'}
        summary="Command aborted: sleep 30"
        isError
      />,
    )

    expect(html).toContain('start')
    expect(html).toContain('[abort]')
    expect(html).toContain('Command aborted by user from Session Detail.')
  })

  test('renders evidence path hash and character count for compacted tool IO', () => {
    const html = renderToStaticMarkup(
      <ToolCallDetail
        name="bash"
        input={{ command: 'rg tool_result packages/core/src' }}
        result="summary only"
        evidence={[
          {
            kind: 'tool_result_output',
            toolUseId: 'call_1',
            toolName: 'bash',
            path: '/repo/.artifacts/sess_1/tool-evidence/call_1-tool_result_output-bash.txt',
            chars: 12345,
            sha256: 'abcdef1234567890',
          },
        ]}
      />,
    )

    expect(html).toContain('Evidence')
    expect(html).toContain('tool_result_output')
    expect(html).toContain('12,345 chars')
    expect(html).toContain('sha256 abcdef123456')
    expect(html).toContain('/repo/.artifacts/sess_1/tool-evidence')
  })

  test('does not show an abort action for completed bash calls', () => {
    const html = renderToStaticMarkup(
      <ToolCallDetail
        name="bash"
        input={{ command: 'pwd' }}
        result="/tmp/demo"
        summary="Executed: pwd"
        status="success"
        onAbort={() => {}}
      />,
    )

    expect(html).not.toContain('Abort')
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

  test('renders read_image structured content as an image preview', () => {
    const html = renderToStaticMarkup(
      <ToolCallDetail
        name="read_image"
        input={{ path: '/tmp/screenshot.png' }}
        result="Read image /tmp/screenshot.png (image/png, 3 bytes)"
        contentItems={[{ type: 'image', mediaType: 'image/png', data: 'aW1n' }]}
        isError={false}
      />,
    )

    expect(html).toContain('data-tool-renderer="read_image"')
    expect(html).toContain('/tmp/screenshot.png')
    expect(html).toContain('Image Read Summary')
    expect(html).toContain('src="data:image/png;base64,aW1n"')
    expect(html).toContain('alt="/tmp/screenshot.png"')
  })

  test('renders read_image imageRef when inline data is not persisted', () => {
    const html = renderToStaticMarkup(
      <ToolCallDetail
        name="read_image"
        input={{ path: '/tmp/screenshot.png' }}
        result="Read image /tmp/screenshot.png (image/png, 3 bytes)"
        contentItems={[
          {
            type: 'image',
            mediaType: 'image/png',
            imageRef: {
              path: '/tmp/session/images/hash.png',
              relativePath: 'images/hash.png',
              sha256: 'hash',
              bytes: 3,
            },
          },
        ]}
        isError={false}
      />,
    )

    expect(html).toContain('data-tool-renderer="read_image"')
    expect(html).not.toContain('data:image/png;base64')
    expect(html).toContain('images/hash.png')
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
    expect(summarizeToolInput('read_image', { path: '/tmp/demo.png' })).toBe('/tmp/demo.png')
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
