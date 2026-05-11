import type { SourceCard } from '@zero-os/shared'

export function createQqMailHimalayaSourceCard(): SourceCard {
  return {
    schemaVersion: 1,
    id: 'qq-mail-himalaya',
    title: 'QQ Mail via himalaya CLI',
    state: 'candidate',
    kind: 'private_mailbox',
    owner: {
      scope: 'user',
    },
    sensitivity: 'private',
    discovery: {
      firstSeenAt: '2026-05-08T21:53:00.000+08:00',
      discoveredFrom: {
        sessionId: 'sess_20260508_2153_fei_9b99',
        traceRefs: ['trace/run.log'],
      },
      learnedMethodSummary:
        'himalaya CLI can enumerate local QQ mail accounts, folders, and bounded envelope metadata through a local profile.',
    },
    capabilities: [
      {
        id: 'list_envelopes',
        operation: 'list',
        inputSchema: {
          type: 'object',
          properties: {
            folder: { type: 'string' },
            query: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['folder'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            envelopes: { type: 'array' },
          },
        },
        watchable: true,
        defaultPrivacyScope: 'metadata_only',
        allowedActions: ['notify', 'recordObservation'],
        prohibitedActions: ['read_mail_body', 'download_attachment', 'send_mail'],
      },
      {
        id: 'read_message_metadata',
        operation: 'read',
        inputSchema: {
          type: 'object',
          properties: {
            folder: { type: 'string' },
            messageId: { type: 'string' },
          },
          required: ['folder', 'messageId'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            headers: { type: 'object' },
          },
        },
        watchable: false,
        defaultPrivacyScope: 'foreground_metadata_only',
        allowedActions: ['recordObservation'],
        prohibitedActions: ['read_mail_body', 'download_attachment', 'send_mail'],
      },
      {
        id: 'himalaya_account_health',
        operation: 'health_check',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        outputSchema: {
          type: 'object',
          properties: {
            exitCode: { type: 'number' },
          },
        },
        watchable: false,
        defaultPrivacyScope: 'metadata_only',
        allowedActions: ['recordObservation'],
        prohibitedActions: ['read_mail_body', 'download_attachment', 'send_mail'],
      },
    ],
    adapter: {
      mode: 'cli',
      activeRevision: 'himalaya-cli-v1',
      revisions: [
        {
          id: 'himalaya-cli-v1',
          status: 'active',
          mode: 'cli',
          entrypoint: 'himalaya',
          commandTemplate: 'himalaya account list; himalaya folder list; himalaya envelope list',
          parser: {
            type: 'text',
            schemaKeys: ['account', 'folder', 'envelopeId', 'from', 'date'],
          },
          timeoutMs: 15_000,
          rateLimit: {
            minIntervalMs: 60_000,
          },
          validation: {
            sampleQueries: [
              {
                command: 'account list',
              },
              {
                command: 'folder list',
              },
            ],
            expectedEvidence: [
              'CLI exits with code 0',
              'Configured account or explicit no-account state is visible',
              'No message body or attachment content is captured',
            ],
          },
        },
      ],
    },
    credentials: [
      {
        id: 'qq-mail-local-profile',
        required: true,
        binding: {
          type: 'externalStore',
          ref: 'external:himalaya/account/qq',
        },
        scopes: ['mail.metadata.read'],
        injectAs: 'profileSession',
        leasePolicy: {
          ttlSeconds: 900,
          renewable: false,
          reauthRequiredOn: ['auth', 'adapter_unavailable'],
        },
      },
    ],
    privacy: {
      dataClasses: ['mailbox names', 'message ids', 'bounded envelope metadata'],
      bodyPolicy: 'metadata_only',
      attachmentPolicy: 'blocked',
      retention: {
        card: 'until user retires source',
        observations: '30 days by default',
        artifacts: 'explicit user-approved artifacts only',
      },
    },
    health: {
      checks: [
        {
          id: 'himalaya_account_health',
          cadence: 'before_watch_tick',
          method: 'Run himalaya account/folder metadata commands through the CLI adapter.',
          successCriteria:
            'Command exits with code 0 and returns only redacted account/folder/envelope evidence.',
        },
      ],
      lastStatus: undefined,
    },
    observations: {
      observationSchemaRef: 'source-observation/mail-envelope-metadata-v1',
      cursorPolicy: 'Watch owns query/cursor; Source Card only defines capability shape.',
      maxSamplePersisted: 0,
      contentHashPolicy: 'hash envelope ids and omit body content',
    },
    promotion: {
      requiredEvidence: [
        'himalaya CLI is installed and reachable',
        'external credential reference resolves through himalaya local config',
        'metadata-only validation succeeds',
        'user approves exact mailbox/query/cadence before active watch',
      ],
    },
  }
}

export function createAStockMarketDataSourceCard(): SourceCard {
  return {
    schemaVersion: 1,
    id: 'a-stock-market-data',
    title: 'A-share market data',
    state: 'active',
    kind: 'public_market_data',
    owner: {
      scope: 'system',
    },
    sensitivity: 'public',
    discovery: {
      firstSeenAt: '2026-05-08T09:26:00.000+08:00',
      discoveredFrom: {
        sessionId: 'sess_20260508_0926_fei_9398',
        traceRefs: ['trace/run.log'],
        artifactRefs: ['stock watchlist artifacts'],
      },
      learnedMethodSummary:
        'Public Eastmoney quote, ranking, and report endpoints can provide bounded read-only stock market data without credentials.',
    },
    capabilities: [
      {
        id: 'fetch_quotes',
        operation: 'query',
        inputSchema: {
          type: 'object',
          properties: {
            symbols: { type: 'array', items: { type: 'string' } },
            fields: { type: 'array', items: { type: 'string' } },
          },
          required: ['symbols'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            quotes: { type: 'array' },
          },
        },
        watchable: true,
        defaultPrivacyScope: 'public_read_only',
        allowedActions: ['notify', 'recordObservation', 'createArtifact'],
        prohibitedActions: [
          'place_order',
          'trade',
          'use_broker_account',
          'send_financial_instruction',
        ],
      },
      {
        id: 'fetch_rankings',
        operation: 'query',
        inputSchema: {
          type: 'object',
          properties: {
            page: { type: 'number' },
            pageSize: { type: 'number' },
            filters: { type: 'object' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            rows: { type: 'array' },
          },
        },
        watchable: true,
        defaultPrivacyScope: 'public_read_only',
        allowedActions: ['notify', 'recordObservation', 'createArtifact'],
        prohibitedActions: [
          'place_order',
          'trade',
          'use_broker_account',
          'send_financial_instruction',
        ],
      },
      {
        id: 'eastmoney_quote_health',
        operation: 'health_check',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        outputSchema: {
          type: 'object',
          properties: {
            statusCode: { type: 'number' },
            schemaKeys: { type: 'array' },
          },
        },
        watchable: false,
        defaultPrivacyScope: 'public_read_only',
        allowedActions: ['recordObservation'],
        prohibitedActions: [
          'place_order',
          'trade',
          'use_broker_account',
          'send_financial_instruction',
        ],
      },
    ],
    adapter: {
      mode: 'api',
      activeRevision: 'eastmoney-public-api-v1',
      revisions: [
        {
          id: 'eastmoney-public-api-v1',
          status: 'active',
          mode: 'api',
          entrypoint: 'https://push2.eastmoney.com',
          endpointTemplates: [
            'https://push2.eastmoney.com/api/qt/stock/get',
            'https://datacenter-web.eastmoney.com/api/data/v1/get',
            'https://emweb.securities.eastmoney.com/PC_HSF10/*',
          ],
          parser: {
            type: 'json',
            schemaKeys: ['data', 'diff', 'f43', 'f57', 'f58'],
          },
          timeoutMs: 10_000,
          rateLimit: {
            minIntervalMs: 30_000,
            burst: 2,
          },
          validation: {
            sampleQueries: [
              {
                endpoint: 'quote',
                symbol: 'SH000001',
              },
            ],
            expectedEvidence: ['HTTP 200', 'parseable JSON', 'expected quote keys are present'],
          },
        },
      ],
    },
    credentials: [
      {
        id: 'public-web',
        required: false,
        binding: {
          type: 'none',
        },
        scopes: ['market.public.read'],
        injectAs: 'none',
        leasePolicy: {
          ttlSeconds: 0,
          renewable: false,
          reauthRequiredOn: [],
        },
      },
    ],
    privacy: {
      dataClasses: ['stock symbols', 'public quotes', 'public rankings', 'public filings data'],
      bodyPolicy: 'approved_background_scope',
      attachmentPolicy: 'blocked',
      retention: {
        card: 'until source revision is retired',
        observations: '14 days by default',
        artifacts: 'user-visible reports or watchlist artifacts only',
      },
    },
    health: {
      checks: [
        {
          id: 'eastmoney_quote_health',
          cadence: 'before_watch_tick',
          method: 'Fetch one bounded public quote endpoint through the API adapter.',
          successCriteria: 'HTTP 200, parseable JSON, and expected quote keys are present.',
        },
      ],
      lastStatus: undefined,
    },
    observations: {
      observationSchemaRef: 'source-observation/public-market-data-v1',
      cursorPolicy: 'Watch owns symbol sets and cadence; observations store changing quote rows.',
      maxSamplePersisted: 5,
      contentHashPolicy: 'hash normalized request and response schema keys',
    },
    promotion: {
      requiredEvidence: [
        'Endpoint is public and read-only',
        'Response shape is parseable and bounded',
        'No credential binding is required',
        'Trading, broker, and account actions are prohibited',
      ],
    },
  }
}
