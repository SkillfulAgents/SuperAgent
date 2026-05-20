let cached: string | null = null

export function getLlmPolyfillJs(): string {
  if (cached) return cached
  cached = LLM_SHIM_SOURCE
  return cached
}

// ---------------------------------------------------------------------------
// Tiny shim inlined into dashboard HTML.
// Defines window.Anthropic as a lazy-loading wrapper. On first use it loads
// the full bundled Anthropic SDK from /api/llm/anthropic-sdk.js, configures
// it to route through our proxy endpoint at /api/llm/messages, and delegates.
// ---------------------------------------------------------------------------

const LLM_SHIM_SOURCE = /* js */ `(function () {
  "use strict";

  var _sdkReady = null;

  function ensureSdk() {
    if (_sdkReady) return _sdkReady;
    _sdkReady = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      // Absolute path — iframe serves from a subpath so relative URLs won't resolve correctly
      script.src = "/api/llm/anthropic-sdk.js";
      script.onload = function () {
        if (window.__AnthropicSDK) resolve(window.__AnthropicSDK);
        else { _sdkReady = null; reject(new Error("Anthropic SDK failed to initialize")); }
      };
      script.onerror = function () { _sdkReady = null; reject(new Error("Failed to load Anthropic SDK")); };
      document.head.appendChild(script);
    });
    return _sdkReady;
  }

  class LazyMessageStream {
    constructor(clientRef, params) {
      this._pending = [];
      this._real = null;
      this._error = null;
      this._init(clientRef, params);
    }

    _init(clientRef, params) {
      clientRef._getReal().then((real) => {
        this._real = real.messages.stream(params);
        for (var i = 0; i < this._pending.length; i++) {
          var p = this._pending[i];
          this._real.on(p[0], p[1]);
        }
        this._pending = [];
      }).catch((err) => {
        this._error = err;
        var list = this._pending.filter(function (p) { return p[0] === "error"; });
        for (var i = 0; i < list.length; i++) { try { list[i][1](err); } catch (_) {} }
        this._pending = [];
      });
    }

    on(event, cb) {
      if (this._real) this._real.on(event, cb);
      else this._pending.push([event, cb]);
      return this;
    }

    off(event, cb) {
      if (this._real) this._real.off(event, cb);
      else this._pending = this._pending.filter(function (p) { return p[0] !== event || p[1] !== cb; });
      return this;
    }

    abort() { if (this._real) this._real.abort(); }

    finalMessage() {
      if (this._real) return this._real.finalMessage();
      if (this._error) return Promise.reject(this._error);
      var self = this;
      return new Promise(function (resolve, reject) {
        (function wait() {
          if (self._real) return self._real.finalMessage().then(resolve, reject);
          if (self._error) return reject(self._error);
          setTimeout(wait, 5);
        })();
      });
    }

    finalText() {
      if (this._real) return this._real.finalText();
      if (this._error) return Promise.reject(this._error);
      var self = this;
      return new Promise(function (resolve, reject) {
        (function wait() {
          if (self._real) return self._real.finalText().then(resolve, reject);
          if (self._error) return reject(self._error);
          setTimeout(wait, 5);
        })();
      });
    }
  }

  class Messages {
    constructor(clientRef) { this._ref = clientRef; }

    create(params) {
      return this._ref._getReal().then(function (real) {
        return real.messages.create(params);
      });
    }

    stream(params) {
      if (this._ref._real) return this._ref._real.messages.stream(params);
      return new LazyMessageStream(this._ref, params);
    }
  }

  class Anthropic {
    constructor(opts) {
      opts = opts || {};
      this._userOpts = opts;
      this._real = null;
      this._realPromise = null;
      this.messages = new Messages(this);
    }

    _getReal() {
      if (this._real) return Promise.resolve(this._real);
      if (this._realPromise) return this._realPromise;
      var self = this;
      this._realPromise = ensureSdk().then(function (SDK) {
        var config = Object.assign({}, self._userOpts, {
          baseURL: window.location.origin + "/api/llm",
          apiKey: "placeholder",
          dangerouslyAllowBrowser: true,
        });
        self._real = new SDK(config);
        return self._real;
      });
      return this._realPromise;
    }
  }

  window.Anthropic = Anthropic;
})();
`
