import { expect, it } from 'vitest'
import { githubTaskEvent, mentionsGitHubApp, readGitHubWebhook } from './relay-events'
import { appIdentity, body, comment, delivery } from './test-fixtures'

it.each([false, true])('verifies exact forwarded bytes, including base64=%s', base64 => {
  expect(readGitHubWebhook(delivery(body, 'issue_comment', 'id', appIdentity.webhookSecret, base64), appIdentity.webhookSecret)?.body.comment?.body).toBe(comment.body)
  expect(readGitHubWebhook(delivery(body, 'issue_comment', 'id', 'wrong'), appIdentity.webhookSecret)).toBeNull()
  const tampered = delivery()
  Object.assign(tampered.payload!, { body: JSON.stringify({ ...body, action: 'deleted' }), verified: true })
  expect(readGitHubWebhook(tampered, appIdentity.webhookSecret)).toBeNull()
})
it.each(['@release-helper do it', '@release-helper[bot] do it', 'Hello @Release-Helper!'])('recognizes an exact bot mention: %s', text => {
  expect(mentionsGitHubApp(text, 'release-helper')).toBe(true)
})
it.each(['@release-helper-other', 'x@release-helper', '`@release-helper`', '```\n@release-helper\n```'])('ignores non-invocations: %s', text => {
  expect(mentionsGitHubApp(text, 'release-helper')).toBe(false)
})
it('routes PR conversation comments to the same issue session and inline replies to their root', () => {
  expect(githubTaskEvent('issue_comment', 'id', body, 'release-helper', false)).toMatchObject({ taskId: 'team/project#3', trigger: 'comment_mention', replyTarget: {} })
  expect(githubTaskEvent('pull_request_review_comment', 'id', { ...body, issue: undefined, pull_request: body.issue, comment: { ...comment, in_reply_to_id: 7 } }, 'release-helper', false)).toMatchObject({ taskId: 'team/project#3', replyTarget: { commentId: '7' }, sourceCommentId: '11' })
})
it('accepts new human follow-ups only after joining, and never runs on bot replies or state changes', () => {
  const followup = { ...body, comment: { ...comment, body: 'Also update the docs' } }
  expect(githubTaskEvent('issue_comment', 'id', followup, 'release-helper', false)).toBeNull()
  expect(githubTaskEvent('issue_comment', 'id', followup, 'release-helper', true)?.trigger).toBe('comment')
  expect(githubTaskEvent('issue_comment', 'id', { ...body, sender: { ...body.sender, type: 'Bot' } }, 'release-helper', true)).toBeNull()
  expect(githubTaskEvent('issues', 'id', { ...body, action: 'closed' }, 'release-helper', true)).toBeNull()
})
