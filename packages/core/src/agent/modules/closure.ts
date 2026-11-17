import type { ProviderAdapter } from '@zero-os/model'
import type { ClosureLogEntryInput, TaskClosureClassifierResponse, Tracer } from '@zero-os/observe'
import type {
  CompletionResponse,
  Message,
  ReasoningEffort,
  ToolContext,
  ToolLogger,
} from '@zero-os/shared'
import { generateId, now, toErrorMessage } from '@zero-os/shared'
import type { AgentLoopModule } from '../agent-loop'
import type { AgentConfig, AgentContext, AgentObservability } from '../agent-types'
import { CONTEXT_PARAMS } from '../params'
import { buildLoopUserMessage, formatAppliedQueuedIntent } from '../queue'
import {
  TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT,
  type TaskClosureDecision,
  buildTaskClosureDecisionPrompt,
  buildTaskClosurePrompt,
  buildTaskClosurePromptContext,
  extractAssistantText,
  hasAssistantText,
  parseTaskClosureDecision,
} from '../task-closure'

/**
 * Task closure: when an answer ends the turn, a classifier judges whether the task is finished. It
 * runs while the modules evaluate, is recorded as `closure/start|end` (`discarded` when queued
 * messages were taken right after it), and asks for one more try when the classifier says the task
 * goes on. Not evaluated in the request-only phase or for a spawned sub-agent. The classifier reads
 * the queued messages taken into this turn, from the base's `onQueueTaken`.
 */
export function closureModule(options: {
  config: AgentConfig
  closureAdapter: ProviderAdapter
  toolContext: ToolContext
  obs: AgentObservability
  context: Pick<AgentContext, 'reasoningEffort'>
  userMessage: string
  turnIndex: number
  /** Trace span of the request that ended the turn. */
  requestSpanId(): string | undefined
}): AgentLoopModule {
  const { config, closureAdapter, toolContext, obs, context, userMessage, turnIndex } = options
  let appliedQueuedIntentText: string | undefined
  let taskClosureRetryCount = 0
  // 本次评估的结果,定论和决定时读取
  let taskClosureEvaluation: TaskClosureEvaluation = { decision: null, eventPayload: null }
  let shouldEvaluateTaskClosure = false
  let closureStartedAt: number | undefined

  return {
    name: 'task_closure_retry',
    onQueueTaken: (taken) => {
      const intentText = formatAppliedQueuedIntent(taken.queued)
      if (intentText)
        appliedQueuedIntentText = appliedQueuedIntentText
          ? `${appliedQueuedIntentText}\n${intentText}`
          : intentText
    },
    evaluateEndTurn: async (response, ctx) => {
      taskClosureEvaluation = { decision: null, eventPayload: null }
      closureStartedAt = undefined
      shouldEvaluateTaskClosure =
        !toolContext.spawnedByRequestId && !ctx.requestOnly() && hasAssistantText(response.content)
      if (!shouldEvaluateTaskClosure) return

      closureStartedAt = Date.now()
      obs.sessionEvents?.append(toolContext.sessionId, [
        {
          type: 'closure/start',
          data: {
            turnIndex,
            requestId: response.id,
            model: obs.closureModelLabel,
            baseSeq: obs.sessionEvents?.getLastSeq(toolContext.sessionId) ?? undefined,
            messageCount: ctx.messages.length,
          },
        },
      ])
      taskClosureEvaluation = await decideTaskClosure({
        adapter: closureAdapter,
        sessionId: toolContext.sessionId,
        agentName: config.name,
        logger: toolContext.logger,
        tracer: obs.tracer,
        parentSessionId: obs.parentSessionId,
        userMessage,
        appliedQueuedIntentText,
        messages: ctx.messages,
        response,
        reasoningEffort: context.reasoningEffort,
        parentSpanId: options.requestSpanId(),
      })
    },
    settleEndTurn: (response, ctx, queueTaken) => {
      const assistantMsg = ctx.messages[ctx.messages.length - 1]
      const durationMs = closureStartedAt !== undefined ? Date.now() - closureStartedAt : undefined
      if (queueTaken) {
        finalizeTaskClosureSpan({
          tracer: obs.tracer,
          evaluation: taskClosureEvaluation,
          assistantMsg,
          extraMetadata: {
            discardedDuePendingQueue: true,
            originalAction: taskClosureEvaluation.decision?.action ?? null,
            originalReason: taskClosureEvaluation.decision?.reason ?? null,
          },
          extraClosureData: {
            discardedDuePendingQueue: true,
            originalAction: taskClosureEvaluation.decision?.action ?? null,
            originalReason: taskClosureEvaluation.decision?.reason ?? null,
          },
        })
        obs.sessionEvents?.append(toolContext.sessionId, [
          {
            type: 'closure/end',
            data: {
              turnIndex,
              action: 'discarded',
              reason: taskClosureEvaluation.decision?.reason,
              model: obs.closureModelLabel,
              requestId: response.id,
              durationMs,
              detail: {
                discardedDuePendingQueue: true,
                originalAction: taskClosureEvaluation.decision?.action ?? null,
              },
            },
          },
        ])
        return
      }

      // assistant 消息在产生时已写入事件流,不再回头改它;判定结果记在下面的 closure/end 里
      finalizeTaskClosureSpan({
        tracer: obs.tracer,
        evaluation: taskClosureEvaluation,
        assistantMsg,
      })

      if (shouldEvaluateTaskClosure) {
        obs.sessionEvents?.append(toolContext.sessionId, [
          {
            type: 'closure/end',
            data: {
              turnIndex,
              action: taskClosureEvaluation.decision?.action ?? 'finish',
              reason: taskClosureEvaluation.decision?.reason,
              model: obs.closureModelLabel,
              requestId: response.id,
              assistantMessageId: assistantMsg?.id,
              durationMs,
            },
          },
        ])
      }

      if (assistantMsg?.role === 'assistant' && taskClosureEvaluation.eventPayload) {
        const sessionEvent: ClosureLogEntryInput & { spanId?: string } = {
          ...taskClosureEvaluation.eventPayload,
          spanId: taskClosureEvaluation.traceSpanId,
          assistantMessageId: assistantMsg.id,
          assistantMessageCreatedAt: assistantMsg.createdAt,
        }

        obs.bus?.emit('session:update', sessionEvent)
      }
    },
    decideEndTurn: () => {
      if (
        taskClosureEvaluation.decision?.action !== 'continue' ||
        taskClosureRetryCount >= CONTEXT_PARAMS.completion.maxTaskClosureRetries
      )
        return undefined
      return {
        action: 'continue',
        continuationMessage: buildLoopUserMessage({
          sessionId: toolContext.sessionId,
          text: buildTaskClosurePrompt(taskClosureEvaluation.decision.reason),
          controlKind: 'task_closure',
        }),
        commit: () => {
          taskClosureRetryCount++
        },
      }
    },
  }
}

