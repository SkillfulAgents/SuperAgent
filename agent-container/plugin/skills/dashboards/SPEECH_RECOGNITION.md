# Speech Recognition API

Dashboards running inside Gamut have access to the standard [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) (`SpeechRecognition`). This is a web standard — any examples or documentation you find online for the browser SpeechRecognition API will work here.

Under the hood, the polyfill routes audio to the user's configured STT provider (Deepgram, OpenAI, or Platform) via the Gamut backend. Dashboards don't need API keys or provider-specific code — just use the standard API.

## Quick Start

```javascript
const recognition = new SpeechRecognition();
recognition.continuous = true;
recognition.interimResults = true;

recognition.onresult = (event) => {
  const result = event.results[event.resultIndex];
  const transcript = result[0].transcript;

  if (result.isFinal) {
    console.log('Final:', transcript);
  } else {
    console.log('Interim:', transcript);
  }
};

recognition.onerror = (event) => {
  console.error('Speech recognition error:', event.error, event.message);
};

recognition.onend = () => {
  console.log('Recognition ended');
};

recognition.start();
```

## Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `continuous` | boolean | `false` | When `false`, stops after the first final result. When `true`, keeps listening until `stop()` is called. |
| `interimResults` | boolean | `false` | When `true`, fires `result` events for partial/interim transcripts in addition to final ones. |
| `lang` | string | `''` | Language hint (currently informational — the STT provider uses its default language model). |
| `maxAlternatives` | number | `1` | Accepted for compatibility but only one alternative is returned. |

## Methods

| Method | Description |
|--------|-------------|
| `start()` | Begin capturing audio and transcribing. Throws `InvalidStateError` if already started. |
| `stop()` | Gracefully stop — processes any remaining audio, then fires `end`. |
| `abort()` | Immediately stop and discard any pending results. |

## Events

| Event | When |
|-------|------|
| `start` | Recognition service has connected and is ready. |
| `audiostart` | Audio capture has begun. |
| `speechstart` | Speech has been detected in the audio. |
| `result` | A transcript result is available (interim or final). |
| `speechend` | Speech has stopped being detected. |
| `audioend` | Audio capture has stopped. |
| `end` | The recognition service has fully disconnected. |
| `error` | An error occurred. |
| `nomatch` | Recognition ended without detecting any speech. |

## The `result` Event

The `result` event's `results` property is a list of `SpeechRecognitionResult` objects:

```javascript
recognition.onresult = (event) => {
  // Index of the result that changed
  const i = event.resultIndex;

  // The result object
  const result = event.results[i];
  result.isFinal;          // boolean — true if this is a final transcript
  result[0].transcript;    // string — the transcribed text
  result[0].confidence;    // number — confidence score (0-1)

  // In continuous mode, event.results accumulates all results from the session
  for (let j = 0; j < event.results.length; j++) {
    console.log(event.results[j][0].transcript, event.results[j].isFinal);
  }
};
```

## Error Codes

| Code | Meaning |
|------|---------|
| `not-allowed` | Microphone permission was denied by the user. |
| `audio-capture` | No microphone available or it could not be accessed. |
| `network` | WebSocket connection to the STT provider failed. |
| `service-not-allowed` | No STT provider is configured in Gamut settings. |
| `no-speech` | `stop()` was called but no speech was detected. |
| `aborted` | `abort()` was called. |

## Examples

### Voice Command Button

```html
<button id="mic-btn">🎤 Hold to speak</button>
<p id="output"></p>

<script>
  const btn = document.getElementById('mic-btn');
  const output = document.getElementById('output');
  const recognition = new SpeechRecognition();
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    output.textContent = event.results[event.resultIndex][0].transcript;
  };

  btn.addEventListener('mousedown', () => recognition.start());
  btn.addEventListener('mouseup', () => recognition.stop());
</script>
```

### Continuous Transcription Log

```javascript
const recognition = new SpeechRecognition();
recognition.continuous = true;
recognition.interimResults = false;

const log = [];

recognition.onresult = (event) => {
  const transcript = event.results[event.resultIndex][0].transcript;
  log.push({ time: new Date().toISOString(), text: transcript });
  renderLog(log);
};

recognition.onend = () => {
  // Restart if it disconnects (e.g., token expiry after ~10 minutes)
  recognition.start();
};

recognition.start();
```

### Search-as-you-speak

```javascript
const recognition = new SpeechRecognition();
recognition.continuous = true;
recognition.interimResults = true;

let searchTimeout;

recognition.onresult = (event) => {
  const transcript = event.results[event.resultIndex][0].transcript;
  document.getElementById('search-input').value = transcript;

  // Debounce search while speaking
  clearTimeout(searchTimeout);
  if (event.results[event.resultIndex].isFinal) {
    performSearch(transcript);
  } else {
    searchTimeout = setTimeout(() => performSearch(transcript), 500);
  }
};

recognition.start();
```

## Notes

- The API is automatically available in all dashboards — no imports or setup required.
- Microphone permission is granted by the Gamut app. The user may see a one-time browser prompt.
- This is a standard Web API. Search for "Web Speech API SpeechRecognition" for more examples and patterns.
- If recognition stops unexpectedly after ~10 minutes, the STT provider token expired. Simply call `start()` again in the `onend` handler.
- Both `SpeechRecognition` and `webkitSpeechRecognition` are available (for compatibility with code written for Chrome).
