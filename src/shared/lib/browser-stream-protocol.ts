// Bridge to the container, which owns the wire contract and builds independently.
export {
  VP8_STREAM_CODEC,
  VP8_FRAME_HEADER_BYTES,
  isVp8FrameMessage,
  isVp8KeyFrameMessage,
} from '../../../agent-container/src/browser-stream-protocol'
export type {
  BrowserKeyframeRequest,
  BrowserTabInfo,
  BrowserHistoryState,
  BrowserHistoryMessage,
  BrowserTabListMessage,
  BrowserNavigateAction,
  BrowserNavigateCommand,
} from '../../../agent-container/src/browser-stream-protocol'
