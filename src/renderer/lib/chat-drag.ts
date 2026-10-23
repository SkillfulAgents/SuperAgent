/** A chat dragged from the sidebar, as the composer reads it on drop. */
export interface DraggedChat {
  agentSlug: string
  sessionId: string
  name: string
}

const CHAT_DRAG_TYPE = 'application/x-gamut-chat'

/** Replaces the link's own drag data, so nothing drops the chat's URL as text. */
export function setChatDragData(dataTransfer: DataTransfer, chat: DraggedChat): void {
  dataTransfer.clearData()
  dataTransfer.setData(CHAT_DRAG_TYPE, JSON.stringify(chat))
  dataTransfer.effectAllowed = 'copy'
}

export function isChatDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(CHAT_DRAG_TYPE)
}

/** The dragged chat, readable only on drop. */
export function readChatDrag(dataTransfer: DataTransfer): DraggedChat | null {
  try {
    const chat = JSON.parse(dataTransfer.getData(CHAT_DRAG_TYPE))
    return typeof chat?.agentSlug === 'string' && typeof chat?.sessionId === 'string' && typeof chat?.name === 'string' ? chat : null
  } catch {
    return null
  }
}
