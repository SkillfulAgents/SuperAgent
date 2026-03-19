/**
 * Browser Workflow Trace Extractor
 *
 * Parses a browser sub-agent's JSONL log into a structured, analyzable trace
 * of browser interactions. Used by the smart trigger and workflow reviewer.
 */

import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';

// ============================================================================
// Types
// ============================================================================

export interface BrowserWorkflowTrace {
  sessionId: string
  subagentId: string
  startUrl: string
  goal: string
  steps: BrowserWorkflowStep[]
  outcome: 'success' | 'partial' | 'failure'
  totalDurationMs: number
  totalTokens: number
  totalToolUseCount: number
}

export interface BrowserWorkflowStep {
  index: number
  tool: string
  input: Record<string, unknown>
  output: string
  wasEffective: boolean
  isRetry: boolean
  accessibilityContext?: string
  timestampMs: number
  durationMs: number
}

export interface ReviewTriggerResult {
  shouldReview: boolean
  reason: string
}

export interface ReviewConfig {
  retryRateThreshold: number       // default 0.3
  ineffectivenessThreshold: number // default 0.4
  minStepsForReview: number        // default 5
}

interface Skill {
  name: string
  description: string
  domain?: string
}

// Internal types for JSONL parsing
interface ContentBlock {
  type: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  text?: string
  tool_use_id?: string
  content?: string
  is_error?: boolean
}

interface JsonlEntry {
  uuid: string
  type: 'user' | 'assistant' | 'system' | 'file-history-snapshot'
  timestamp: string
  message?: {
    role: string
    content: string | ContentBlock[]
  }
  toolUseResult?: {
    stdout: string
    stderr: string
    interrupted: boolean
    agentId?: string
    status?: string
    totalDurationMs?: number
    totalTokens?: number
    totalToolUseCount?: number
  }
  isCompactSummary?: boolean
}

// ============================================================================
// Constants
// ============================================================================

const BROWSER_TOOLS = new Set([
  'mcp__browser__browser_open',
  'mcp__browser__browser_snapshot',
  'mcp__browser__browser_click',
  'mcp__browser__browser_fill',
  'mcp__browser__browser_scroll',
  'mcp__browser__browser_wait',
  'mcp__browser__browser_press',
  'mcp__browser__browser_screenshot',
  'mcp__browser__browser_select',
  'mcp__browser__browser_hover',
  'mcp__browser__browser_run',
  'mcp__browser__browser_get_state',
])

const SNAPSHOT_TOOLS = new Set([
  'mcp__browser__browser_snapshot',
  'mcp__browser__browser_get_state',
  'mcp__browser__browser_screenshot',
])

const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  retryRateThreshold: 0.3,
  ineffectivenessThreshold: 0.4,
  minStepsForReview: 5,
}

// ============================================================================
// Trace Extraction
// ============================================================================

/**
 * Parse a browser sub-agent's JSONL log into a structured workflow trace.
 */
export function extractBrowserWorkflowTrace(
  jsonlPath: string,
  goal: string
): BrowserWorkflowTrace {
  const content = fs.readFileSync(jsonlPath, 'utf-8')
  const lines = content.split('\n').filter(line => line.trim())

  const entries: JsonlEntry[] = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as JsonlEntry
      // Skip compact summaries, system entries, and file-history-snapshot entries
      if (entry.isCompactSummary) continue
      if (entry.type === 'system' || entry.type === 'file-history-snapshot') continue
      entries.push(entry)
    } catch {
      // Skip malformed lines
    }
  }

  // Extract session/subagent IDs from the file path
  const pathParts = jsonlPath.split('/')
  const fileName = pathParts[pathParts.length - 1] || ''
  const subagentId = fileName.replace('agent-', '').replace('.jsonl', '')
  const sessionIdx = pathParts.indexOf('sessions')
  const sessionId = sessionIdx >= 0 && sessionIdx + 1 < pathParts.length
    ? pathParts[sessionIdx + 1]
    : ''

  // Pair tool_use blocks with their tool_result blocks
  const steps = extractSteps(entries)

  // Detect retries
  detectRetries(steps)

  // Determine start URL
  const startUrl = findStartUrl(steps)

  // Determine outcome from the last entry or tool result metadata
  const outcome = determineOutcome(entries, steps)

  // Calculate totals from entries
  const firstTimestamp = entries.length > 0 ? new Date(entries[0].timestamp).getTime() : 0
  const lastTimestamp = entries.length > 0 ? new Date(entries[entries.length - 1].timestamp).getTime() : 0
  const totalDurationMs = lastTimestamp - firstTimestamp

  // Find subagent completion metadata if available
  const completionEntry = entries.find(e => e.toolUseResult?.agentId)
  const totalTokens = completionEntry?.toolUseResult?.totalTokens ?? 0
  const totalToolUseCount = completionEntry?.toolUseResult?.totalToolUseCount ?? steps.length

  return {
    sessionId,
    subagentId,
    startUrl,
    goal,
    steps,
    outcome,
    totalDurationMs,
    totalTokens,
    totalToolUseCount,
  }
}

