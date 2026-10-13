/** Install after navigation: only WebRTC is faked, so the real voice adapter handles every event. */
export function installLiveVoiceMocks() {
  const events: Array<{ type: string; content?: string }> = []
  let microphone: MediaStream | null = null
  let channel: Channel | null = null
  // Patch the prototype: WebKit can lose an instance override before mic acquisition.
  MediaDevices.prototype.getUserMedia = async () => {
    microphone = new AudioContext().createMediaStreamDestination().stream
    return microphone
  }
  class Channel {
    readyState = 'open'
    onmessage?: (event: { data: string }) => void
    send(data: string) {
      try { events.push(JSON.parse(data)) }
      catch { throw new Error('The voice adapter sent malformed event JSON.') }
    }
    close() {}
  }
  window.RTCPeerConnection = class {
    channel = new Channel()
    constructor() { channel = this.channel }
    connectionState = 'connected'
    iceGatheringState = 'complete'
    localDescription = { type: 'offer', sdp: 'mock-offer' }
    createDataChannel() { return this.channel }
    async createOffer() { return this.localDescription }
    async setLocalDescription() {}
    async setRemoteDescription() {
      setTimeout(() => this.channel.onmessage?.({ data: JSON.stringify({ type: 'session.started' }) }), 10)
    }
    addTrack() {}
    close() {}
  } as unknown as typeof RTCPeerConnection
  return {
    events,
    microphoneEnabled: () => microphone?.getAudioTracks().some(track => track.enabled) ?? false,
    receive: (event: Record<string, unknown>) => channel?.onmessage?.({ data: JSON.stringify(event) }),
  }
}
