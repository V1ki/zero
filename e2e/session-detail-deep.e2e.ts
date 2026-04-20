import { expect, test } from './fixtures'

test.describe('Session Detail Deep', () => {
  // Helper: create a session via chat, then navigate to session list
  async function createSessionAndGoToList(page: import('@playwright/test').Page) {
    await page.goto('/')

    // Send a chat message to create a session
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()
    const input = page.getByPlaceholder('Send a message...')
    await input.fill('Say hi briefly')
    await input.press('Enter')

    // Wait for AI reply to complete
    await expect(page.locator('.typing-dot').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.typing-dot').first()).not.toBeVisible({ timeout: 45_000 })

    // Close chat drawer
    await page.keyboard.press('Escape')

    // Navigate to Sessions page
    await page.goto('/sessions')
    await expect(page.locator('main h1')).toContainText('Sessions')
  }

  test('session list shows sessions after chat', async ({ page }) => {
    test.setTimeout(90_000)
    await createSessionAndGoToList(page)

    // At least one session card should be visible
    await expect(page.locator('main .card.cursor-pointer').first()).toBeVisible({ timeout: 5_000 })
    // Session cards show tool calls metric
    await expect(page.locator('main')).toContainText('tool calls')
  })

  test('click session navigates to detail page', async ({ page }) => {
    test.setTimeout(90_000)
    await createSessionAndGoToList(page)

    // Click the first session
    await expect(page.locator('main .card.cursor-pointer').first()).toBeVisible({ timeout: 5_000 })
    await page.locator('main .card.cursor-pointer').first().click()

    // Should show session ID on the detail page
    await expect(page.locator('main')).toContainText('sess_', { timeout: 10_000 })
  })

  test('session detail shows messages in timeline', async ({ page }) => {
    test.setTimeout(90_000)
    await createSessionAndGoToList(page)

    await expect(page.locator('main .card.cursor-pointer').first()).toBeVisible({ timeout: 5_000 })
    await page.locator('main .card.cursor-pointer').first().click()
    await expect(page.locator('main')).toContainText('sess_', { timeout: 10_000 })

    await expect(page.locator('[data-testid="session-detail-layout"]')).toBeVisible({
      timeout: 5_000,
    })
    await expect(page.locator('[data-testid="session-signal-rail"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="session-timeline-stage"]')).toBeVisible({
      timeout: 5_000,
    })

    // Context panel should show MODEL HISTORY section
    await expect(page.locator('main')).toContainText('MODEL HISTORY', { timeout: 5_000 })
  })

  test('archive button exists on session detail', async ({ page }) => {
    test.setTimeout(90_000)
    await createSessionAndGoToList(page)

    await expect(page.locator('main .card.cursor-pointer').first()).toBeVisible({ timeout: 5_000 })
    await page.locator('main .card.cursor-pointer').first().click()
    await expect(page.locator('main')).toContainText('sess_', { timeout: 10_000 })

    // Archive button should be visible in the metadata bar
    await expect(page.locator('main button:has-text("Archive")')).toBeVisible({ timeout: 5_000 })
  })

  test('back navigation returns to sessions list', async ({ page }) => {
    test.setTimeout(90_000)
    await createSessionAndGoToList(page)

    await expect(page.locator('main .card.cursor-pointer').first()).toBeVisible({ timeout: 5_000 })
    await page.locator('main .card.cursor-pointer').first().click()
    await expect(page.locator('main')).toContainText('sess_', { timeout: 10_000 })

    // Click back button (shows "Sessions" text with ArrowLeft icon)
    await page.locator('main button:has-text("Sessions")').click()

    // Should be back at sessions list
    await expect(page.locator('main h1')).toContainText('Sessions')
    await expect(page).toHaveURL(/\/sessions$/)
  })
})
