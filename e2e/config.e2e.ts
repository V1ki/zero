import { expect, test } from './fixtures'

test.describe('Config Page', () => {
  test('shows config heading', async ({ page }) => {
    await page.goto('/config')
    await expect(page.locator('main h1')).toContainText('Config')
  })

  test('shows all 6 tab buttons', async ({ page }) => {
    await page.goto('/config')
    const tabArea = page.locator('main .flex.gap-1\\.5').first()
    await expect(tabArea.locator('button:has-text("Models")')).toBeVisible()
    await expect(tabArea.locator('button:has-text("Scheduler")')).toBeVisible()
    await expect(tabArea.locator('button:has-text("Fuse List")')).toBeVisible()
    await expect(tabArea.locator('button:has-text("Secrets")')).toBeVisible()
    await expect(tabArea.locator('button:has-text("Channels")')).toBeVisible()
    await expect(tabArea.locator('button:has-text("Version")')).toBeVisible()
  })

  test('Models tab shows providers section with data', async ({ page }) => {
    await page.goto('/config')
    // Models tab is default
    await expect(page.locator('main h3:has-text("Providers")')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('main')).toContainText('openai-codex', { timeout: 10_000 })
  })

  test('Models tab shows models section with data', async ({ page }) => {
    await page.goto('/config')
    await expect(page.locator('main h3:has-text("Models")')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('main')).toContainText('gpt-5.3-codex-medium', { timeout: 10_000 })
  })

  test('Models tab shows default model badge', async ({ page }) => {
    await page.goto('/config')
    await expect(page.locator('main span:has-text("Default")')).toBeVisible({ timeout: 10_000 })
  })

  test('Models tab renders runtime catalog metadata, routes, and manual refresh', async ({
    page,
  }) => {
    let refreshCalls = 0
    await page.route('**/api/config', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      const config = (await response.json()) as Record<string, unknown> & {
        providers: Record<string, unknown>
      }
      await route.fulfill({
        response,
        json: {
          ...config,
          providers: {
            ...config.providers,
            chatgpt: {
              apiType: 'openai_responses',
              baseUrl: 'https://chatgpt.com/backend-api/codex',
              authType: 'oauth2',
              managedOAuthProvider: 'chatgpt',
              configured: true,
              authorized: true,
              oauthState: 'connected',
              models: {
                'gpt-5.6-sol': {
                  modelId: 'gpt-5.6-sol',
                  maxContext: 372000,
                  maxOutput: 8192,
                  capabilities: ['tools', 'vision', 'reasoning'],
                  tags: ['codex', 'sol'],
                  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
                  source: 'provider',
                  status: 'verified',
                  displayName: 'GPT-5.6 Sol',
                  family: 'gpt',
                  version: '5.6',
                  lane: 'sol',
                },
              },
            },
          },
          modelRoutes: {
            'coding-latest': {
              providers: ['chatgpt'],
              requires: ['tools', 'reasoning'],
              prefer: 'quality',
            },
          },
          runtimeModelPools: {
            'pool/gpt-5.6-sol': {
              source: 'catalog',
              strategy: 'sticky_quota_aware_failover',
              members: [
                { model: 'chatgpt/gpt-5.6-sol', priority: 0 },
                { model: 'chatgpt-personal/gpt-5.6-sol', priority: 1 },
              ],
            },
          },
          modelCatalog: {
            generation: 7,
            updatedAt: '2026-07-10T00:00:00.000Z',
            entries: [
              {
                providerName: 'chatgpt',
                modelName: 'gpt-5.6-sol',
                modelId: 'gpt-5.6-sol',
                displayName: 'GPT-5.6 Sol',
                family: 'gpt',
                version: '5.6',
                lane: 'sol',
                status: 'verified',
                source: 'provider',
                maxContext: 372000,
                maxOutput: 8192,
                capabilities: ['tools', 'vision', 'reasoning'],
                defaultReasoningEffort: 'low',
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
                discoveredAt: '2026-07-10T00:00:00.000Z',
                verifiedAt: '2026-07-10T00:00:01.000Z',
                lastSeenAt: '2026-07-10T00:00:01.000Z',
                lastError: null,
              },
            ],
          },
        },
      })
    })
    await page.route('**/api/providers/chatgpt/oauth/usage', async (route) => {
      await route.fulfill({
        json: {
          provider: 'chatgpt',
          usage: {
            rateLimits: {
              limitId: null,
              limitName: null,
              primary: null,
              secondary: null,
              credits: null,
              planType: null,
            },
            rateLimitsByLimitId: null,
          },
        },
      })
    })
    await page.route('**/api/providers/chatgpt/models/refresh', async (route) => {
      refreshCalls++
      await route.fulfill({
        json: {
          reason: 'manual',
          providerNames: ['chatgpt'],
          changed: false,
          discovered: 1,
          verified: 1,
          unavailable: 0,
          errors: [],
          generation: 7,
        },
      })
    })

    await page.goto('/config')

    await expect(page.getByText('Runtime Model Catalog')).toBeVisible()
    await expect(page.getByText('Generation 7')).toBeVisible()
    await expect(page.getByText('GPT-5.6 Sol')).toBeVisible()
    await expect(page.getByText('provider · verified')).toBeVisible()
    await expect(page.getByText('Automatic Pools')).toBeVisible()
    await expect(page.getByText('pool/gpt-5.6-sol', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Default Model').locator('option')).toContainText([
      'route/coding-latest · route',
      'pool/gpt-5.6-sol · pool',
    ])

    await page.getByRole('button', { name: 'Refresh models' }).click()
    await expect.poll(() => refreshCalls).toBe(1)
    await expect(page.getByRole('button', { name: 'Refresh models' })).toBeEnabled()
  })

  test('Models tab shows task closure model selector with default option', async ({ page }) => {
    await page.goto('/config')
    await expect(page.locator('main h3:has-text("Task Closure Model")')).toBeVisible({
      timeout: 10_000,
    })
    const selector = page.getByLabel('Task Closure Model')
    await expect(selector).toBeVisible()
    await expect(selector).toHaveValue('')
    await expect(selector.locator('option')).toContainText(['Default（与 agent 主模型相同）'])
  })

  test('model pools can be configured and used without restarting', async ({ page }) => {
    try {
      await page.goto('/config')
      await expect(page.locator('main h3:has-text("Model Routing")')).toBeVisible({
        timeout: 10_000,
      })

      await page.getByLabel('New model pool name').fill('pooled/gpt-5.4-medium')
      await page.getByLabel('Add model pool').click()
      await expect(page.getByLabel('Model pool name 1')).toHaveValue('pooled/gpt-5.4-medium')

      await page.getByLabel('Add member to model pool 1').click()
      await page
        .getByLabel('Model pool member 1-2', { exact: true })
        .selectOption('openai-codex/gpt-5.3-codex-medium')

      const saveResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/config') && response.request().method() === 'PUT',
      )
      await page.getByLabel('Save model pools').click()
      await expect((await saveResponse).status()).toBe(200)

      const modelsResponse = await page.request.get('/api/models')
      expect(modelsResponse.ok()).toBe(true)
      const modelsPayload = (await modelsResponse.json()) as {
        models: Array<{ name: string }>
      }
      expect(modelsPayload.models.some((model) => model.name === 'pooled/gpt-5.4-medium')).toBe(
        true,
      )

      const defaultSave = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/config') && response.request().method() === 'PUT',
      )
      await page.getByLabel('Default Model').selectOption('pooled/gpt-5.4-medium')
      await expect((await defaultSave).status()).toBe(200)

      await page.reload()
      await expect(page.getByLabel('Default Model')).toHaveValue('pooled/gpt-5.4-medium')
      await expect(page.getByLabel('Task Closure Model').locator('option')).toContainText([
        'pooled/gpt-5.4-medium · pool',
      ])
    } finally {
      await page.request.put('/api/config', {
        data: {
          defaultModel: 'openai-codex/gpt-5.4-medium',
          modelPools: {},
        },
      })
    }
  })

  test('model pool controls fit on mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/config')
    await expect(page.locator('main h3:has-text("Model Routing")')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByLabel('New model pool name')).toBeVisible()
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    expect(hasHorizontalOverflow).toBe(false)
  })

  test('task closure model selector persists selection and can be cleared', async ({ page }) => {
    await page.goto('/config')
    const selector = page.getByLabel('Task Closure Model')

    await selector.selectOption('openai-codex/gpt-5.3-codex-medium')
    await expect(selector).toHaveValue('openai-codex/gpt-5.3-codex-medium')

    await page.reload()
    await expect(selector).toHaveValue('openai-codex/gpt-5.3-codex-medium')

    await selector.selectOption('')
    await expect(selector).toHaveValue('')

    await page.reload()
    await expect(selector).toHaveValue('')
  })

  test('Scheduler tab shows scheduled tasks', async ({ page }) => {
    await page.goto('/config')
    await page.locator('main button:has-text("Scheduler")').click()
    await expect(page.locator('main h3:has-text("Scheduled Tasks")')).toBeVisible()
  })

  test('Fuse List tab shows fuse list', async ({ page }) => {
    await page.goto('/config')
    await page.locator('main button:has-text("Fuse List")').click()
    await expect(page.locator('main h3:has-text("Fuse List")')).toBeVisible()
  })

  test('Secrets tab shows secrets section', async ({ page }) => {
    await page.goto('/config')
    await page.locator('main button:has-text("Secrets")').click()
    await expect(page.locator('main h3:has-text("Secrets")')).toBeVisible()
  })

  test('Channels tab shows channel names', async ({ page }) => {
    await page.goto('/config')
    await page.locator('main button:has-text("Channels")').click()
    await expect(page.locator('main h3:has-text("Channels")')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('main')).toContainText('web')
    await expect(page.locator('main')).toContainText('feishu')
    await expect(page.locator('main')).toContainText('telegram')
  })

  test('Channels tab shows channel status indicators', async ({ page }) => {
    await page.goto('/config')
    await page.locator('main button:has-text("Channels")').click()
    await expect(page.locator('main')).toContainText('online', { timeout: 10_000 })
  })

  test('Version tab shows version info', async ({ page }) => {
    await page.goto('/config')
    await page.locator('main button:has-text("Version")').click()
    await expect(page.locator('main h3:has-text("Version Info")')).toBeVisible()
    await expect(page.locator('main')).toContainText('v0.1.0')
    await expect(page.locator('main')).toContainText('Bun')
    await expect(page.locator('main')).toContainText('macOS')
  })

  test('tab switching hides previous tab content', async ({ page }) => {
    await page.goto('/config')
    // Models tab is default
    await expect(page.locator('main h3:has-text("Providers")')).toBeVisible({ timeout: 10_000 })
    // Switch to Scheduler tab
    await page.locator('main button:has-text("Scheduler")').click()
    await expect(page.locator('main h3:has-text("Providers")')).not.toBeVisible()
    await expect(page.locator('main h3:has-text("Scheduled Tasks")')).toBeVisible()
  })

  test('shows skeleton loaders while loading', async ({ page }) => {
    // Intercept API to delay response
    await page.route('**/api/config', async (route) => {
      await new Promise((r) => setTimeout(r, 1000))
      await route.continue()
    })
    await page.goto('/config')
    // Skeleton cards should be visible during loading
    await expect(page.locator('main .skeleton').first()).toBeVisible()
  })
})
