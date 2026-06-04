let cached: string | null = null

export function getPolyfillJs(): string {
  if (cached) return cached
  cached = POLYFILL_SOURCE
  return cached
}

// ---------------------------------------------------------------------------
// Self-contained vanilla JS polyfill for the W3C SpeechRecognition API.
// Runs inside dashboard iframes. Routes audio through the app's configured
// STT provider (Deepgram / OpenAI / Platform) via /api/stt/token.
// ---------------------------------------------------------------------------

const POLYFILL_SOURCE = /* js */ `(function () {
  "use strict";

  // Always override — Chromium defines webkitSpeechRecognition but it fails with
  // "network" error because there's no Google Speech backend in Electron.

  // -- Helpers ----------------------------------------------------------------

  function float32ToInt16(float32) {
    var int16 = new Int16Array(float32.length);
    for (var i = 0; i < float32.length; i++) {
      var s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
  }

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // -- Adapters ---------------------------------------------------------------

  var CONNECT_TIMEOUT = 10000;

  function createDeepgramAdapter() {
    var ws = null;
    var transcriptCb = null;
    var errorCb = null;
    var connected = false;
    var params =
      "model=nova-3&interim_results=true&smart_format=true&endpointing=300" +
      "&vad_events=true&utterance_end_ms=1000&encoding=linear16&sample_rate=16000&channels=1";

    return {
      sampleRate: 16000,
      connect: function (token) {
        return new Promise(function (resolve, reject) {
          ws = new WebSocket("wss://api.deepgram.com/v1/listen?" + params, ["bearer", token]);
          var timeout = setTimeout(function () {
            ws.close();
            reject(new Error("Deepgram connection timed out"));
          }, CONNECT_TIMEOUT);

          ws.onopen = function () { clearTimeout(timeout); connected = true; resolve(); };
          ws.onerror = function () {
            clearTimeout(timeout);
            var err = new Error("Deepgram connection failed");
            if (!connected) reject(err); else if (errorCb) errorCb(err);
          };
          ws.onmessage = function (event) {
            try {
              var data = JSON.parse(event.data);
              if (data.type === "Results") {
                var alt = data.channel && data.channel.alternatives && data.channel.alternatives[0];
                if (!alt || !alt.transcript) return;
                var type = data.speech_final || data.is_final ? "final" : "interim";
                if (transcriptCb) transcriptCb({ type: type, text: alt.transcript });
              } else if (data.type === "UtteranceEnd") {
                if (transcriptCb) transcriptCb({ type: "speech_ended", text: "" });
              }
            } catch (_) {}
          };
          ws.onclose = function (ev) {
            if (ev.code !== 1000 && ev.code !== 1005 && errorCb)
              errorCb(new Error("Deepgram closed: " + ev.code + " " + ev.reason));
          };
        });
      },
      sendAudio: function (chunk) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(chunk);
      },
      onTranscript: function (cb) { transcriptCb = cb; },
      onError: function (cb) { errorCb = cb; },
      close: function () {
        if (ws) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
          ws.close();
          ws = null;
        }
      },
    };
  }

  function createOpenaiAdapter() {
    var ws = null;
    var transcriptCb = null;
    var errorCb = null;
    var pendingDelta = "";
    var connected = false;

    return {
      sampleRate: 24000,
      connect: function (token) {
        return new Promise(function (resolve, reject) {
          ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", [
            "realtime",
            "openai-insecure-api-key." + token,
          ]);
          var timeout = setTimeout(function () {
            ws.close();
            reject(new Error("OpenAI connection timed out"));
          }, CONNECT_TIMEOUT);

          ws.onopen = function () {
            clearTimeout(timeout);
            connected = true;
            ws.send(JSON.stringify({
              type: "session.update",
              session: {
                type: "transcription",
                audio: {
                  input: {
                    format: { type: "audio/pcm", rate: 24000 },
                    noise_reduction: { type: "near_field" },
                    transcription: { model: "gpt-4o-mini-transcribe" },
                    turn_detection: {
                      type: "server_vad",
                      threshold: 0.5,
                      silence_duration_ms: 500,
                      prefix_padding_ms: 300,
                    },
                  },
                },
              },
            }));
            resolve();
          };
          ws.onerror = function () {
            clearTimeout(timeout);
            var err = new Error("OpenAI connection failed");
            if (!connected) reject(err); else if (errorCb) errorCb(err);
          };
          ws.onmessage = function (event) {
            try {
              var data = JSON.parse(event.data);
              switch (data.type) {
                case "conversation.item.input_audio_transcription.delta":
                  if (data.delta) {
                    pendingDelta += data.delta;
                    if (transcriptCb) transcriptCb({ type: "interim", text: pendingDelta });
                  }
                  break;
                case "conversation.item.input_audio_transcription.completed":
                  pendingDelta = "";
                  if (data.transcript && transcriptCb)
                    transcriptCb({ type: "final", text: data.transcript });
                  break;
                case "input_audio_buffer.speech_stopped":
                  if (transcriptCb) transcriptCb({ type: "speech_ended", text: "" });
                  break;
                case "error":
                  if (errorCb) errorCb(new Error((data.error && data.error.message) || "OpenAI error"));
                  break;
              }
            } catch (_) {}
          };
          ws.onclose = function (ev) {
            if (ev.code !== 1000 && ev.code !== 1005 && errorCb)
              errorCb(new Error("OpenAI closed: " + ev.code + " " + ev.reason));
          };
        });
      },
      sendAudio: function (chunk) {
        if (ws && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: arrayBufferToBase64(chunk) }));
      },
      onTranscript: function (cb) { transcriptCb = cb; },
      onError: function (cb) { errorCb = cb; },
      close: function () {
        if (ws) {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          ws.close();
          ws = null;
        }
      },
    };
  }

  function createAdapter(provider) {
    if (provider === "openai") return createOpenaiAdapter();
    return createDeepgramAdapter();
  }

  // -- Audio capture ----------------------------------------------------------

  function startCapture(adapter) {
    var sampleRate = adapter.sampleRate || 16000;
    return navigator.mediaDevices
      .getUserMedia({ audio: { channelCount: 1, sampleRate: sampleRate, echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        var ctx = new AudioContext({ sampleRate: sampleRate });
        var resumeP = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
        return resumeP.then(function () {
          var source = ctx.createMediaStreamSource(stream);
          var processor = ctx.createScriptProcessor(2048, 1, 1);
          processor.onaudioprocess = function (e) {
            adapter.sendAudio(float32ToInt16(e.inputBuffer.getChannelData(0)).buffer);
          };
          source.connect(processor);
          processor.connect(ctx.destination);
          return {
            cleanup: function () {
              processor.disconnect();
              ctx.close();
              stream.getTracks().forEach(function (t) { t.stop(); });
            },
          };
        });
      });
  }

  // -- SpeechRecognition result classes ---------------------------------------

  function SpeechRecognitionAlternative(transcript, confidence) {
    this.transcript = transcript;
    this.confidence = confidence;
  }

  function SpeechRecognitionResult(transcript, isFinal) {
    this.isFinal = isFinal;
    this.length = 1;
    this[0] = new SpeechRecognitionAlternative(transcript, isFinal ? 0.9 : 0.5);
  }
  SpeechRecognitionResult.prototype.item = function (i) { return this[i]; };

  function SpeechRecognitionResultList(results) {
    this.length = results.length;
    for (var i = 0; i < results.length; i++) this[i] = results[i];
  }
  SpeechRecognitionResultList.prototype.item = function (i) { return this[i]; };

  function SpeechRecognitionEvent(type, resultIndex, resultList) {
    var ev = new Event(type);
    ev.resultIndex = resultIndex;
    ev.results = resultList;
    return ev;
  }

  function SpeechRecognitionErrorEvent(error, message) {
    var ev = new Event("error");
    ev.error = error;
    ev.message = message || "";
    return ev;
  }

  // -- SpeechRecognition class ------------------------------------------------

  var EVENT_NAMES = [
    "audiostart", "audioend", "start", "end",
    "speechstart", "speechend", "soundstart", "soundend",
    "result", "error", "nomatch",
  ];

  class SuperagentSpeechRecognition extends EventTarget {
    constructor() {
      super();
      this.continuous = false;
      this.interimResults = false;
      this.lang = "";
      this.maxAlternatives = 1;
      this._state = "inactive";
      this._adapter = null;
      this._capture = null;
      this._results = [];
      this._speechDetected = false;
      this._handlers = {};
    }

    start() {
      if (this._state !== "inactive") {
        throw new DOMException("Recognition is already started", "InvalidStateError");
      }
      this._state = "starting";
      this._results = [];
      this._speechDetected = false;
      var self = this;

      // Absolute path intentional — reaches the Gamut API, not the dashboard's own server
      fetch("/api/stt/token")
        .then(function (res) {
          if (!res.ok) {
            return res.json().catch(function () { return {}; }).then(function (body) {
              var msg = (body && body.error) || "STT not available";
              self._fireError("service-not-allowed", msg);
              throw null;
            });
          }
          return res.json();
        })
        .then(function (data) {
          if (self._state === "inactive") return;
          self._adapter = createAdapter(data.provider);
          self._adapter.onTranscript(function (ev) { self._handleTranscript(ev); });
          self._adapter.onError(function (err) {
            self._fireError("network", err.message);
            self._teardown();
            self.dispatchEvent(new Event("end"));
          });
          return self._adapter.connect(data.token);
        })
        .then(function () {
          if (!self._adapter || self._state === "inactive") return;
          return startCapture(self._adapter);
        })
        .then(function (capture) {
          if (!capture || self._state === "inactive") {
            if (capture) capture.cleanup();
            return;
          }
          self._capture = capture;
          self._state = "active";
          self.dispatchEvent(new Event("start"));
          self.dispatchEvent(new Event("audiostart"));
        })
        .catch(function (err) {
          if (err === null) {
            self._state = "inactive";
            self.dispatchEvent(new Event("end"));
            return;
          }
          var code = "network";
          var message = err.message || "Unknown error";
          if (err.name === "NotAllowedError") { code = "not-allowed"; message = "Microphone permission denied"; }
          else if (err.name === "NotFoundError" || err.name === "NotReadableError") { code = "audio-capture"; message = "Microphone not available"; }
          self._fireError(code, message);
          self._teardown();
          self.dispatchEvent(new Event("end"));
        });
    }

    stop() {
      if (this._state === "inactive") return;
      this._state = "stopping";
      if (this._adapter) this._adapter.close();
      this._cleanupAudio();
      if (!this._speechDetected) this.dispatchEvent(SpeechRecognitionErrorEvent("no-speech", "No speech detected"));
      this.dispatchEvent(new Event("speechend"));
      this.dispatchEvent(new Event("soundend"));
      this.dispatchEvent(new Event("audioend"));
      this._state = "inactive";
      this.dispatchEvent(new Event("end"));
    }

    abort() {
      if (this._state === "inactive") return;
      this._teardown();
      this._state = "inactive";
      this.dispatchEvent(new Event("end"));
    }

    _handleTranscript(ev) {
      if (this._state !== "active") return;

      if (ev.type === "speech_ended") {
        this.dispatchEvent(new Event("speechend"));
        this.dispatchEvent(new Event("soundend"));
        return;
      }

      if (!this._speechDetected && ev.text) {
        this._speechDetected = true;
        this.dispatchEvent(new Event("soundstart"));
        this.dispatchEvent(new Event("speechstart"));
      }

      var isFinal = ev.type === "final";

      if (!isFinal && !this.interimResults) return;

      if (isFinal) {
        var lastIdx = this._results.length - 1;
        if (lastIdx >= 0 && !this._results[lastIdx].isFinal) {
          this._results[lastIdx] = new SpeechRecognitionResult(ev.text, true);
        } else {
          this._results.push(new SpeechRecognitionResult(ev.text, true));
        }
      } else {
        var li = this._results.length - 1;
        if (li >= 0 && !this._results[li].isFinal) {
          this._results[li] = new SpeechRecognitionResult(ev.text, false);
        } else {
          this._results.push(new SpeechRecognitionResult(ev.text, false));
        }
      }

      var resultIndex = isFinal
        ? this._results.length - 1
        : Math.max(0, this._results.length - 1);
      var resultList = new SpeechRecognitionResultList(this._results);
      this.dispatchEvent(SpeechRecognitionEvent("result", resultIndex, resultList));

      if (isFinal && !this.continuous) {
        this.stop();
      }
    }

    _fireError(code, message) {
      this.dispatchEvent(SpeechRecognitionErrorEvent(code, message));
    }

    _cleanupAudio() {
      if (this._capture) { this._capture.cleanup(); this._capture = null; }
    }

    _teardown() {
      if (this._adapter) { this._adapter.close(); this._adapter = null; }
      this._cleanupAudio();
      this._state = "inactive";
    }
  }

  // on* event handler properties
  EVENT_NAMES.forEach(function (name) {
    Object.defineProperty(SuperagentSpeechRecognition.prototype, "on" + name, {
      get: function () { return this._handlers[name] || null; },
      set: function (fn) {
        if (this._handlers[name]) this.removeEventListener(name, this._handlers[name]);
        this._handlers[name] = fn;
        if (fn) this.addEventListener(name, fn);
      },
    });
  });

  // -- Register globally ------------------------------------------------------

  window.SpeechRecognition = SuperagentSpeechRecognition;
  window.webkitSpeechRecognition = SuperagentSpeechRecognition;
})();
`
