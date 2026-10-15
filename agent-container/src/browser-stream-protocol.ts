/** Browser stream types live in the container so its standalone image can build them. */
export interface BrowserTabInfo {
  targetId: string;
  index: number;
  url: string;
  title: string;
  faviconUrl?: string;
  /** The agent's active tab, which can differ from the viewer's selection. */
  active: boolean;
}

export type BrowserNavigateAction = 'back' | 'forward' | 'reload';

export interface BrowserHistoryState {
  canGoBack: boolean;
  canGoForward: boolean;
  url: string;
}

export interface BrowserHistoryMessage extends BrowserHistoryState {
  type: 'history_state';
  /** Optional while older container images are still in use. */
  targetId?: string;
}

export interface BrowserTabListMessage {
  type: 'tab_list';
  tabs: BrowserTabInfo[];
  activeTargetId: string;
}

export interface BrowserNavigateCommand {
  type: 'navigate';
  action: BrowserNavigateAction;
}

/** Stream query value a viewer sends (`/browser/stream?codec=vp8`) when it can decode VP8. */
export const VP8_STREAM_CODEC = 'vp8';

/**
 * Binary VP8 frames are 'V' 'P' '8', a flags byte (bit 0 = keyframe), then one
 * raw VP8 frame. Screencast JPEGs start with 0xFF 0xD8, so the first bytes tell
 * the two apart and viewers keep working against images that only send JPEG.
 */
export const VP8_FRAME_HEADER_BYTES = 4;
const VP8_MAGIC = [0x56, 0x50, 0x38];

export function encodeVp8FrameMessage(frame: Uint8Array, keyFrame: boolean): Uint8Array {
  const message = new Uint8Array(VP8_FRAME_HEADER_BYTES + frame.length);
  message.set(VP8_MAGIC, 0);
  message[3] = keyFrame ? 1 : 0;
  message.set(frame, VP8_FRAME_HEADER_BYTES);
  return message;
}

export function isVp8FrameMessage(bytes: Uint8Array): boolean {
  return bytes.length > VP8_FRAME_HEADER_BYTES
    && bytes[0] === VP8_MAGIC[0] && bytes[1] === VP8_MAGIC[1] && bytes[2] === VP8_MAGIC[2];
}

export function isVp8KeyFrameMessage(bytes: Uint8Array): boolean {
  return isVp8FrameMessage(bytes) && (bytes[3] & 1) === 1;
}

/** Asks the container to restart the VP8 stream from a keyframe after frames were lost. */
export interface BrowserKeyframeRequest {
  type: 'keyframe_request';
}