interface TaskClosureClassifierRequest {
  system: string
  prompt: string
  maxTokens: number
}

interface TaskClosureClassifierResult {
  classifierRequest: TaskClosureClassifierRequest
  response: CompletionResponse
  responseText: string
  decision: TaskClosureDecision | null
}

interface PreparedTaskClosureClassifierRequest {
  classifierRequest: TaskClosureClassifierRequest
  classifierMessage: Message
}

type TaskClosureFailedReason = 'invalid_classifier_output' | 'classifier_failed'
type TaskClosureFailureStage = 'parse_classifier_response' | 'request_classifier'

type SessionTaskClosureEvent =
  | {
      sessionId: string
      spanId?: string
      event: 'task_closure_decision'
      action: 'finish' | 'continue' | 'block'
      reason: string
      classifierRequest: TaskClosureClassifierRequest
      classifierResponse?: TaskClosureClassifierResponse
    }
  | {
      sessionId: string
      spanId?: string
      event: 'task_closure_failed'
      reason: TaskClosureFailedReason
      failureStage: TaskClosureFailureStage
      classifierRequest: TaskClosureClassifierRequest
      classifierResponse?: TaskClosureClassifierResponse
      classifierResponseRaw?: string
      error?: string
    }

interface TaskClosureEvaluation {
  decision: TaskClosureDecision | null
  eventPayload: SessionTaskClosureEvent | null
  traceSpanId?: string
  traceSpanStatus?: 'success' | 'error'
}

