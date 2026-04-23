import { expect, test } from './fixtures'

test.describe('Sessions Page', () => {
  test('shows sessions heading', async ({ page }) => {
    await page.goto('/sessions')
    await expect(page.locator('main h1')).toContainText('Sessions')
  })

  test('shows status filter buttons', async ({ page }) => {
    await page.goto('/sessions')
    const filterArea = page.locator('main .flex.gap-2')
    await expect(filterArea.locator('button:has-text("All")')).toBeVisible()
    await expect(filterArea.locator('button:has-text("Current")')).toBeVisible()
    await expect(filterArea.locator('button:has-text("Background")')).toBeVisible()
  })

  test('shows source filter buttons', async ({ page }) => {
    await page.goto('/sessions')
    await expect(page.locator('main')).toContainText('Source:')
    const sourceArea = page.locator('main .flex.gap-1\\.5')
    await expect(sourceArea.locator('button:has-text("all")')).toBeVisible()
    await expect(sourceArea.locator('button:has-text("web")')).toBeVisible()
    await expect(sourceArea.locator('button:has-text("feishu")')).toBeVisible()
    await expect(sourceArea.locator('button:has-text("telegram")')).toBeVisible()
    await expect(sourceArea.locator('button:has-text("scheduler")')).toBeVisible()
  })

  test('has search input', async ({ page }) => {
    await page.goto('/sessions')
    await expect(page.getByPlaceholder('Search sessions...')).toBeVisible()
  })

  test('filter buttons are clickable', async ({ page }) => {
    await page.goto('/sessions')
    const filterArea = page.locator('main .flex.gap-2')
    await filterArea.locator('button:has-text("Current")').click()
    await expect(page.locator('main h1')).toContainText('Sessions')
  })

  test('source filter buttons are clickable', async ({ page }) => {
    await page.goto('/sessions')
    const sourceArea = page.locator('main .flex.gap-1\\.5')
    await sourceArea.locator('button:has-text("web")').click()
    await expect(page.locator('main h1')).toContainText('Sessions')
  })

  test('shows skeleton loaders while loading', async ({ page }) => {
    await page.route('**/api/sessions*', async (route) => {
      await new Promise((r) => setTimeout(r, 1000))
      await route.continue()
    })
    await page.goto('/sessions')
    await expect(page.locator('main .skeleton').first()).toBeVisible()
  })

  test('session appears after chat', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/')

    // Send a chat message to create a session
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()
    const input = page.getByPlaceholder('Send a message...')
    await input.fill('Say hello')
    await input.press('Enter')
    // Wait for reply to complete (bounce dots appear and disappear)
    await expect(page.locator('.typing-dot').first()).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.typing-dot').first()).not.toBeVisible({ timeout: 45_000 })

    // Close drawer via Escape
    await page.keyboard.press('Escape')

    // Navigate to sessions via URL
    await page.goto('/sessions')

    // Session should appear — check for session metrics in card
    await expect(page.locator('main')).toContainText('tool calls', { timeout: 5_000 })
  })
})
