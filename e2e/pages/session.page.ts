import { Page, expect } from '@playwright/test'

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
   * Wait for a secret request to appear in the UI
   */
  async waitForSecretRequest(secretName?: string, timeout = 15000) {
    if (secretName) {
      await expect(
        this.page.locator(`[data-testid="secret-request"][data-secret-name="${secretName}"]`)
      ).toBeVisible({ timeout })
    } else {
      await expect(this.page.locator('[data-testid="secret-request"]').first()).toBeVisible({ timeout })
    }
  }

  /**
   * Get all visible secret request items
   */
  getSecretRequests() {
    return this.page.locator('[data-testid="secret-request"]')
  }

  /**
   * Fill in and provide a secret value
   */
  async provideSecret(value: string, secretName?: string) {
    const container = secretName
      ? this.page.locator(`[data-testid="secret-request"][data-secret-name="${secretName}"]`)
      : this.page.locator('[data-testid="secret-request"]').first()

    await container.locator('input[placeholder^="Paste "]').fill(value)
    await container.locator('[data-testid="secret-provide-btn"]').click()
  }

  /**
   * Decline a secret request
   */
  async declineSecret(secretName?: string) {
    const container = secretName
      ? this.page.locator(`[data-testid="secret-request"][data-secret-name="${secretName}"]`)
      : this.page.locator('[data-testid="secret-request"]').first()

    await container.locator('[data-testid="secret-decline-btn"]').click()
  }

  /**
   * Wait for a question request to appear in the UI
   */
  async waitForQuestionRequest(timeout = 15000) {
    // Question may be hidden inside PendingRequestStack (visibility:hidden) — check DOM presence
    await expect(this.page.locator('[data-testid="question-request"]').first()).toBeAttached({ timeout })
  }

  /**
   * Get all visible question request items
   */
  getQuestionRequests() {
    return this.page.locator('[data-testid="question-request"]')
  }

  /**
   * Select a question option by its label text and submit
   */
  async answerQuestion(optionLabel: string) {
    const container = this.page.locator('[data-testid="question-request"]').first()

    // Click the label containing the option text (the label wraps both radio/checkbox and text)
    await container.locator('label').filter({ hasText: optionLabel }).click()

    // Click submit
    await container.locator('[data-testid="question-submit-btn"]').click()
  }

  /**
   * Decline a question request
   */
  async declineQuestion() {
    const container = this.page.locator('[data-testid="question-request"]').first()
    await container.locator('[data-testid="question-decline-btn"]').click()
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
