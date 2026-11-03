import { expect, test } from './fixtures'

test.describe('Tools Page', () => {
  test('exposes Codex through the worker tool', async ({ page }) => {
    await page.goto('/tools')
    const main = page.locator('main')
    const worker = main.locator('.card').filter({ has: page.getByText('worker', { exact: true }) })
    await worker.getByRole('button', { name: 'Show parameters' }).click()
    await expect(worker.locator('pre')).toContainText('"codex"')
    await expect(main.getByText('codex', { exact: true })).toHaveCount(0)
  })

  test('shows tools heading', async ({ page }) => {
    await page.goto('/tools')
    await expect(page.locator('main h1')).toContainText('Tools')
  })

  test('shows filter tabs', async ({ page }) => {
    await page.goto('/tools')
    const filterArea = page.locator('main .flex.gap-1\\.5').first()
    await expect(filterArea.locator('button:has-text("All")')).toBeVisible()
    await expect(filterArea.locator('button:has-text("Built-in")')).toBeVisible()
    await expect(filterArea.locator('button:has-text("Tool")')).toBeVisible()
    await expect(filterArea.locator('button:has-text("Skill")')).toBeVisible()
    await expect(filterArea.locator('button:has-text("MCP")')).toBeVisible()
  })

  test('shows all 6 built-in tool descriptions', async ({ page }) => {
    await page.goto('/tools')
    await expect(page.locator('main')).toContainText('Read file contents', { timeout: 10_000 })
    await expect(page.locator('main')).toContainText('Write content to a file')
    await expect(page.locator('main')).toContainText('Replace exact text')
    await expect(page.locator('main')).toContainText('Execute a shell command')
    await expect(page.locator('main')).toContainText('Control a headless browser')
    await expect(page.locator('main')).toContainText('Launch SubAgents')
  })

  test('tool cards show type badges', async ({ page }) => {
    await page.goto('/tools')
    // Wait for tools to load
    await expect(page.locator('main')).toContainText('Read file contents', { timeout: 10_000 })
    // Built-in tools should have "built-in" badge
    await expect(page.locator('main span:has-text("built-in")').first()).toBeVisible()
  })

  test('tool cards show toggle switches', async ({ page }) => {
    await page.goto('/tools')
    await expect(page.locator('main')).toContainText('Read file contents', { timeout: 10_000 })
    // Toggle switches are buttons with rounded-full class
    const toggles = page.locator('main .card button.rounded-full')
    const count = await toggles.count()
    expect(count).toBeGreaterThanOrEqual(6)
  })

  test('toggle switch changes tool state', async ({ page }) => {
    await page.goto('/tools')
    await expect(page.locator('main')).toContainText('Read file contents', { timeout: 10_000 })
    // Click first toggle to disable a tool
    const firstToggle = page.locator('main .card button.rounded-full').first()
    await firstToggle.click()
    // Should still have tools page displayed
    await expect(page.locator('main h1')).toContainText('Tools')
  })

  test('filter tabs filter tool list', async ({ page }) => {
    await page.goto('/tools')
    await expect(page.locator('main')).toContainText('Read file contents', { timeout: 10_000 })
    // Click "Built-in" filter
    const filterArea = page.locator('main .flex.gap-1\\.5').first()
    await filterArea.locator('button:has-text("Built-in")').click()
    // Should show built-in tools (Read, Write, Edit, Bash, Browser) — 5 tools
    await expect(page.locator('main')).toContainText('Read file contents')
    // Task tool should not be visible when filtering Built-in only
    await expect(page.locator('main')).not.toContainText('Launch SubAgents')
  })

  test('show/hide parameters button works', async ({ page }) => {
    await page.goto('/tools')
    await expect(page.locator('main')).toContainText('Read file contents', { timeout: 10_000 })
    // Click "Show parameters" on first card
    const showParamsBtn = page.locator('main button:has-text("Show parameters")').first()
    await showParamsBtn.click()
    // Parameters JSON should be visible
    await expect(page.locator('main pre').first()).toBeVisible()
    // Button text should change
    await expect(page.locator('main button:has-text("Hide parameters")').first()).toBeVisible()
  })

  test('shows ENABLED TOOLS section header', async ({ page }) => {
    await page.goto('/tools')
    await expect(page.locator('main')).toContainText('ENABLED TOOLS', { timeout: 10_000 })
  })

  test('shows skeleton loaders while loading', async ({ page }) => {
    await page.route('**/api/tools', async (route) => {
      await new Promise((r) => setTimeout(r, 1000))
      await route.continue()
    })
    await page.goto('/tools')
    await expect(page.locator('main .skeleton').first()).toBeVisible()
  })
})
