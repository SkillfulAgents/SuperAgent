import { Page, expect } from '@playwright/test'

/**
 * Page object for session/chat operations
 */
export class SessionPage {
  constructor(private page: Page) {}

  /**
   * Get the message input textarea (handles both landing page and chat page)
   */
  getMessageInput() {
    // Try regular message input first, then landing page input
    const regular = this.page.locator('[data-testid="message-input"]')
    const landing = this.page.locator('[data-testid="landing-message-input"]')
    return regular.or(landing)
  }

  /**
   * Get the send button (handles both landing page and chat page)
   */
  getSendButton() {
    // Try regular send button first, then landing page button
    const regular = this.page.locator('[data-testid="send-button"]')
    const landing = this.page.locator('[data-testid="landing-send-button"]')
    return regular.or(landing)
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
}
