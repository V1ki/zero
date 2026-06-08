import { expect, test } from './fixtures'

test.describe('WebSocket and Real-time UI', () => {
  test('dashboard omits activity feed section', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('main h1')).toContainText('Dashboard')
    await expect(page.getByText('Recent Activity', { exact: true })).not.toBeVisible()
    await expect(page.getByText('No activity yet')).not.toBeVisible()
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

    // Dashboard should still show its remaining sections
    await expect(page.locator('text=Cost Overview')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Current Sessions' })).toBeVisible()
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