/**
 * Extract browser interaction steps by pairing tool_use with tool_result blocks.
 */
function extractSteps(entries: JsonlEntry[]): BrowserWorkflowStep[] {
  const steps: BrowserWorkflowStep[] = []

  // Collect all tool_use and tool_result blocks across entries
  const toolUseMap = new Map<string, { name: string; input: Record<string, unknown>; timestamp: string }>()
  const toolResults: Array<{ toolUseId: string; output: string; isError: boolean; timestamp: string }> = []

  for (const entry of entries) {
    if (!entry.message?.content || typeof entry.message.content === 'string') continue

    for (const block of entry.message.content) {
      if (block.type === 'tool_use' && block.id && block.name && BROWSER_TOOLS.has(block.name)) {
        toolUseMap.set(block.id, {
          name: block.name,
          input: block.input || {},
          timestamp: entry.timestamp,
        })
      }

      if (block.type === 'tool_result' && block.tool_use_id && toolUseMap.has(block.tool_use_id)) {
        toolResults.push({
          toolUseId: block.tool_use_id,
          output: typeof block.content === 'string' ? block.content : '',
          isError: block.is_error ?? false,
          timestamp: entry.timestamp,
        })
      }
    }
  }

  // Build steps from paired tool_use + tool_result
  let index = 0
  for (const result of toolResults) {
    const use = toolUseMap.get(result.toolUseId)
    if (!use) continue

    const timestampMs = new Date(use.timestamp).getTime()
    const resultTimestampMs = new Date(result.timestamp).getTime()

    steps.push({
      index,
      tool: use.name,
      input: use.input,
      output: result.output,
      wasEffective: true, // Will be refined below
      isRetry: false,     // Will be refined by detectRetries
      timestampMs,
      durationMs: resultTimestampMs - timestampMs,
    })
    index++
  }

  // Classify step effectiveness
  classifyAllStepEffectiveness(steps)

  return steps
}

/**
 * Classify effectiveness for all steps by comparing surrounding snapshots.
 */
function classifyAllStepEffectiveness(steps: BrowserWorkflowStep[]): void {
  // Track the last snapshot output to compare against
  let lastSnapshotOutput: string | null = null

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const toolName = step.tool.replace('mcp__browser__', '')

    // Snapshots are always "effective" (informational, not actions)
    if (SNAPSHOT_TOOLS.has(step.tool)) {
      lastSnapshotOutput = step.output
      step.wasEffective = true
      continue
    }

    // browser_open is effective if no error in output
    if (toolName === 'browser_open') {
      step.wasEffective = !step.output.toLowerCase().includes('error')
        && !step.output.toLowerCase().includes('failed')
      lastSnapshotOutput = null // Page changed, invalidate snapshot
      continue
    }

    // For actions (click, fill, press, hover, select), check if next snapshot differs
    const nextSnapshotStep = steps.slice(i + 1).find(s => SNAPSHOT_TOOLS.has(s.tool))
    if (lastSnapshotOutput && nextSnapshotStep) {
      step.wasEffective = nextSnapshotStep.output !== lastSnapshotOutput
    } else if (step.output.toLowerCase().includes('error') || step.output.toLowerCase().includes('failed')) {
      step.wasEffective = false
    }
    // else keep default true

    // For scroll sequences: only the last scroll before a non-scroll action is effective
    if (toolName === 'browser_scroll') {
      const nextNonScroll = steps.slice(i + 1).find(s =>
        !s.tool.endsWith('browser_scroll') && !SNAPSHOT_TOOLS.has(s.tool)
      )
      const nextStep = steps[i + 1]
      if (nextStep && nextStep.tool.endsWith('browser_scroll')) {
        // Not the last scroll in a sequence
        step.wasEffective = false
      } else if (nextNonScroll) {
        step.wasEffective = true
      }
    }

    // Update last snapshot if this step produced a snapshot-like result
    if (SNAPSHOT_TOOLS.has(step.tool)) {
      lastSnapshotOutput = step.output
    }
  }
}

