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
    await this.getMessageInput().fill(content)
  }

  /**
   * Send a message by clicking the send button
   */
  async sendMessage(content: string) {
    await this.typeMessage(content)
    await this.getSendButton().click()
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
   * Delete a session via context menu
   */
  async deleteSessionViaContextMenu(sessionName: string) {
    // Right-click on the session in the sidebar
    const sessionItem = this.page.getByText(sessionName)
    await sessionItem.click({ button: 'right' })

    // Click delete
    await this.page.locator('[data-testid="delete-session-item"]').click()

    // Confirm deletion
    await expect(this.page.locator('[data-testid="confirm-dialog"]')).toBeVisible()
    await this.page.locator('[data-testid="confirm-button"]').click()

    // Wait for dialog to close
    await expect(this.page.locator('[data-testid="confirm-dialog"]')).not.toBeVisible()
  }

  /**
   * Assert that the user message contains expected text
   */
  async expectUserMessage(text: string, index = 0) {
    const messages = this.getUserMessages()
    await expect(messages.nth(index)).toContainText(text)
  }

  /**
   * Click the first session in the sidebar for a given agent
   */
  async selectFirstSessionInSidebar(agentSlug: string) {
    // Sessions are sub-items under the agent's collapsible section
    // Find session items with data-testid pattern
    const sessionItem = this.page.locator(`[data-testid^="session-item-"]`).first()
    await sessionItem.click()
  }

  /**
   * Assert that the assistant message contains expected text
   */
  async expectAssistantMessage(text: string, index = 0) {
    const messages = this.getAssistantMessages()
    await expect(messages.nth(index)).toContainText(text)
  }

  /**
   * Wait for the input to be enabled (agent finished responding)
   */
  async waitForInputEnabled(timeout = 10000) {
    await expect(this.getMessageInput()).toBeEnabled({ timeout })
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
    await expect(this.page.locator('[data-testid="script-run-request"]').first()).toBeVisible({ timeout })
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
    await expect(this.page.locator('[data-testid="proxy-review-request"]').first()).toBeVisible({ timeout })
  }

  getProxyReviewRequests() {
    return this.page.locator('[data-testid="proxy-review-request"]')
  }

  async allowProxyReview() {
    const container = this.page.locator('[data-testid="proxy-review-request"]').first()
    // The Allow button is now a popover — click it to open, then click "Allow Once"
    await container.locator('[data-testid="proxy-review-always-allow-btn"]').click()
    await this.page.locator('[data-testid="proxy-review-allow-once-menu-btn"]').click()
  }

  async denyProxyReview() {
    const container = this.page.locator('[data-testid="proxy-review-request"]').first()
    await container.locator('[data-testid="proxy-review-deny-btn"]').click()
  }

  async waitForProxyReviewCompleted(status: 'allowed' | 'denied', timeout = 10000) {
    await expect(
      this.page.locator(`[data-testid="proxy-review-completed"][data-status="${status}"]`).first()
    ).toBeVisible({ timeout })
  }

  async alwaysAllowScope(scope: string) {
    const container = this.page.locator('[data-testid="proxy-review-request"]').first()
    // Open the Allow popover, then click the "Always allow <scope>" button
    await container.locator('[data-testid="proxy-review-always-allow-btn"]').click()
    await this.page.locator(`[data-testid="proxy-review-always-allow-${scope}"]`).click()
  }

  async alwaysDenyScope(scope: string) {
    const container = this.page.locator('[data-testid="proxy-review-request"]').first()
    await container.locator(`[data-testid="proxy-review-always-deny-${scope}"]`).click()
  }

  async alwaysAllowAll() {
    const container = this.page.locator('[data-testid="proxy-review-request"]').first()
    await container.locator('[data-testid="proxy-review-always-allow-all"]').click()
  }

  // --- Computer Use Request Helpers ---

  async waitForComputerUseRequest(timeout = 15000) {
    await expect(this.page.locator('[data-testid="computer-use-request"]').first()).toBeVisible({ timeout })
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
