import { useParams, useSearch } from '@tanstack/react-router'
import { MeetingParticipantPage } from '@renderer/components/meeting/meeting-participant-page'

export function MeetingParticipantRoute() {
  const { meetingId } = useParams({ strict: false }) as { meetingId?: string }
  const search = useSearch({ strict: false }) as { token?: string }
  if (!meetingId) return null
  return <MeetingParticipantPage meetingId={meetingId} token={search.token ?? ''} />
}
