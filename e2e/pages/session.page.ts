import { Page, Locator, expect } from '@playwright/test'

/**
 * Page object for session/chat operations
 */
export class SessionPage {
  constructor(private page: Page) {}

  /**
   * Get the message input textarea (handles both home page and chat page)
   */
  getMessageInput() {
    // Try regular message input first, then home page input
    const regular = this.page.locator('[data-testid="message-input"]')
    const home = this.page.locator('[data-testid="home-message-input"]')
    return regular.or(home)
  }

  /**
   * Get the send button (handles both home page and chat page)
   */
  getSendButton() {
    // Try regular send button first, then home page button
    const regular = this.page.locator('[data-testid="send-button"]')
    const home = this.page.locator('[data-testid="home-send-button"]')
    return regular.or(home)
  }

  private async findMatchingLocator(locators: Locator[], options: { enabled?: boolean } = {}) {
    for (const locator of locators) {
      const count = await locator.count().catch(() => 0)
      for (let index = 0; index < count; index++) {
        const candidate = locator.nth(index)
        const isVisible = await candidate.isVisible().catch(() => false)
        if (!isVisible) continue
        const isEnabled = await candidate.isEnabled().catch(() => false)
        if (options.enabled && !isEnabled) continue
        return candidate
      }
    }
    return undefined
  }

  private getMessageInputLocators() {
    const regular = this.page.locator('[data-testid="message-input"]')
    const home = this.page.locator('[data-testid="home-message-input"]')
    return [regular, home]
  }

  private getSendButtonLocators() {
    const regular = this.page.locator('[data-testid="send-button"]')
    const home = this.page.locator('[data-testid="home-send-button"]')
    return [regular, home]
  }

  private async getVisibleMessageInput(timeout = 10000) {
    let visibleInput: Locator | undefined
    await expect.poll(async () => {
      visibleInput = await this.findMatchingLocator(this.getMessageInputLocators())
      return visibleInput ? 'found' : 'none'
    }, { timeout }).not.toBe('none')

    return visibleInput ?? this.page.locator('[data-testid="message-input"]').first()
  }

  private async getEnabledMessageInput(timeout = 10000) {
    let enabledInput: Locator | undefined
    await expect.poll(async () => {
      enabledInput = await this.findMatchingLocator(this.getMessageInputLocators(), { enabled: true })
      return enabledInput ? 'found' : 'none'
    }, { timeout }).not.toBe('none')

    return enabledInput ?? this.page.locator('[data-testid="message-input"]').first()
  }

  private async clickEnabledSendButton(timeout = 10000) {
    await expect.poll(async () => {
      const button = await this.findMatchingLocator(this.getSendButtonLocators(), { enabled: true })
      if (!button) return 'waiting'

      try {
        await button.click({ timeout: 1000 })
        return 'clicked'
      } catch {
        return 'retry'
      }
    }, { timeout }).toBe('clicked')
  }

  /**
   * Get the stop button (visible when agent is working)
   */
  getStopButton() {
    return this.page.locator('[data-testid="stop-button"]')
  }

  /**
   * Get the message list container
   */
  getMessageList() {
    return this.page.locator('[data-testid="message-list"]')
  }

  /**
   * Get all user messages
   */
  getUserMessages() {
    return this.page.locator('[data-testid="message-user"]')
  }

  /**
   * Get all assistant messages
   */
  getAssistantMessages() {
    return this.page.locator('[data-testid="message-assistant"]')
  }

  /**
   * Get the activity indicator
   */
  getActivityIndicator() {
    return this.page.locator('[data-testid="activity-indicator"]')
  }

  /**
   * Type a message into the input
   */
  async typeMessage(content: string) {
    const input = await this.getEnabledMessageInput()
    await input.fill(content)
    await expect(input).toHaveValue(content)
  }

  /**
   * Send a message by clicking the send button
   */
  async sendMessage(content: string) {
    await this.typeMessage(content)
    await this.clickEnabledSendButton()
  }

  /**
   * Wait for an assistant response to appear
   */
  async waitForResponse(timeout = 10000) {
    await expect(this.getAssistantMessages().first()).toBeVisible({ timeout })
  }

