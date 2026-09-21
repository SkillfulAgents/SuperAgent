export const DIRECT_ISSUE_FIELDS = 'id identifier title updatedAt archivedAt delegate{id} state{id name type}'
export const DIRECT_COMMENT_FIELDS = 'id body createdAt updatedAt archivedAt user{id app} parent{id}'
export const DIRECT_HISTORY_FIELDS = 'id createdAt updatedAt actor{id app} fromDelegate{id} toDelegate{id} fromState{id} toState{id name type} archived'
export const DIRECT_NOTIFICATIONS = `query($after:String,$since:DateTimeOrDuration!){notifications(first:100,after:$after,includeArchived:true,orderBy:updatedAt,filter:{updatedAt:{gte:$since},type:{in:["issueAssignedToYou","issueMention","issueCommentMention"]}}){nodes{id type createdAt updatedAt ...on IssueNotification{issue{${DIRECT_ISSUE_FIELDS}} actor{id app} comment{${DIRECT_COMMENT_FIELDS}}}} pageInfo{hasNextPage endCursor}}}`
export const DIRECT_COMMENTS = `query($after:String,$since:DateTimeOrDuration!,$ids:[ID!]!){comments(first:100,after:$after,includeArchived:true,orderBy:updatedAt,filter:{updatedAt:{gte:$since},issue:{id:{in:$ids}}}){nodes{${DIRECT_COMMENT_FIELDS} issue{${DIRECT_ISSUE_FIELDS}}} pageInfo{hasNextPage endCursor}}}`
export const DIRECT_TRACKED_ISSUES = `query($after:String,$ids:[ID!]!){issues(first:100,after:$after,includeArchived:true,filter:{id:{in:$ids}}){nodes{${DIRECT_ISSUE_FIELDS}} pageInfo{hasNextPage endCursor}}}`
export const DIRECT_ISSUE_HISTORY = `query($id:String!,$after:String){issue(id:$id){${DIRECT_ISSUE_FIELDS} history(first:100,after:$after,orderBy:updatedAt,includeArchived:true){nodes{${DIRECT_HISTORY_FIELDS}} pageInfo{hasNextPage endCursor}}}}`

// Subscriptions are wakeups. Recovery queries supply the durable payloads, so
// reconnects and overlapping notifications go through exactly the same path.
export const DIRECT_SUBSCRIPTIONS: Record<string, string> = {
  notificationCreated: 'subscription{notificationCreated{id}}',
  notificationUpdated: 'subscription{notificationUpdated{id}}',
  commentCreated: 'subscription{commentCreated{issue{id}}}',
  commentUpdated: 'subscription{commentUpdated{issue{id}}}',
  issueHistoryCreated: 'subscription{issueHistoryCreated{issue{id}}}',
  issueHistoryUpdated: 'subscription{issueHistoryUpdated{issue{id}}}',
  issueUpdated: 'subscription{issueUpdated{id}}',
  issueArchived: 'subscription{issueArchived{id}}',
  userUpdated: 'subscription{userUpdated{id}}',
}
