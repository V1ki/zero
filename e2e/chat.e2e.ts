import { expect, test } from './fixtures'

test.describe('Chat Drawer', () => {
  test('opens and closes chat drawer with push layout', async ({ page }) => {
    await page.goto('/')
    // Check initial main content has no right margin
    const main = page.locator('main')
    const initialMargin = await main.evaluate((el) => getComputedStyle(el).marginRight)
    expect(initialMargin).toBe('0px')

    // Click the Chat button in sidebar
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()
    // Drawer should appear with placeholder text
    const drawer = page.locator('.fixed.right-0.top-0.h-full.w-\\[360px\\]')
    await expect(drawer).toBeVisible()
    await expect(drawer).toContainText('Send a message to interact with ZeRo OS')

    // Push layout: main content should have right margin
    await page.waitForTimeout(400) // wait for transition
    const pushedMargin = await main.evaluate((el) => getComputedStyle(el).marginRight)
    expect(pushedMargin).toBe('360px')

    // Close via X button (first button in drawer header)
    await drawer.locator('button').first().click()
    await expect(drawer).not.toBeVisible()
  })

  test('push layout has no backdrop overlay', async ({ page }) => {
    await page.goto('/')
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()
    const drawer = page.locator('.fixed.right-0.top-0.h-full.w-\\[360px\\]')
    await expect(drawer).toBeVisible()
    // No backdrop overlay should exist
    const backdrop = page.locator('.fixed.inset-0.bg-black\\/40')
    await expect(backdrop).not.toBeVisible()
  })

  test('closes with Escape key', async ({ page }) => {
    await page.goto('/')
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()
    const drawer = page.locator('.fixed.right-0.top-0.h-full.w-\\[360px\\]')
    await expect(drawer).toBeVisible()
    // Press Escape to close
    await page.keyboard.press('Escape')
    await expect(drawer).not.toBeVisible()
  })

  test('shows channel info in header', async ({ page }) => {
    await page.goto('/')
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()
    const drawer = page.locator('.fixed.right-0.top-0.h-full.w-\\[360px\\]')
    await expect(drawer).toContainText('Web Channel')
  })

  test('has multi-line textarea input', async ({ page }) => {
    await page.goto('/')
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()
    // Should be a textarea, not an input
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await expect(textarea).toBeVisible()
  })

  test('/new shows the currently selected model', async ({ page }) => {
    await page.goto('/')
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()

    const drawer = page.locator('.fixed.right-0.top-0.h-full.w-\\[360px\\]')
    const textarea = page.getByPlaceholder('Send a message...')

    await textarea.fill('/model gpt-5.4-medium')
    await textarea.press('Enter')

    await expect(drawer).toContainText('Model switched to openai-codex/gpt-5.4-medium')
    await expect(drawer).toContainText('Web Channel · openai-codex/gpt-5.4-medium')

    await textarea.fill('/new')
    await textarea.press('Enter')

    await expect(drawer).toContainText(
      'New conversation started with model: openai-codex/gpt-5.4-medium',
    )
    await expect(drawer).toContainText('Web Channel · openai-codex/gpt-5.4-medium')
  })

  test('/session shows session summary in the drawer', async ({ page }) => {
    await page.goto('/')
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()

    const drawer = page.locator('.fixed.right-0.top-0.h-full.w-\\[360px\\]')
    const textarea = page.getByPlaceholder('Send a message...')

    await textarea.fill('/session')
    await textarea.press('Enter')

    await expect(drawer).toContainText('Session Info')
    await expect(drawer).toContainText('ID:')
    await expect(drawer).toContainText('Model:')
    await expect(drawer).toContainText('Messages:')
    await expect(drawer).toContainText('Tool calls:')
    await expect(drawer).toContainText('Cost:')
  })

  test('can type a message', async ({ page }) => {
    await page.goto('/')
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()
    const textarea = page.getByPlaceholder('Send a message...')
    await textarea.fill('Hello')
    await expect(textarea).toHaveValue('Hello')
  })

  test('send button disabled when empty', async ({ page }) => {
    await page.goto('/')
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()
    // The send button should be disabled when input is empty
    const drawer = page.locator('.fixed.right-0.top-0.h-full.w-\\[360px\\]')
    const sendBtn = drawer.locator('button[disabled]')
    await expect(sendBtn).toBeVisible()
  })

  test('sends message and shows bounce dots loading indicator', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/')
    await page.locator('aside button').filter({ hasText: 'Chat' }).click()

    const textarea = page.getByPlaceholder('Send a message...')
    await textarea.fill('What is 2+2? Answer with just the number.')
    await textarea.press('Enter')

    // User message should appear in the drawer
    const drawer = page.locator('.fixed.right-0.top-0.h-full.w-\\[360px\\]')
    await expect(drawer).toContainText('What is 2+2?')

    // Should show bounce dots loading indicator (not "Thinking...")
    await expect(drawer.locator('.typing-dot').first()).toBeVisible({ timeout: 5_000 })

    // Wait for AI reply (real API call)
    await expect(drawer.locator('.typing-dot').first()).not.toBeVisible({ timeout: 45_000 })

    // Should contain the answer "4" somewhere in the reply
    await expect(drawer).toContainText('4')
  })
})
