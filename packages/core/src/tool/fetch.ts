import { Readability } from '@mozilla/readability'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { toErrorMessage } from '@zero-os/shared'
import { Effect, Option } from 'effect'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'
import { BaseTool } from './base'

type FetchFormat = 'auto' | 'html' | 'json' | 'text'

interface FetchInput {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  format?: FetchFormat
  timeout?: number
  credentialRef?: string
}

const MAX_BODY_LENGTH = 100_000
const DEFAULT_TIMEOUT = 30_000

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})

export class FetchTool extends BaseTool {
  kind = 'built-in' as const
  name = 'fetch'
  description = 'HTTP 请求，读取网页内容 / API / 下载文件。HTML 自动转 Markdown。'
  parameters = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Target URL' },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
        description: 'HTTP method (default GET)',
      },
      headers: {
        type: 'object',
        description: 'Additional HTTP headers',
        additionalProperties: { type: 'string' },
      },
      body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
      format: {
        type: 'string',
        enum: ['auto', 'html', 'json', 'text'],
        description: 'Response format hint (default auto, determined by Content-Type)',
      },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
      credentialRef: {
        type: 'string',
        description: 'Secret vault key to inject as Authorization Bearer token',
      },
    },
    required: ['url'],
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const {
      url,
      method = 'GET',
      headers = {},
      body,
      format = 'auto',
      timeout = DEFAULT_TIMEOUT,
      credentialRef,
    } = input as FetchInput

    if (!url) {
      return {
        success: false,
        output: 'Missing required parameter: url',
        outputSummary: 'Missing url',
      }
    }

    // Resolve credential if specified
    const reqHeaders: Record<string, string> = { ...headers }
    if (credentialRef) {
      if (!ctx.secretResolver) {
        return {
          success: false,
          output: 'credentialRef specified but no secretResolver available in context',
          outputSummary: 'No secret resolver',
        }
      }
      const secret = ctx.secretResolver(credentialRef)
      if (!secret) {
        return {
          success: false,
          output: `Credential "${credentialRef}" not found in vault`,
          outputSummary: 'Credential not found',
        }
      }
      reqHeaders.Authorization = `Bearer ${secret}`
    }

    // Set default User-Agent if not provided
    if (!reqHeaders['User-Agent'] && !reqHeaders['user-agent']) {
      reqHeaders['User-Agent'] = 'ZeRo-OS/1.0'
    }

    const upperMethod = method.toUpperCase()
    return await Effect.runPromise(
      Effect.gen(function* () {
        // tryPromise wires fiber interruption into the AbortSignal, so the
        // timeout below cancels the in-flight request for real instead of
        // merely abandoning the promise (the old timer + controller.abort).
        const response = yield* Effect.timeoutOption(
          Effect.tryPromise({
            try: (signal) =>
              fetch(url, {
                method: upperMethod,
                headers: reqHeaders,
                body: body && upperMethod !== 'GET' && upperMethod !== 'HEAD' ? body : undefined,
                signal,
                redirect: 'follow',
              }),
            catch: (error) => new Error(toErrorMessage(error)),
          }),
          timeout,
        )
        if (Option.isNone(response)) {
          return {
            success: false,
            output: `Request timed out after ${timeout}ms: ${url}`,
            outputSummary: 'Timeout',
          }
        }
        return yield* Effect.promise(() => shapeResponse(response.value, format))
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            output: `Fetch failed: ${error.message}`,
            outputSummary: `Fetch error: ${error.message.slice(0, 80)}`,
          }),
        ),
      ),
    )
  }
}

async function shapeResponse(response: Response, format: FetchFormat): Promise<ToolResult> {
  try {
    const status = response.status
    const contentType = response.headers.get('content-type') ?? ''

    // Determine effective format
    const effectiveFormat = resolveFormat(format, contentType)

    let outputBody: string
    let truncated = false

    if (effectiveFormat === 'json') {
      const text = await response.text()
      try {
        const parsed = JSON.parse(text)
        outputBody = JSON.stringify(parsed, null, 2)
      } catch {
        outputBody = text
      }
    } else if (effectiveFormat === 'html') {
      const html = await response.text()
      try {
        outputBody = htmlToMarkdown(html, response.url)
      } catch {
        outputBody = html
      }
    } else {
      outputBody = await response.text()
    }

    // Truncate if too long
    if (outputBody.length > MAX_BODY_LENGTH) {
      truncated = true
      outputBody = `${outputBody.slice(0, MAX_BODY_LENGTH)}\n\n[Content truncated at 100,000 characters]`
    }

    const statusPrefix = `HTTP ${status}`
    const summary = truncated
      ? `${statusPrefix} — ${outputBody.length} chars (truncated)`
      : `${statusPrefix} — ${outputBody.length} chars`

    return {
      success: status >= 200 && status < 400,
      output: `${statusPrefix}\n\n${outputBody}`,
      outputSummary: summary,
    }
  } catch (error) {
    const msg = toErrorMessage(error)
    return {
      success: false,
      output: `Fetch failed: ${msg}`,
      outputSummary: `Fetch error: ${msg.slice(0, 80)}`,
    }
  }
}

function resolveFormat(format: FetchFormat, contentType: string): 'html' | 'json' | 'text' {
  if (format !== 'auto') return format === 'html' ? 'html' : format === 'json' ? 'json' : 'text'

  const ct = contentType.toLowerCase()
  if (ct.includes('application/json') || ct.includes('+json')) return 'json'
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return 'html'
  return 'text'
}

function htmlToMarkdown(html: string, _url: string): string {
  const { document } = parseHTML(html)

  // Use Readability to extract main content
  const reader = new Readability(document as unknown as Document, { charThreshold: 0 })
  const article = reader.parse()

  if (article?.content) {
    const md = turndown.turndown(article.content)
    const title = article.title ? `# ${article.title}\n\n` : ''
    return `${title}${md}`
  }

  // Fallback: convert full body
  const bodyHtml = document.querySelector('body')?.innerHTML ?? html
  return turndown.turndown(bodyHtml)
}
