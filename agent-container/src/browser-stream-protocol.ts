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

/** Pixel ratios a viewer can ask for with `/browser/stream?scale=…`; 1 is the default. */
export const BROWSER_STREAM_SCALES = [1, 1.5, 2] as const;
export type BrowserStreamScale = typeof BROWSER_STREAM_SCALES[number];

export function parseBrowserStreamScale(value: string | null | undefined): BrowserStreamScale {
  const scale = Number(value);
  return BROWSER_STREAM_SCALES.find((allowed) => allowed === scale) ?? 1;
}

/** Stream query value a viewer sends (`/browser/stream?codec=h264`) when it can decode H.264. */
export const H264_STREAM_CODEC = 'h264';

/**
 * Binary H.264 frames are 'A' 'V' 'C', a flags byte (bit 0 = keyframe), then
 * one Annex B access unit. Screencast JPEGs start with 0xFF 0xD8, so the first
 * bytes tell the two apart and viewers keep working against images that only send JPEG.
 */
export const H264_FRAME_HEADER_BYTES = 4;
const H264_MAGIC = [0x41, 0x56, 0x43];

export function encodeH264FrameMessage(frame: Uint8Array, keyFrame: boolean): Uint8Array {
  const message = new Uint8Array(H264_FRAME_HEADER_BYTES + frame.length);
  message.set(H264_MAGIC, 0);
  message[3] = keyFrame ? 1 : 0;
  message.set(frame, H264_FRAME_HEADER_BYTES);
  return message;
}

export function isH264FrameMessage(bytes: Uint8Array): boolean {
  return bytes.length > H264_FRAME_HEADER_BYTES
    && bytes[0] === H264_MAGIC[0] && bytes[1] === H264_MAGIC[1] && bytes[2] === H264_MAGIC[2];
}

export function isH264KeyFrameMessage(bytes: Uint8Array): boolean {
  return isH264FrameMessage(bytes) && (bytes[3] & 1) === 1;
}

/** Asks the container to restart the H.264 stream from a keyframe after frames were lost. */
export interface BrowserKeyframeRequest {
  type: 'keyframe_request';
}
