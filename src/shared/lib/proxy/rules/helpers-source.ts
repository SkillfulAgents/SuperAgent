/**
 * Format-level helpers available to proxy rules as their second argument.
 *
 * This is JavaScript SOURCE, compiled inside each rule's sandbox context, so
 * the rule never holds a reference to a host-realm function (whose
 * `constructor` would hand it the host's `Function`, and with it `process`).
 * Keep it plain ES2020 with no imports: bundlers must not rewrite it.
 *
 * Only generic formats live here (base64, RFC 5322 headers and addresses,
 * numbers) — never a vendor's request shape. Every parser fails closed: it
 * returns null on anything it does not fully understand, and rules are told to
 * treat null as "not allowed".
 */
export const RULE_HELPERS_SOURCE = String.raw`
(function () {
  'use strict'

  // Character code → 6-bit value for base64 and base64url; -1 elsewhere.
  var B64 = (function () {
    var table = new Int16Array(128).fill(-1)
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    for (var i = 0; i < 64; i++) table[alphabet.charCodeAt(i)] = i
    table[45] = 62 // '-'
    table[95] = 63 // '_'
    return table
  })()

  function base64ToBinary(input) {
    if (typeof input !== 'string') return null
    var s = /\s/.test(input) ? input.replace(/\s/g, '') : input
    var n = s.length
    while (n > 0 && s.charCodeAt(n - 1) === 61) n-- // trailing '='
    if (n % 4 === 1) return null
    var bytes = new Uint8Array((n * 3) >> 2)
    var o = 0
    var buffer = 0
    var bits = 0
    for (var i = 0; i < n; i++) {
      var c = s.charCodeAt(i)
      var v = c < 128 ? B64[c] : -1
      if (v < 0) return null
      buffer = (buffer << 6) | v
      bits += 6
      if (bits >= 8) {
        bits -= 8
        bytes[o++] = (buffer >> bits) & 0xff
      }
    }
    var parts = []
    for (var j = 0; j < o; j += 8192) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(j, Math.min(o, j + 8192))))
    }
    return parts.join('')
  }

  function binaryToUtf8(binary) {
    try {
      return decodeURIComponent(escape(binary))
    } catch (e) {
      return binary
    }
  }

  /** Decode base64 or base64url text into a UTF-8 string, or null. */
  function decodeBase64(input) {
    var binary = base64ToBinary(input)
    return binary === null ? null : binaryToUtf8(binary)
  }

  /**
   * Split an RFC 5322 / MIME message into headers and body.
   * Returns { headers: [{name, value}], body, header(name), headerAll(name) }
   * or null when the header block is malformed.
   */
  function parseMessage(raw) {
    if (typeof raw !== 'string') return null
    var split = /\r?\n\r?\n/.exec(raw)
    var headerBlock = split ? raw.slice(0, split.index) : raw
    var body = split ? raw.slice(split.index + split[0].length) : ''
    var lines = headerBlock.split(/\r?\n/)
    var headers = []
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (line === '') continue
      if (/^[ \t]/.test(line)) {
        if (headers.length === 0) return null
        headers[headers.length - 1].value += ' ' + line.replace(/^[ \t]+/, '')
        continue
      }
      var colon = line.indexOf(':')
      if (colon <= 0) return null
      var name = line.slice(0, colon).replace(/[ \t]+$/, '')
      if (!/^[!-9;-~]+$/.test(name)) return null
      headers.push({ name: name.toLowerCase(), value: line.slice(colon + 1).replace(/^[ \t]+/, '') })
    }
    function headerAll(wanted) {
      var key = String(wanted).toLowerCase()
      var values = []
      for (var j = 0; j < headers.length; j++) if (headers[j].name === key) values.push(headers[j].value)
      return values
    }
    return {
      headers: headers,
      body: body,
      headerAll: headerAll,
      header: function (wanted) {
        var values = headerAll(wanted)
        return values.length ? values[0] : null
      },
    }
  }

  // ---------------------------------------------------------------------
  // RFC 5322 address lists (conservative subset; null on anything else)
  // ---------------------------------------------------------------------

  var SPECIALS = '<>,:;@.[]'

  function tokenize(input) {
    var tokens = []
    var i = 0
    while (i < input.length) {
      var c = input.charAt(i)
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue }
      if (c === '(') {
        var depth = 0
        while (i < input.length) {
          var d = input.charAt(i)
          if (d === '\\') { i += 2; continue }
          if (d === '(') depth++
          if (d === ')') { depth--; if (depth === 0) { i++; break } }
          i++
        }
        if (depth !== 0) return null
        continue
      }
      if (c === ')') return null
      if (c === '"') {
        var value = ''
        i++
        var closed = false
        while (i < input.length) {
          var q = input.charAt(i)
          if (q === '\\') { value += input.charAt(i + 1); i += 2; continue }
          if (q === '"') { closed = true; i++; break }
          value += q
          i++
        }
        if (!closed) return null
        tokens.push({ type: 'quoted', value: value })
        continue
      }
      if (c === '[' || c === ']') return null
      if (SPECIALS.indexOf(c) !== -1) { tokens.push({ type: c }); i++; continue }
      var start = i
      while (i < input.length) {
        var a = input.charAt(i)
        if (' \t\r\n()"'.indexOf(a) !== -1 || SPECIALS.indexOf(a) !== -1 || a === '\\') break
        i++
      }
      if (i === start) return null
      tokens.push({ type: 'atom', value: input.slice(start, i) })
    }
    return tokens
  }

  var LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_\x60{|}~-]+$/
  var DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

  function parseAddrSpec(tokens, start, end) {
    // local-part: word ("." word)* ; "@" ; domain: label ("." label)+
    var at = -1
    for (var k = start; k < end; k++) {
      if (tokens[k].type === '@') { if (at !== -1) return null; at = k }
    }
    if (at <= start || at >= end - 1) return null
    var local = ''
    var expectWord = true
    for (var l = start; l < at; l++) {
      var t = tokens[l]
      if (expectWord) {
        if (t.type === 'atom' && LOCAL_ATOM.test(t.value)) local += t.value
        else if (t.type === 'quoted') local += '"' + t.value.replace(/(["\\])/g, '\\$1') + '"'
        else return null
      } else if (t.type === '.') {
        local += '.'
      } else {
        return null
      }
      expectWord = !expectWord
    }
    if (expectWord) return null
    var labels = []
    expectWord = true
    for (var m = at + 1; m < end; m++) {
      var u = tokens[m]
      if (expectWord) {
        if (u.type !== 'atom') return null
        // An atom may itself carry dots only via separate '.' tokens.
        if (!DOMAIN_LABEL.test(u.value)) return null
        labels.push(u.value.toLowerCase())
      } else if (u.type !== '.') {
        return null
      }
      expectWord = !expectWord
    }
    if (expectWord || labels.length < 2) return null
    var domain = labels.join('.')
    return { local: local, domain: domain, address: local + '@' + domain }
  }

  function phraseText(tokens, start, end) {
    var words = []
    for (var p = start; p < end; p++) {
      var t = tokens[p]
      if (t.type === 'atom' || t.type === 'quoted') words.push(t.value)
      else if (t.type === '.') words.push('.')
      else return null
    }
    return words.join(' ')
  }

  /** Parse one mailbox between [start, end). */
  function parseMailbox(tokens, start, end) {
    if (start >= end) return null
    var open = -1
    for (var k = start; k < end; k++) if (tokens[k].type === '<') { open = k; break }
    if (open === -1) {
      var bare = parseAddrSpec(tokens, start, end)
      return bare ? { name: '', address: bare.address, local: bare.local, domain: bare.domain } : null
    }
    if (tokens[end - 1].type !== '>') return null
    for (var n = open + 1; n < end - 1; n++) if (tokens[n].type === '<' || tokens[n].type === '>') return null
    var name = phraseText(tokens, start, open)
    if (name === null) return null
    var spec = parseAddrSpec(tokens, open + 1, end - 1)
    return spec ? { name: name, address: spec.address, local: spec.local, domain: spec.domain } : null
  }

  /**
   * Parse an address-list header value (To/Cc/Bcc/From/Reply-To).
   * Returns [{ name, address, local, domain, group }] with groups flattened,
   * [] for an empty value, or null when any part is not understood.
   */
  function parseAddressList(input) {
    if (input === undefined || input === null) return []
    if (typeof input !== 'string') return null
    var tokens = tokenize(input)
    if (tokens === null) return null
    var out = []
    var i = 0
    while (i < tokens.length) {
      if (tokens[i].type === ',') { i++; continue }
      // A group is a phrase followed by ':' before any of < > @ , ;
      var j = i
      while (j < tokens.length && (tokens[j].type === 'atom' || tokens[j].type === 'quoted' || tokens[j].type === '.')) j++
      if (j < tokens.length && j > i && tokens[j].type === ':') {
        var groupName = phraseText(tokens, i, j)
        var g = j + 1
        var closedGroup = false
        while (g < tokens.length) {
          if (tokens[g].type === ';') { closedGroup = true; g++; break }
          if (tokens[g].type === ',') { g++; continue }
          var memberEnd = g
          var inAngle = false
          while (memberEnd < tokens.length) {
            var mt = tokens[memberEnd].type
            if (mt === '<') inAngle = true
            if (mt === '>') inAngle = false
            if (!inAngle && (mt === ',' || mt === ';')) break
            memberEnd++
          }
          var member = parseMailbox(tokens, g, memberEnd)
          if (!member) return null
          member.group = groupName
          out.push(member)
          g = memberEnd
        }
        if (!closedGroup) return null
        i = g
        continue
      }
      var end = i
      var angle = false
      while (end < tokens.length) {
        var tt = tokens[end].type
        if (tt === '<') angle = true
        if (tt === '>') angle = false
        if (!angle && (tt === ',' || tt === ';' || tt === ':')) break
        end++
      }
      if (end < tokens.length && tokens[end].type !== ',') return null
      var mailbox = parseMailbox(tokens, i, end)
      if (!mailbox) return null
      mailbox.group = null
      out.push(mailbox)
      i = end
    }
    return out
  }

  /** Lowercased domain of an address string, or null. */
  function domainOf(address) {
    var parsed = parseAddressList(address)
    return parsed && parsed.length === 1 ? parsed[0].domain : null
  }

  /**
   * True when domain equals base, or (with { subdomains: true }) ends in
   * "." + base. Both are compared lowercased; "evilacme.com" never matches
   * "acme.com".
   */
  function domainMatches(domain, base, options) {
    if (typeof domain !== 'string' || typeof base !== 'string') return false
    var d = domain.toLowerCase()
    var b = base.toLowerCase().replace(/^\.+/, '')
    if (d === b) return true
    return !!(options && options.subdomains) && d.length > b.length && d.slice(-(b.length + 1)) === '.' + b
  }

  /**
   * Every recipient address of an RFC 5322 message: To, Cc, Bcc and their
   * Resent-* variants. Accepts the raw message text or parseMessage() output.
   * Returns null when the message or any address header can't be parsed.
   */
  function recipients(message) {
    var parsed = typeof message === 'string' ? parseMessage(message) : message
    if (!parsed || typeof parsed.headerAll !== 'function') return null
    var names = ['to', 'cc', 'bcc', 'resent-to', 'resent-cc', 'resent-bcc']
    var all = []
    for (var i = 0; i < names.length; i++) {
      var values = parsed.headerAll(names[i])
      for (var j = 0; j < values.length; j++) {
        var list = parseAddressList(values[j])
        if (list === null) return null
        for (var k = 0; k < list.length; k++) all.push(list[k])
      }
    }
    return all
  }

  /**
   * A finite number from a JSON number or a plain decimal string
   * ("5000", "-12.50"); null for anything else (NaN, "1e4", "", objects).
   */
  function toNumber(value) {
    if (typeof value === 'number') return isFinite(value) ? value : null
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim())
    return null
  }

  return Object.freeze({
    decodeBase64: decodeBase64,
    parseMessage: parseMessage,
    parseAddressList: parseAddressList,
    recipients: recipients,
    domainOf: domainOf,
    domainMatches: domainMatches,
    toNumber: toNumber,
  })
})()
`

/** Documentation for the authoring prompt; keep in sync with the source. */
export const RULE_HELPERS_DOC = `h.decodeBase64(s) → UTF-8 string from base64 or base64url, or null.
h.parseMessage(raw) → { headers:[{name,value}], body, header(name), headerAll(name) } for an RFC 5322/MIME message, or null when malformed. Header names are lowercased.
h.parseAddressList(value) → [{ name, address, local, domain, group }] for an address-list header value (groups flattened), [] when empty/undefined, or null when any part can't be parsed. Domains are lowercased.
h.recipients(rawOrParsed) → every To/Cc/Bcc/Resent-* address of an RFC 5322 message (same shape as parseAddressList), or null when any header can't be parsed.
h.domainOf(address) → lowercased domain of a single address, or null.
h.domainMatches(domain, base, { subdomains }) → exact (case-insensitive) domain match; subdomains only when { subdomains: true }. "evilacme.com" never matches "acme.com".
h.toNumber(v) → finite number from a JSON number or plain decimal string ("5000", "-12.50"); null otherwise (NaN, "1e4", "", objects).`
