export const ISSUE_FIELDS = 'id identifier title updatedAt archivedAt delegate{id} state{id name type}'
export const COMMENT_FIELDS = 'id body createdAt updatedAt archivedAt user{id app} parent{id}'
export const HISTORY_FIELDS = 'id createdAt updatedAt actor{id app} fromDelegate{id} toDelegate{id} fromState{id} toState{id name type} archived'

// Receive the event itself. No notification/history scans or reconnect replay.
export const DIRECT_SUBSCRIPTIONS = {
  notificationCreated: `subscription{notificationCreated{id type createdAt updatedAt user{id} actor{id app} ...on IssueNotification{issue{${ISSUE_FIELDS}} comment{${COMMENT_FIELDS}}}}}`,
  commentCreated: `subscription{commentCreated{${COMMENT_FIELDS} issue{${ISSUE_FIELDS}}}}`,
  commentUpdated: `subscription{commentUpdated{${COMMENT_FIELDS} issue{${ISSUE_FIELDS}}}}`,
  issueHistoryCreated: `subscription{issueHistoryCreated{${HISTORY_FIELDS} issue{${ISSUE_FIELDS}}}}`,
} as const