  /**
   * Wait for a specific number of assistant messages
   */
  async waitForAssistantMessageCount(count: number, timeout = 10000) {
    await expect(this.getAssistantMessages()).toHaveCount(count, { timeout })
  }

  /**
   * Wait for a specific number of user messages
   */
  async waitForUserMessageCount(count: number, timeout = 10000) {
    await expect(this.getUserMessages()).toHaveCount(count, { timeout })
  }

  /**
   * Check if a tool call with a specific name is visible
   */
  async expectToolCall(toolName: string, timeout = 10000) {
    await expect(this.page.locator(`[data-testid="tool-call-${toolName}"]`)).toBeVisible({ timeout })
  }

  /**
   * Get tool call elements by name
   */
  getToolCall(toolName: string) {
    return this.page.locator(`[data-testid="tool-call-${toolName}"]`)
  }

  /**
   * Delete a session via the sidebar right-click context menu, confirming the
   * dialog. Targets the row by session id (names appear in the breadcrumb and
   * agent-home list too, so a text match would be ambiguous). Pass expectedName
   * to also assert the confirm dialog names the right session.
   */
  async deleteSessionViaContextMenu(sessionId: string, expectedName?: string) {
    const sessionItem = this.page.locator(`[data-testid="session-item-${sessionId}"]`)
    await expect(sessionItem).toBeVisible({ timeout: 15000 })
    await sessionItem.click({ button: 'right' })

    await this.page.locator('[data-testid="delete-session-item"]').click()

    const dialog = this.page.locator('[data-testid="confirm-dialog"]')
    await expect(dialog).toBeVisible()
    if (expectedName) {
      await expect(dialog).toContainText(expectedName)
    }
    await this.page.locator('[data-testid="confirm-button"]').click()
    await expect(dialog).not.toBeVisible()
  }

  /**
   * Assert that the user message contains expected text
   */
  async expectUserMessage(text: string, index = 0) {
    const messages = this.getUserMessages()
    await expect(messages.nth(index)).toContainText(text)
  }

  /**
   * Click the first session in the sidebar for a given agent (by display name,
   * which lets us fall back to text match since agent slugs aren't derived from
   * the user-visible name).
   *
   * Post-glow-up the sidebar uses a click split — selecting an agent doesn't
   * auto-expand its submenu — so this helper expands the agent's chevron first
   * if needed before clicking the first session sub-item.
   */
  async selectFirstSessionInSidebar(agentLi: Locator) {
    const expandChevron = agentLi.locator('button[aria-label="Expand"]').first()
    if (await expandChevron.isVisible({ timeout: 500 }).catch(() => false)) {
      await expandChevron.click()
    }
    await agentLi.locator(`[data-testid^="session-item-"]`).first().click()
  }

  /**
   * Assert that the assistant message contains expected text
   */
  async expectAssistantMessage(text: string, index = 0, timeout = 10000) {
    const messages = this.getAssistantMessages()
    await expect(messages.nth(index)).toContainText(text, { timeout })
  }

  /**
   * Wait for the input to be enabled (agent finished responding)
   */
  async waitForInputEnabled(timeout = 10000) {
    await this.getEnabledMessageInput(timeout)
  }

  /**
   * Check if the agent is currently working (stop button visible)
   */
  async isAgentWorking(): Promise<boolean> {
    return await this.getStopButton().isVisible()
  }

  // --- User Input Request Helpers ---

  /**
   * Walk the pending-request stack (clicking next/prev) until the given card
   * becomes the active (visible) one. The stack's non-active cards are kept
   * mounted with visibility:hidden, so we can't interact with them until they
   * are paginated to the front.
   */
  async paginateToCard(target: Locator, timeout = 5000) {
    if (await target.isVisible()) return

    const deadline = Date.now() + timeout
    // Rewind to the first card so we can walk forward deterministically.
    const prev = this.page.locator('[data-testid="request-stack-prev"]:visible')
    while (Date.now() < deadline) {
      if (await prev.count() === 0) break
      const disabled = await prev.first().isDisabled()
      if (disabled) break
      await prev.first().click()
    }

    const next = this.page.locator('[data-testid="request-stack-next"]:visible')
    while (Date.now() < deadline) {
      if (await target.isVisible()) return
      if (await next.count() === 0) break
      const disabled = await next.first().isDisabled()
      if (disabled) break
      await next.first().click()
    }

    if (!(await target.isVisible())) {
      throw new Error('paginateToCard: target never became visible in the stack')
    }
  }