/**
 * Mark steps that repeat similar actions after a failure (retries).
 */
function detectRetries(steps: BrowserWorkflowStep[]): void {
  for (let i = 1; i < steps.length; i++) {
    const current = steps[i]
    // Skip non-action tools
    if (SNAPSHOT_TOOLS.has(current.tool)) continue

    // Look back at recent steps (within last 5 action steps)
    const lookback = steps.slice(Math.max(0, i - 5), i)
      .filter(s => !SNAPSHOT_TOOLS.has(s.tool))

    for (const prev of lookback) {
      if (prev.tool === current.tool && !prev.wasEffective && isSimilarInput(prev.input, current.input)) {
        current.isRetry = true
        break
      }
    }
  }
}

/**
 * Check if two tool inputs are similar (same tool, similar target).
 */
function isSimilarInput(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  // Same ref
  if (a.ref && b.ref && a.ref === b.ref) return true

  // Same URL
  if (a.url && b.url && a.url === b.url) return true

  // Same value being filled
  if (a.value && b.value && a.value === b.value) return true

  // Same direction for scroll
  if (a.direction && b.direction && a.direction === b.direction) return true

  // Same key for press
  if (a.key && b.key && a.key === b.key) return true

  return false
}

/**
 * Find the first URL navigated to in the workflow.
 */
function findStartUrl(steps: BrowserWorkflowStep[]): string {
  for (const step of steps) {
    if (step.tool.endsWith('browser_open') && typeof step.input.url === 'string') {
      return step.input.url
    }
  }
  return ''
}

/**
 * Determine the workflow outcome based on the trace.
 */
function determineOutcome(
  entries: JsonlEntry[],
  steps: BrowserWorkflowStep[]
): 'success' | 'partial' | 'failure' {
  // Check for subagent completion metadata
  for (const entry of entries) {
    if (entry.toolUseResult?.status) {
      if (entry.toolUseResult.status === 'cancelled' || entry.toolUseResult.interrupted) {
        return 'partial'
      }
    }
  }

  if (steps.length === 0) return 'failure'

  // Check if the last few action steps were effective
  const actionSteps = steps.filter(s => !SNAPSHOT_TOOLS.has(s.tool))
  if (actionSteps.length === 0) return 'partial'

  const lastActions = actionSteps.slice(-3)
  const allFailed = lastActions.every(s => !s.wasEffective)
  if (allFailed) return 'failure'

  // Check overall retry/failure rate
  const retryRate = actionSteps.filter(s => s.isRetry).length / actionSteps.length
  const ineffectiveRate = actionSteps.filter(s => !s.wasEffective).length / actionSteps.length

  if (retryRate > 0.5 || ineffectiveRate > 0.6) return 'partial'

  return 'success'
}

// ============================================================================
// Smart Trigger
// ============================================================================

/**
 * Decide whether a completed browser workflow warrants review.
 */
