// Bridge to the container, which owns the wire contract and builds independently.
export {
  BROWSER_STREAM_SCALES,
  parseBrowserStreamScale,
  H264_STREAM_CODEC,
  H264_FRAME_HEADER_BYTES,
  isH264FrameMessage,
  isH264KeyFrameMessage,
} from '../../../agent-container/src/browser-stream-protocol'
export type {
  BrowserKeyframeRequest,
  BrowserStreamScale,
  BrowserTabInfo,
  BrowserHistoryState,
  BrowserHistoryMessage,
  BrowserTabListMessage,
  BrowserNavigateAction,
  BrowserNavigateCommand,
} from '../../../agent-container/src/browser-stream-protocol'