  private async waitForVisibleRequestCard(testId: string, timeout = 15000, card?: Locator) {
    card ??= this.page.locator(`[data-testid="${testId}"]`).first()
    await expect(card).toBeAttached({ timeout })

    await expect.poll(async () => {
      if (await card.isVisible().catch(() => false)) return 'visible'

      await this.paginateToCard(card, 1000).catch(() => undefined)
      return await card.isVisible().catch(() => false) ? 'visible' : 'hidden'
    }, { timeout }).toBe('visible')
  }

  /**
   * Wait for a secret request to appear in the DOM. Cards in the pending-request
   * stack may be mounted but hidden, so we check attachment, not visibility.
   */
  async waitForSecretRequest(secretName?: string, timeout = 15000) {
    const locator = secretName
      ? this.page.locator(`[data-testid="secret-request"][data-secret-name="${secretName}"]`)
      : this.page.locator('[data-testid="secret-request"]').first()
    await expect(locator).toBeAttached({ timeout })
  }

  /**
   * Get all secret request items (visible and stacked).
   */
  getSecretRequests() {
    return this.page.locator('[data-testid="secret-request"]')
  }

  /**
   * Fill in and provide a secret value. Paginates the stack to the target card
   * if it isn't currently the active one.
   */
  async provideSecret(value: string, secretName?: string) {
    const container = secretName
      ? this.page.locator(`[data-testid="secret-request"][data-secret-name="${secretName}"]`)
      : this.page.locator('[data-testid="secret-request"]').first()

    await this.paginateToCard(container)
    await container.locator('input[placeholder^="Paste "]').fill(value)
    await container.locator('[data-testid="secret-provide-btn"]').click()
  }

  /**
   * Decline a secret request. Paginates the stack first if needed.
   */
  async declineSecret(secretName?: string) {
    const container = secretName
      ? this.page.locator(`[data-testid="secret-request"][data-secret-name="${secretName}"]`)
      : this.page.locator('[data-testid="secret-request"]').first()

    await this.paginateToCard(container)
    await container.locator('[data-testid="secret-decline-btn"]').click()
  }

  /**
   * Wait for a question request to appear in the DOM (may be stacked/hidden).
   */
  async waitForQuestionRequest(timeout = 15000) {
    await expect(this.page.locator('[data-testid="question-request"]').first()).toBeAttached({ timeout })
  }

  /**
   * Get all question request items (visible and stacked).
   */
  getQuestionRequests() {
    return this.page.locator('[data-testid="question-request"]')
  }

  /**
   * Select a question option by its label text and submit. Paginates first.
   */
  async answerQuestion(optionLabel: string) {
    const container = this.page.locator('[data-testid="question-request"]').first()
    await this.paginateToCard(container)
    await container.locator('label').filter({ hasText: optionLabel }).click()
    await container.locator('[data-testid="question-submit-btn"]').click()
  }

  /**
   * Walk through every question in a multi-question AskUserQuestion card,
   * picking each option in order via the per-card Next button, then submit
   * on the last. Use for `'ask multi'` and `'ask multi parallel'` scenarios.
   */
  async answerMultiQuestion(optionLabels: string[]) {
    const container = this.page.locator('[data-testid="question-request"]').first()
    await this.paginateToCard(container)
    for (let i = 0; i < optionLabels.length; i++) {
      await container.locator('label').filter({ hasText: optionLabels[i] }).click()
      if (i < optionLabels.length - 1) {
        await container.locator('[data-testid="question-next-btn"]').click()
      } else {
        await container.locator('[data-testid="question-submit-btn"]').click()
      }
    }
  }

  /**
   * Read the visible request-stack chevrons' flat position. Returns null when
   * no chevrons are mounted (single sub-page total).
   */
  async getStackPagination(): Promise<{ index: number; total: number } | null> {
    const el = this.page.locator('[data-testid="request-stack-pagination"]:visible').first()
    if ((await el.count()) === 0) return null
    const idx = Number(await el.getAttribute('data-current-index'))
    const total = Number(await el.getAttribute('data-count'))
    return { index: idx, total }
  }