export async function shouldTriggerReview(
  trace: BrowserWorkflowTrace,
  existingSkills: Skill[],
  config: Partial<ReviewConfig> = {}
): Promise<ReviewTriggerResult> {
  const cfg = { ...DEFAULT_REVIEW_CONFIG, ...config }

  // Skip if too few steps to learn from
  if (trace.totalToolUseCount < cfg.minStepsForReview) {
    return { shouldReview: false, reason: `Too few steps (${trace.totalToolUseCount} < ${cfg.minStepsForReview})` }
  }

  // Condition 4: Failure outcome
  if (trace.outcome === 'failure') {
    return { shouldReview: true, reason: 'Workflow failed' }
  }

  const actionSteps = trace.steps.filter(s => !SNAPSHOT_TOOLS.has(s.tool))
  if (actionSteps.length === 0) {
    return { shouldReview: false, reason: 'No action steps found' }
  }

  // Condition 1: High retry rate
  const retryRate = actionSteps.filter(s => s.isRetry).length / actionSteps.length
  if (retryRate > cfg.retryRateThreshold) {
    return { shouldReview: true, reason: `High retry rate: ${(retryRate * 100).toFixed(0)}%` }
  }

  // Condition 2: Low effectiveness ratio
  const ineffectiveRate = actionSteps.filter(s => !s.wasEffective).length / actionSteps.length
  if (ineffectiveRate > cfg.ineffectivenessThreshold) {
    return { shouldReview: true, reason: `Low effectiveness: ${((1 - ineffectiveRate) * 100).toFixed(0)}% effective` }
  }

  // Condition 3: No matching skill for this domain + task
  if (existingSkills.length === 0) {
    return { shouldReview: true, reason: 'No existing skills' }
  }

  const matchingSkill = await findMatchingSkill(existingSkills, trace)
  if (!matchingSkill) {
    return { shouldReview: true, reason: 'No existing skill covers this domain + task' }
  }

  // All healthy and skill exists — skip review
  return { shouldReview: false, reason: `Workflow succeeded with existing skill "${matchingSkill}", metrics healthy` }
}

/**
 * Use haiku to determine if any existing skill covers the trace's task.
 * Returns the matching skill name, or null if none match.
 */
async function findMatchingSkill(
  skills: Skill[],
  trace: BrowserWorkflowTrace
): Promise<string | null> {
  const client = new Anthropic()

  const skillList = skills
    .map(s => `- "${s.name}": ${s.description}${s.domain ? ` (domain: ${s.domain})` : ''}`)
    .join('\n')

  let domain = ''
  try {
    domain = new URL(trace.startUrl).hostname.replace('www.', '')
  } catch {
    // Invalid URL
  }

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `Does any of these skills cover this exact task? A skill matches only if it describes the same specific workflow — same domain AND same type of action (not just the same website).

Task: "${trace.goal}"
Domain: ${domain || 'unknown'}

Skills:
${skillList}

Reply with ONLY the skill name if one matches, or "none" if no skill covers this specific task.`,
    }],
  })

  const answer = (response.content[0] as { type: string; text: string }).text.trim().toLowerCase()

  if (answer === 'none') return null

  // Verify the response matches an actual skill name
  const matched = skills.find(s => s.name.toLowerCase() === answer)
  return matched ? matched.name : null
}

// ============================================================================
// Helpers for code-driven review trigger
// ============================================================================

/**
 * Scan existing skills from .claude/skills/<name>/SKILL.md frontmatter.
 * Returns an array of skill metadata for use in shouldTriggerReview().
 */
export function scanExistingSkills(
  workDir: string
): Array<{ name: string; description: string; domain?: string }> {
  const skillsDir = path.join(workDir, '.claude', 'skills')
  if (!fs.existsSync(skillsDir)) return []

  const skills: Array<{ name: string; description: string; domain?: string }> = []

  let entries: string[]
  try {
    entries = fs.readdirSync(skillsDir)
  } catch {
    return []
  }

  for (const entry of entries) {
    const skillMdPath = path.join(skillsDir, entry, 'SKILL.md')
    if (!fs.existsSync(skillMdPath)) continue

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8')

      // Parse YAML frontmatter between --- delimiters
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (!fmMatch) continue

      const frontmatter = fmMatch[1]

      // Simple regex extraction (avoids YAML parser dependency)
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
      const domainMatch = frontmatter.match(/^\s*domain:\s*(.+)$/m)

      if (nameMatch && descMatch) {
        skills.push({
          name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
          description: descMatch[1].trim().replace(/^["']|["']$/g, ''),
          domain: domainMatch ? domainMatch[1].trim().replace(/^["']|["']$/g, '') : undefined,
        })
      }
    } catch {
      // Skip unreadable skill files
    }
  }

  return skills
}
