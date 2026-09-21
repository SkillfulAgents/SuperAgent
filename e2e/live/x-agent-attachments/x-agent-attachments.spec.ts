import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { SessionPage } from '../../pages/session.page'
import {
  attachmentProbeAgentsSchema,
  apiMessagesSchema,
  attachmentProbeProofSchema,
  createdAgentSchema,
  deliverFileInputSchema,
  downloadAgentFileInputSchema,
  getSessionTranscriptInputSchema,
  invokeAgentInputSchema,
} from './probe-schema'

const FIXTURE_NAME = 'x-agent-roundtrip.bin'
const DELIVERED_PATH = '/workspace/roundtrip/returned-proof.bin'
const EXPECTED_BYTES = Buffer.from(Array.from({ length: 16_384 }, (_, index) => (index * 197 + 31) % 256))
const EXPECTED_SHA256 = sha256(EXPECTED_BYTES)

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (!Array.isArray(result)) return ''
  return result
    .filter((block): block is { type: 'text'; text: string } => (
      typeof block === 'object' && block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ))
    .map((block) => block.text)
    .join('\n')
}

function workspaceFileUrl(slug: string, workspacePath: string): string {
  const relative = workspacePath.replace(/^\/workspace\//, '')
  return `/api/agents/${encodeURIComponent(slug)}/files/${relative.split('/').map(encodeURIComponent).join('/')}`
}

async function readWorkspaceFile(
  request: APIRequestContext,
  slug: string,
  workspacePath: string,
): Promise<Buffer> {
  const response = await request.get(workspaceFileUrl(slug, workspacePath))
  expect(response.ok(), `GET ${workspacePath}: ${response.status()} ${await response.text()}`).toBeTruthy()
  return Buffer.from(await response.body())
}

async function createAgent(
  request: APIRequestContext,
  name: string,
  description: string,
  instructions: string,
): Promise<string> {
  const created = await request.post('/api/agents', { data: { name, description } })
  expect(created.ok(), await created.text()).toBeTruthy()
  const { slug } = createdAgentSchema.parse(await created.json())

  const updated = await request.put(`/api/agents/${encodeURIComponent(slug)}`, {
    data: { name, description, instructions },
  })
  expect(updated.ok(), await updated.text()).toBeTruthy()
  return slug
}

async function messages(request: APIRequestContext, slug: string, sessionId: string) {
  const response = await request.get(
    `/api/agents/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/messages`,
  )
  expect(response.ok(), await response.text()).toBeTruthy()
  return apiMessagesSchema.parse(await response.json())
}

async function beat(page: Page, ms = 1_500) {
  // eslint-disable-next-line local-rules/no-brittle-playwright-selectors -- pacing for the demo recording, not synchronization
  await page.waitForTimeout(ms)
}

test.describe.configure({ mode: 'serial' })

test('a real caller sends and downloads the same binary through a real callee', async ({ page, request }) => {
  const suffix = Date.now().toString(36)
  const calleeName = `Roundtrip Receiver ${suffix}`
  const callerName = `Roundtrip Sender ${suffix}`
  const calleeSlug = await createAgent(
    request,
    calleeName,
    'Receives and returns the live x-agent binary fixture.',
    [
      'This agent is the receiver in a live x-agent file-transfer probe.',
      'When invoked with one attached file, use Bash to create /workspace/roundtrip and copy the attached file byte-for-byte to',
      `${DELIVERED_PATH}. Verify the copy with cmp. Then call deliver_file with that exact path and description`,
      '"Byte-for-byte x-agent roundtrip proof". Finish with the exact marker CALLEE_ROUNDTRIP_DONE.',
      'Do not encode, decode, rewrite, summarize, or synthesize the file. Do not ask questions.',
    ].join(' '),
  )
  const callerSlug = await createAgent(
    request,
    callerName,
    'Invokes another agent with a binary attachment and downloads its delivered result.',
    [
      'This agent is the sender in a live x-agent file-transfer probe.',
      'Follow the user workflow exactly. Use list_agents, invoke_agent with the supplied attachment and sync=true,',
      'get_agent_session_transcript to discover delivered files, and download_agent_file with the returned identifiers.',
      'Never claim success unless download_agent_file succeeds. Do not ask questions.',
    ].join(' '),
  )
  const probeAgents = attachmentProbeAgentsSchema.parse({ callerSlug, calleeSlug })
  await mkdir(test.info().outputDir, { recursive: true })
  await writeFile(path.join(test.info().outputDir, 'agents.json'), JSON.stringify(probeAgents, null, 2), { mode: 0o600 })

  const policies = await request.put(`/api/agents/${encodeURIComponent(callerSlug)}/x-agent-policies`, {
    data: {
      policies: [
        { operation: 'list', targetSlug: null, decision: 'allow' },
        { operation: 'read', targetSlug: calleeSlug, decision: 'allow' },
      ],
    },
  })
  expect(policies.ok(), await policies.text()).toBeTruthy()

  await page.goto(`/agents/${callerSlug}`)
  const homeInput = page.getByTestId('home-message-input')
  await expect(homeInput).toBeVisible({ timeout: 30_000 })
  await beat(page)

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: FIXTURE_NAME,
    mimeType: 'application/octet-stream',
    buffer: EXPECTED_BYTES,
  })
  const attachment = page.getByTestId('attachment-preview').filter({ hasText: FIXTURE_NAME })
  await expect(attachment).toBeVisible({ timeout: 30_000 })
  await expect(attachment).toHaveAttribute('data-attachment-status', 'done', { timeout: 60_000 })
  await beat(page, 2_000)

  const prompt = [
    `Run the x-agent binary roundtrip with ${calleeName} (${calleeSlug}).`,
    `Invoke that exact agent with sync=true and attach the ${FIXTURE_NAME} file from this message.`,
    `Tell it to copy the attachment byte-for-byte to ${DELIVERED_PATH}, verify with cmp, and call deliver_file.`,
    'After the invocation, call get_agent_session_transcript using the returned session id, with sync=true if needed.',
    'Use the delivered file metadata to call download_agent_file. Then run sha256sum on the downloaded file.',
    `Finish with exactly ROUNDTRIP_COMPLETE ${EXPECTED_SHA256}. Do not stop before the download succeeds.`,
  ].join(' ')
  await homeInput.click()
  await homeInput.pressSequentially(prompt, { delay: 2 })
  await beat(page, 1_000)
  await page.getByTestId('home-send-button').click()

  const sessionPage = new SessionPage(page)
  await expect(page).toHaveURL(/\/sessions\/[^/]+/, { timeout: 30_000 })
  const callerSessionId = page.url().match(/\/sessions\/([^/?#]+)/)?.[1]
  expect(callerSessionId).toBeTruthy()
  const attachmentReview = page.getByTestId('xagent-review-request')
  await expect(attachmentReview).toBeVisible({ timeout: 5 * 60_000 })
  await expect(attachmentReview).toContainText('1 file to share')
  await expect(attachmentReview).toContainText(FIXTURE_NAME)
  await beat(page, 2_000)
  await attachmentReview.getByTestId('xagent-review-allow-once-btn').click()
  const downloadReview = page.getByTestId('xagent-review-request').filter({ hasText: 'download a delivered file' })
  await expect(downloadReview).toBeVisible({ timeout: 5 * 60_000 })
  await expect(downloadReview).toContainText(path.basename(DELIVERED_PATH))
  await expect(downloadReview.getByTestId('xagent-review-allow-menu')).toHaveCount(0)
  await downloadReview.getByTestId('xagent-review-allow-once-btn').click()
  await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 30_000 })
  await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 10 * 60_000 })
  await expect(sessionPage.getAssistantMessages().filter({ hasText: `ROUNDTRIP_COMPLETE ${EXPECTED_SHA256}` })).toBeVisible({
    timeout: 30_000,
  })
  await expect(sessionPage.getStopButton()).not.toBeVisible({ timeout: 60_000 })
  await sessionPage.expandLatestCompletedTurn(30_000)

  const invokeCard = sessionPage.getToolCall('mcp__agents__invoke_agent')
  const transcriptCard = sessionPage.getToolCall('mcp__agents__get_agent_session_transcript')
  const downloadCard = sessionPage.getToolCall('mcp__agents__download_agent_file')
  await expect(invokeCard).toBeVisible({ timeout: 30_000 })
  await expect(transcriptCard).toBeVisible({ timeout: 30_000 })
  await expect(downloadCard).toBeVisible({ timeout: 30_000 })
  await beat(page, 3_000)

  const callerTranscript = await messages(request, callerSlug, callerSessionId!)
  const callerToolCalls = callerTranscript.flatMap((message) => message.toolCalls)
  const invokeCall = callerToolCalls.find((call) => call.name === 'mcp__agents__invoke_agent' && call.isError === false)
  expect(invokeCall, 'successful invoke_agent call').toBeTruthy()
  const invokeInput = invokeAgentInputSchema.parse(invokeCall!.input)
  expect(invokeInput.slug === calleeSlug || invokeInput.slug.endsWith(`-${calleeSlug}`)).toBe(true)
  expect(invokeInput.attachments).toHaveLength(1)
  const invokeResult = resultText(invokeCall!.result)
  const calleeSessionId = invokeResult.match(/session_id:\s*([^\s]+)/)?.[1]
  expect(calleeSessionId, invokeResult).toBeTruthy()

  const transcriptCall = callerToolCalls.find(
    (call) => call.name === 'mcp__agents__get_agent_session_transcript' && call.isError === false,
  )
  expect(transcriptCall, 'successful get_agent_session_transcript call').toBeTruthy()
  const transcriptInput = getSessionTranscriptInputSchema.parse(transcriptCall!.input)
  expect(transcriptInput.slug === calleeSlug || transcriptInput.slug.endsWith(`-${calleeSlug}`)).toBe(true)
  expect(transcriptInput.session_id).toBe(calleeSessionId)

  const downloadCall = callerToolCalls.find((call) => call.name === 'mcp__agents__download_agent_file' && call.isError === false)
  expect(downloadCall, 'successful download_agent_file call').toBeTruthy()
  const downloadInput = downloadAgentFileInputSchema.parse(downloadCall!.input)
  expect(downloadInput.slug === calleeSlug || downloadInput.slug.endsWith(`-${calleeSlug}`)).toBe(true)
  expect(downloadInput.session_id).toBe(calleeSessionId)
  expect(resultText(transcriptCall!.result)).toContain(downloadInput.delivery_id)
  const callerDownloadPath = resultText(downloadCall!.result).match(/to (\/workspace\/[^\n]+)/)?.[1]?.trim()
  expect(callerDownloadPath, resultText(downloadCall!.result)).toBeTruthy()

  const calleeTranscript = await messages(request, calleeSlug, calleeSessionId!)
  const calleeUserMessage = calleeTranscript.find((message) => message.type === 'user')
  const calleeAttachmentPath = calleeUserMessage?.content.text.match(
    /\[Attached files:\]\s*\n- (\/workspace\/[^\n]+)/,
  )?.[1]?.trim()
  expect(calleeAttachmentPath, calleeUserMessage?.content.text).toBeTruthy()
  const deliverCall = calleeTranscript
    .flatMap((message) => message.toolCalls)
    .find((call) => call.name === 'mcp__user-input__deliver_file' && call.isError === false)
  expect(deliverCall, 'successful deliver_file call').toBeTruthy()
  const deliverInput = deliverFileInputSchema.parse(deliverCall!.input)
  expect(deliverInput.filePath).toBe(DELIVERED_PATH)
  expect(downloadInput.delivery_id).toBe(deliverCall!.id)

  const [callerUpload, calleeAttachment, calleeDelivery, callerDownload] = await Promise.all([
    readWorkspaceFile(request, callerSlug, invokeInput.attachments[0]),
    readWorkspaceFile(request, calleeSlug, calleeAttachmentPath!),
    readWorkspaceFile(request, calleeSlug, deliverInput.filePath),
    readWorkspaceFile(request, callerSlug, callerDownloadPath!),
  ])
  for (const bytes of [callerUpload, calleeAttachment, calleeDelivery, callerDownload]) {
    expect(bytes).toHaveLength(EXPECTED_BYTES.length)
    expect(sha256(bytes)).toBe(EXPECTED_SHA256)
  }

  const proof = attachmentProbeProofSchema.parse({
    callerSlug,
    calleeSlug,
    callerSessionId,
    calleeSessionId,
    deliveryId: deliverCall!.id,
    expectedBytes: EXPECTED_BYTES.length,
    expectedSha256: EXPECTED_SHA256,
    callerUploadSha256: sha256(callerUpload),
    calleeAttachmentSha256: sha256(calleeAttachment),
    calleeDeliverySha256: sha256(calleeDelivery),
    callerDownloadSha256: sha256(callerDownload),
  })
  await mkdir(test.info().outputDir, { recursive: true })
  await writeFile(path.join(test.info().outputDir, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 })
  test.info().annotations.push(
    { type: 'agents', description: `${callerSlug} -> ${calleeSlug}` },
    { type: 'sessions', description: `${callerSessionId} -> ${calleeSessionId}` },
    { type: 'sha256', description: EXPECTED_SHA256 },
  )
})