  async expectStackPagination(expected: { index: number; total: number }) {
    const el = this.page.locator('[data-testid="request-stack-pagination"]:visible').first()
    await expect(el).toHaveAttribute('data-current-index', String(expected.index))
    await expect(el).toHaveAttribute('data-count', String(expected.total))
  }

  /** Click the visible header "next" chevron in the pending-request stack. */
  async clickStackNext() {
    await this.page.locator('[data-testid="request-stack-next"]:visible').first().click()
  }

  /** Click the visible header "prev" chevron in the pending-request stack. */
  async clickStackPrev() {
    await this.page.locator('[data-testid="request-stack-prev"]:visible').first().click()
  }

  /**
   * Decline a question request. Paginates first.
   */
  async declineQuestion() {
    const container = this.page.locator('[data-testid="question-request"]').first()
    await this.paginateToCard(container)
    await container.locator('[data-testid="question-decline-btn"]').click()
  }

  /**
   * Returns the type of the currently active (visible) card in the
   * pending-request stack, or null if no input request is pending.
   */
  async getActiveRequestType(): Promise<'secret' | 'question' | null> {
    if (await this.page.locator('[data-testid="secret-request"]:visible').count() > 0) return 'secret'
    if (await this.page.locator('[data-testid="question-request"]:visible').count() > 0) return 'question'
    return null
  }

  /**
   * Wait for a completed secret request with specific status
   */
  async waitForSecretRequestCompleted(status: 'provided' | 'declined', timeout = 10000) {
    await expect(
      this.page.locator(`[data-testid="secret-request-completed"][data-status="${status}"]`).first()
    ).toBeVisible({ timeout })
  }

  /**
   * Wait for a completed question request with specific status
   */
  async waitForQuestionRequestCompleted(status: 'answered' | 'declined', timeout = 10000) {
    await expect(
      this.page.locator(`[data-testid="question-request-completed"][data-status="${status}"]`).first()
    ).toBeVisible({ timeout })
  }

  // --- Script Run Request Helpers ---

  async waitForScriptRunRequest(timeout = 15000) {
    await this.waitForVisibleRequestCard('script-run-request', timeout)
  }

  getScriptRunRequests() {
    return this.page.locator('[data-testid="script-run-request"]')
  }

  async approveScriptRun() {
    const container = this.page.locator('[data-testid="script-run-request"]').first()
    await container.locator('[data-testid="script-run-once-btn"]').click()
  }

  async denyScriptRun() {
    const container = this.page.locator('[data-testid="script-run-request"]').first()
    await container.locator('[data-testid="script-deny-btn"]').click()
  }

  // --- Proxy Review Request Helpers ---

  async waitForProxyReviewRequest(timeout = 15000) {
    await this.waitForVisibleRequestCard('proxy-review-request', timeout)
  }

  async waitForProxyReviewRequestById(reviewId: string, timeout = 15000) {
    await this.waitForVisibleRequestCard('proxy-review-request', timeout, this.getProxyReviewRequests(reviewId))
  }

  getProxyReviewRequests(reviewId?: string) {
    return reviewId
      ? this.page.locator(`[data-testid="proxy-review-request"][data-review-id="${reviewId}"]`)
      : this.page.locator('[data-testid="proxy-review-request"]')
  }

  async allowProxyReview(reviewId?: string) {
    const container = this.getProxyReviewRequests(reviewId).first()
    await this.paginateToCard(container)
    // The Allow button is now a popover — click it to open, then click "Allow Once"
    await container.locator('[data-testid="proxy-review-always-allow-btn"]').click()
    await this.page.locator('[data-testid="proxy-review-allow-once-menu-btn"]').click()
  }

  async denyProxyReview(reviewId?: string) {
    const container = this.getProxyReviewRequests(reviewId).first()
    await this.paginateToCard(container)
    await container.locator('[data-testid="proxy-review-deny-btn"]').click()
  }

  async waitForProxyReviewCompleted(status: 'allowed' | 'denied', timeout = 10000) {
    await expect(
      this.page.locator(`[data-testid="proxy-review-completed"][data-status="${status}"]`).first()
    ).toBeVisible({ timeout })
  }