async function decideTaskClosure(options: {
  adapter: ProviderAdapter
  sessionId: string
  agentName: string
  logger: ToolLogger
  tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan'>
  parentSessionId?: string
  userMessage: string
  appliedQueuedIntentText: string | undefined
  messages: Message[]
  response: CompletionResponse
  reasoningEffort: ReasoningEffort | undefined
  parentSpanId?: string
}): Promise<TaskClosureEvaluation> {
  const taskClosureSpan = options.tracer?.startSpan(
    options.sessionId,
    'task_closure_decision',
    options.parentSpanId,
    {
      kind: 'closure_decision',
      agentName: options.agentName,
    },
  )

  const endSkipped = (skipReason: string): TaskClosureEvaluation => {
    if (taskClosureSpan) {
      options.tracer?.endSpan(taskClosureSpan.id, 'success', {
        called: false,
        skipReason,
        stopReason: options.response.stopReason,
      })
    }
    return {
      decision: null,
      eventPayload: null,
      traceSpanId: taskClosureSpan?.id,
      traceSpanStatus: undefined,
    }
  }

  if (options.response.stopReason === 'tool_use') return endSkipped('tool_use')
  if (!hasAssistantText(options.response.content)) return endSkipped('no_assistant_text')

  const assistantText = extractAssistantText(options.response.content)
  if (!assistantText) return endSkipped('empty_assistant_text')

  const preparedClassifier = prepareTaskClosureClassifierRequest({
    sessionId: options.sessionId,
    userMessage: options.userMessage,
    appliedQueuedIntentText: options.appliedQueuedIntentText,
    messages: options.messages,
    assistantText,
  })
  const classifierRequest = preparedClassifier.classifierRequest

  try {
    const classifier = await requestTaskClosureDecision({
      adapter: options.adapter,
      sessionId: options.sessionId,
      parentSessionId: options.parentSessionId,
      prepared: preparedClassifier,
      reasoningEffort: options.reasoningEffort,
    })
    const validDecision = classifier.decision

    if (validDecision) {
      return recordTaskClosureDecision({
        tracer: options.tracer,
        traceSpanId: taskClosureSpan?.id,
        sessionId: options.sessionId,
        classifier,
        decision: validDecision,
      })
    }

    return recordInvalidTaskClosureClassifierOutput({
      tracer: options.tracer,
      traceSpanId: taskClosureSpan?.id,
      sessionId: options.sessionId,
      classifier,
    })
  } catch (error) {
    options.logger.warn('task_closure_classifier_failed', {
      sessionId: options.sessionId,
      error: toErrorMessage(error),
    })
    const errorMessage = toErrorMessage(error)
    return recordTaskClosureClassifierFailure({
      tracer: options.tracer,
      traceSpanId: taskClosureSpan?.id,
      sessionId: options.sessionId,
      classifierRequest,
      error: errorMessage,
    })
  }
}

function finalizeTaskClosureSpan(options: {
  tracer?: Pick<Tracer, 'updateSpan' | 'endSpan'>
  evaluation: TaskClosureEvaluation
  assistantMsg: Message | undefined
  extraMetadata?: Record<string, unknown>
  extraClosureData?: Record<string, unknown>
}): void {
  const { tracer, evaluation, assistantMsg, extraMetadata, extraClosureData } = options
  if (assistantMsg?.role !== 'assistant' || !evaluation.traceSpanId) return

  tracer?.updateSpan(evaluation.traceSpanId, {
    data: {
      closure: {
        assistantMessageId: assistantMsg.id,
        assistantMessageCreatedAt: assistantMsg.createdAt,
        ...(extraClosureData ?? {}),
      },
    },
    metadata: {
      assistantMessageId: assistantMsg.id,
      assistantMessageCreatedAt: assistantMsg.createdAt,
      ...(extraMetadata ?? {}),
    },
  })

  if (evaluation.traceSpanStatus) {
    tracer?.endSpan(evaluation.traceSpanId, evaluation.traceSpanStatus)
  }
}

function prepareTaskClosureClassifierRequest(options: {
  sessionId: string
  userMessage: string
  appliedQueuedIntentText: string | undefined
  messages: Message[]
  assistantText: string
}): PreparedTaskClosureClassifierRequest {
  const promptContext = buildTaskClosurePromptContext(options.messages)
  const prompt = buildTaskClosureDecisionPrompt(
    options.userMessage,
    options.assistantText,
    promptContext,
    options.appliedQueuedIntentText,
  )
  const classifierRequest: TaskClosureClassifierRequest = {
    system: TASK_CLOSURE_CLASSIFIER_SYSTEM_PROMPT,
    prompt,
    maxTokens: 800,
  }

  const classifierMessage: Message = {
    id: generateId(),
    sessionId: options.sessionId,
    role: 'user',
    messageType: 'message',
    content: [{ type: 'text', text: prompt }],
    createdAt: now(),
  }

  return {
    classifierRequest,
    classifierMessage,
  }
}

