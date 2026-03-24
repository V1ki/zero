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