  async alwaysAllowScope(scope: string, reviewId?: string) {
    const container = this.getProxyReviewRequests(reviewId).first()
    await this.paginateToCard(container)
    // Open the Allow popover, expand the per-scope disclosure, then click "Always allow <scope>"
    await container.locator('[data-testid="proxy-review-always-allow-btn"]').click()
    await this.page.locator('[data-testid="proxy-review-specific-scope-toggle"]').click()
    await this.page.locator(`[data-testid="proxy-review-always-allow-${scope}"]`).click()
  }

  async alwaysAllowLabelGroup(label: 'read' | 'write' | 'destructive', reviewId?: string) {
    const container = this.getProxyReviewRequests(reviewId).first()
    await this.paginateToCard(container)
    // Open the Allow popover, then click the minimal risk-group "Allow all <label>" option
    await container.locator('[data-testid="proxy-review-always-allow-btn"]').click()
    await this.page.locator(`[data-testid="proxy-review-allow-label-${label}"]`).click()
  }

  async alwaysDenyScope(scope: string, reviewId?: string) {
    const container = this.getProxyReviewRequests(reviewId).first()
    await this.paginateToCard(container)
    await container.locator(`[data-testid="proxy-review-always-deny-${scope}"]`).click()
  }

  async alwaysAllowAll(reviewId?: string) {
    const container = this.getProxyReviewRequests(reviewId).first()
    await this.paginateToCard(container)
    await container.locator('[data-testid="proxy-review-always-allow-all"]').click()
  }

  // --- X-Agent Review Request Helpers ---

  async waitForXAgentReviewRequest(timeout = 15000) {
    await this.waitForVisibleRequestCard('xagent-review-request', timeout)
  }

  async waitForXAgentReviewRequestById(reviewId: string, timeout = 15000) {
    await this.waitForVisibleRequestCard('xagent-review-request', timeout, this.getXAgentReviewRequests(reviewId))
  }

  getXAgentReviewRequests(reviewId?: string) {
    return reviewId
      ? this.page.locator(`[data-testid="xagent-review-request"][data-review-id="${reviewId}"]`)
      : this.page.locator('[data-testid="xagent-review-request"]')
  }

  async allowXAgentReview(reviewId?: string) {
    const container = this.getXAgentReviewRequests(reviewId).first()
    await this.paginateToCard(container)
    await container.locator('[data-testid="xagent-review-allow-once-btn"]').click()
  }

  async denyXAgentReview(reviewId?: string) {
    const container = this.getXAgentReviewRequests(reviewId).first()
    await this.paginateToCard(container)
    await container.locator('[data-testid="xagent-review-deny-btn"]').click()
  }

  async stopSessionFromRequest(container?: Locator) {
    if (container) {
      const target = container.first()
      await this.paginateToCard(target)
      await target.locator('[data-testid="request-stop-session"]').click()
      return
    }

    await this.page.locator('[data-testid="request-stop-session"]').first().click()
  }

  // --- Computer Use Request Helpers ---

  async waitForComputerUseRequest(timeout = 15000) {
    await this.waitForVisibleRequestCard('computer-use-request', timeout)
  }

  getComputerUseRequests() {
    return this.page.locator('[data-testid="computer-use-request"]')
  }

  async approveComputerUseOnce() {
    const container = this.page.locator('[data-testid="computer-use-request"]').first()
    // "Allow Once" is inside a popover opened by the chevron next to "Allow 15 min"
    await container.locator('[data-testid="computer-use-allow-timed-btn-chevron"]').click()
    // The popover is portaled to document.body, so locate the button on the page
    await this.page.locator('[data-testid="computer-use-allow-once-btn"]').click()
  }

  async approveComputerUseTimed() {
    const container = this.page.locator('[data-testid="computer-use-request"]').first()
    await container.locator('[data-testid="computer-use-allow-timed-btn"]').click()
  }

  async approveComputerUseAlways() {
    const container = this.page.locator('[data-testid="computer-use-request"]').first()
    await container.locator('[data-testid="computer-use-allow-always-btn"]').click()
  }

  async denyComputerUse() {
    const container = this.page.locator('[data-testid="computer-use-request"]').first()
    await container.locator('[data-testid="computer-use-deny-btn"]').click()
  }
}