async function requestTaskClosureDecision(options: {
  adapter: ProviderAdapter
  sessionId: string
  parentSessionId?: string
  prepared: PreparedTaskClosureClassifierRequest
  reasoningEffort: ReasoningEffort | undefined
}): Promise<TaskClosureClassifierResult> {
  const { classifierMessage, classifierRequest } = options.prepared
  const response = await options.adapter.complete({
    messages: [classifierMessage],
    system: classifierRequest.system,
    stream: false,
    maxTokens: classifierRequest.maxTokens,
    reasoningEffort: options.reasoningEffort,
    meta: {
      sessionId: options.sessionId,
      purpose: 'task_closure',
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    },
  })

  const responseText = extractAssistantText(response.content)
  return {
    classifierRequest,
    response,
    responseText,
    decision: parseTaskClosureDecision(responseText),
  }
}

function recordTaskClosureDecision(options: {
  tracer?: Pick<Tracer, 'updateSpan'>
  traceSpanId?: string
  sessionId: string
  classifier: TaskClosureClassifierResult
  decision: TaskClosureDecision
}): TaskClosureEvaluation {
  const { classifier, decision } = options

  if (options.traceSpanId) {
    options.tracer?.updateSpan(options.traceSpanId, {
      data: {
        closure: {
          event: 'task_closure_decision',
          action: decision.action,
          reason: decision.reason,
          classifierRequest: classifier.classifierRequest,
          classifierResponse: classifier.response,
        },
      },
      metadata: {
        called: true,
        classifierModel: classifier.response.model,
        action: decision.action,
        reason: decision.reason,
        classifierRequest: classifier.classifierRequest,
      },
    })
  }

  return {
    decision,
    eventPayload: {
      event: 'task_closure_decision',
      sessionId: options.sessionId,
      action: decision.action,
      reason: decision.reason,
      classifierRequest: classifier.classifierRequest,
      classifierResponse: classifier.response,
    },
    traceSpanId: options.traceSpanId,
    traceSpanStatus: 'success',
  }
}

function recordInvalidTaskClosureClassifierOutput(options: {
  tracer?: Pick<Tracer, 'updateSpan'>
  traceSpanId?: string
  sessionId: string
  classifier: TaskClosureClassifierResult
}): TaskClosureEvaluation {
  const { classifier } = options

  if (options.traceSpanId) {
    options.tracer?.updateSpan(options.traceSpanId, {
      kind: 'closure_failed',
      name: 'task_closure_failed',
      data: {
        closure: {
          event: 'task_closure_failed',
          reason: 'invalid_classifier_output',
          failureStage: 'parse_classifier_response',
          classifierRequest: classifier.classifierRequest,
          classifierResponse: classifier.response,
          classifierResponseRaw: classifier.responseText,
        },
      },
      metadata: {
        called: true,
        classifierModel: classifier.response.model,
        reason: 'invalid_classifier_output',
        failureStage: 'parse_classifier_response',
        classifierRequest: classifier.classifierRequest,
        classifierResponseRaw: classifier.responseText,
      },
    })
  }

  return {
    decision: null,
    eventPayload: {
      event: 'task_closure_failed',
      sessionId: options.sessionId,
      reason: 'invalid_classifier_output',
      failureStage: 'parse_classifier_response',
      classifierRequest: classifier.classifierRequest,
      classifierResponse: classifier.response,
      classifierResponseRaw: classifier.responseText,
    },
    traceSpanId: options.traceSpanId,
    traceSpanStatus: 'error',
  }
}

function recordTaskClosureClassifierFailure(options: {
  tracer?: Pick<Tracer, 'updateSpan'>
  traceSpanId?: string
  sessionId: string
  classifierRequest: TaskClosureClassifierRequest
  error: string
}): TaskClosureEvaluation {
  if (options.traceSpanId) {
    options.tracer?.updateSpan(options.traceSpanId, {
      kind: 'closure_failed',
      name: 'task_closure_failed',
      data: {
        closure: {
          event: 'task_closure_failed',
          reason: 'classifier_failed',
          failureStage: 'request_classifier',
          classifierRequest: options.classifierRequest,
          error: options.error,
        },
      },
      metadata: {
        called: true,
        reason: 'classifier_failed',
        failureStage: 'request_classifier',
        classifierRequest: options.classifierRequest,
        error: options.error,
      },
    })
  }

  return {
    decision: null,
    eventPayload: {
      event: 'task_closure_failed',
      sessionId: options.sessionId,
      reason: 'classifier_failed',
      failureStage: 'request_classifier',
      classifierRequest: options.classifierRequest,
      error: options.error,
    },
    traceSpanId: options.traceSpanId,
    traceSpanStatus: 'error',
  }
}
