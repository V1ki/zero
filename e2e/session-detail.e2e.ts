import { expect, test } from './fixtures'

test.describe('Session Detail Page', () => {
  // Helper: create a session via chat, then navigate to session detail
  async function createSessionAndNavigate(page: import('@playwright/test').Page) {
    await page.goto('/')

    // Send a chat message to create a session
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()
    const input = page.getByPlaceholder('Send a message...')
    await input.fill('Say hello briefly')
    await input.press('Enter')

    // Wait for AI reply to complete (bounce dots)
    await expect(page.locator('.typing-dot').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.typing-dot').first()).not.toBeVisible({ timeout: 45_000 })

    // Close chat drawer via Escape
    await page.keyboard.press('Escape')

    // Go to Sessions page via URL
    await page.goto('/sessions')
    await expect(page.locator('main h1')).toContainText('Sessions')

    // Wait for sessions to load and click the first one
    await expect(page.locator('main .card.cursor-pointer').first()).toBeVisible({ timeout: 5_000 })
    await page.locator('main .card.cursor-pointer').first().click()

    // Wait for session detail to load — URL should change to /sessions/<id>
    await expect(page.locator('main')).toContainText('sess_', { timeout: 10_000 })
  }

  test('navigates to session detail and shows session ID', async ({ page }) => {
    test.setTimeout(90_000)
    await createSessionAndNavigate(page)

    // Should show session ID pattern
    await expect(page.locator('main')).toContainText('sess_')
  })

  test('shows metadata bar with session info', async ({ page }) => {
    test.setTimeout(90_000)
    await createSessionAndNavigate(page)

    // Metadata bar shows model and Archive button
    const main = page.locator('main')
    await expect(main).toContainText(/claude|gpt/i)
    await expect(main).toContainText('Archive')
  })

  test('shows timeline-first two-column layout with compact header', async ({ page }) => {
    test.setTimeout(90_000)
    await createSessionAndNavigate(page)

    await expect(page.locator('[data-testid="session-detail-layout"]')).toBeVisible({
      timeout: 5_000,
    })
    await expect(page.locator('[data-testid="session-timeline-stage"]')).toBeVisible({
      timeout: 5_000,
    })
    await expect(page.locator('[data-testid="session-context-panel"]')).toBeVisible({
      timeout: 5_000,
    })

    await expect(page.locator('[data-testid="session-signal-rail"]')).toHaveCount(0)

    const heroBox = await page.locator('[data-testid="session-hero"]').boundingBox()
    const timelineBox = await page.locator('[data-testid="session-timeline-stage"]').boundingBox()
    const contextBox = await page.locator('[data-testid="session-context-panel"]').boundingBox()

    expect(heroBox).not.toBeNull()
    expect(timelineBox).not.toBeNull()
    expect(contextBox).not.toBeNull()
    expect(heroBox?.height ?? 999).toBeLessThan(320)
    expect(timelineBox?.width ?? 0).toBeGreaterThan((contextBox?.width ?? 0) * 1.8)
  })

  test('shows context panel with model history', async ({ page }) => {
    test.setTimeout(90_000)
    await createSessionAndNavigate(page)

    // Context panel renders headers in uppercase
    await expect(page.locator('main')).toContainText('MODEL HISTORY', { timeout: 5_000 })
  })

  test('shows Summary and Trace tabs', async ({ page }) => {
    test.setTimeout(90_000)
    await createSessionAndNavigate(page)

    await expect(page.locator('main')).toContainText('Summary', { timeout: 5_000 })
    await expect(page.locator('main')).toContainText('Trace')
  })

  test('shows archive button', async ({ page }) => {
    test.setTimeout(90_000)
    await createSessionAndNavigate(page)

    await expect(page.locator('main button:has-text("Archive")')).toBeVisible({ timeout: 5_000 })
  })

  test('back button returns to sessions list', async ({ page }) => {
    test.setTimeout(90_000)
    await createSessionAndNavigate(page)

    // The back button shows "Sessions" text with ArrowLeft icon
    await page.locator('main button:has-text("Sessions")').click()

    // Should be back at sessions list
    await expect(page.locator('main h1')).toContainText('Sessions')
    await expect(page).toHaveURL(/\/sessions$/)
  })

  test('shows skeleton loader during loading', async ({ page }) => {
    test.setTimeout(90_000)
    // Navigate directly to a session detail URL with delayed API
    await page.route('**/api/sessions/*', async (route) => {
      const url = route.request().url()
      // Only delay individual session requests, not the list
      if (url.match(/\/api\/sessions\/sess_/)) {
        await new Promise((r) => setTimeout(r, 1000))
      }
      await route.continue()
    })
    await createSessionAndNavigate(page)
  })
})
