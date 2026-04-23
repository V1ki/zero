import { expect, test } from './fixtures'

test.describe('WebSocket and Real-time UI', () => {
  test('dashboard shows activity feed section', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('main h1')).toContainText('Dashboard')
    // Activity feed renders with heading
    await expect(page.locator('text=Recent Activity')).toBeVisible({ timeout: 10_000 })
  })

  test('dashboard activity feed renders initial state', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=Recent Activity')).toBeVisible({ timeout: 10_000 })
    // Activity feed shows either log entries or the empty state message
    const main = page.locator('main')
    await page.waitForTimeout(2000)
    const hasEntries = await main.locator('.font-mono').count()
    if (hasEntries === 0) {
      await expect(main).toContainText('No activity yet')
    }
  })

  test('navigation between pages maintains app state', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('main h1')).toContainText('Dashboard')

    // Navigate to Config
    await page.getByRole('button', { name: 'Config', exact: true }).click()
    await expect(page.locator('main h1')).toContainText('Config')

    // Navigate to Sessions
    await page.getByRole('button', { name: 'Sessions', exact: true }).click()
    await expect(page.locator('main h1')).toContainText('Sessions')

    // Navigate back to Dashboard
    await page.locator('nav button').filter({ hasText: 'Dashboard' }).click()
    await expect(page.locator('main h1')).toContainText('Dashboard')

    // Dashboard should still show its sections
    await expect(page.locator('text=Recent Activity')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=Cost Overview')).toBeVisible()
  })

  test('real-time elements present on dashboard', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('main h1')).toContainText('Dashboard')

    // System status bar shows model name (loaded via API)
    await expect(page.locator('main')).toContainText('gpt-5.3-codex-medium', { timeout: 10_000 })

    // Uptime indicator (real-time element)
    await expect(page.locator('text=Uptime')).toBeVisible({ timeout: 10_000 })

    // Current Sessions heading
    await expect(page.getByRole('heading', { name: 'Current Sessions' })).toBeVisible()
  })
})
