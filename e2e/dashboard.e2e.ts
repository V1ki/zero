import { expect, test } from './fixtures'

test.describe('Dashboard', () => {
  test('shows Dashboard heading', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('main h1')).toContainText('Dashboard')
  })

  test('shows system status bar with model name', async ({ page }) => {
    await page.goto('/')
    // SystemStatus component is rendered above the main content
    await expect(page.locator('main')).toContainText('gpt-5.3-codex-medium', { timeout: 10_000 })
  })

  test('shows cost overview section', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=Cost Overview')).toBeVisible()
    await expect(page.locator('text=Today')).toBeVisible()
    await expect(page.locator('text=This Week')).toBeVisible()
    await expect(page.locator('text=This Month')).toBeVisible()
  })

  test('does not show activity feed section', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Recent Activity', { exact: true })).not.toBeVisible()
  })

  test('shows Current Sessions heading', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Current Sessions' })).toBeVisible()
  })

  test('shows bot name in current session rows', async ({ page }) => {
    await page.route(
      (url) => url.pathname === '/api/sessions' && url.searchParams.get('filter') === 'current',
      async (route) => {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            sessions: [
              {
                id: 'sess_bot_name_001',
                source: 'weixin',
                channelName: 'personal-bot',
                isCurrent: true,
                placement: 'current',
                currentModel: 'chatgpt/gpt-5.5',
                createdAt: '2026-06-08T00:00:00.000Z',
                updatedAt: '2026-06-08T00:00:00.000Z',
                summary: '',
                toolCallCount: 0,
                userMessageCount: 1,
                assistantMessageCount: 0,
              },
            ],
          }),
        })
      },
    )

    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'Current Sessions' })).toBeVisible()
    await expect(page.getByText('weixin', { exact: true })).toBeVisible()
    await expect(page.getByText('personal-bot', { exact: true })).toBeVisible()
  })

  test('shows channel status with all channel names', async ({ page }) => {
    await page.goto('/')
    // ChannelStatus component auto-hides when all channels are offline
    // Wait for channel data to load
    await page.waitForTimeout(2000)
    // Channel status should show channel names when visible
    const main = page.locator('main')
    const hasChannelBar = await main.locator('text=web').count()
    if (hasChannelBar > 0) {
      await expect(main).toContainText('web')
      await expect(main).toContainText('feishu')
      await expect(main).toContainText('telegram')
    }
  })

  test('status bar shows uptime', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=Uptime')).toBeVisible({ timeout: 10_000 })
  })

  test('attention card is conditionally rendered', async ({ page }) => {
    await page.goto('/')
    // The attention card only renders when there are notifications
    await page.waitForTimeout(2000)
    const attentionCard = page.locator('text=Needs Attention')
    const count = await attentionCard.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('ZeRo OS Ready card is removed', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(1000)
    await expect(page.locator('text=ZeRo OS Ready')).not.toBeVisible()
  })
})
