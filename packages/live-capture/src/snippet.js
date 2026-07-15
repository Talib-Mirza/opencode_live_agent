// OpenCode live-capture browser snippet.
//
// Served verbatim by the OpenCode server (via Bun text import), with the
// server prepending an assignment like:
//   globalThis.__OPENCODE_LIVE__ = { server: "http://...", ticket: "...", directory: "..." }
// before this file's contents. This file is plain JavaScript on purpose (no
// build step, no imports) so it can be injected byte-for-byte into a page
// under development. Every capture path is guarded with try/catch: a bug in
// here must never break the host page.
//
// Event shapes mirror packages/schema/src/live.ts (Telemetry union) and the
// IngestBatch envelope: {"source":"injected","events":[...]}.
;(function () {
  var config = globalThis.__OPENCODE_LIVE__
  if (!config || !config.server || !config.ticket) return

  var MAX_MESSAGE = 2000
  var MAX_STACK = 4000
  var DEDUPE_WINDOW_MS = 1000
  var FLUSH_INTERVAL_MS = 300
  var FLUSH_MAX_BATCH = 20
  var MAX_DROPPED_BUFFER = 50
  var RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000]

  var serverOrigin = originOf(config.server)
  var wsUrl = config.server.replace(/^http/, "ws") + "/live/connect?ticket=" + encodeURIComponent(config.ticket)
  // One id per page load so the server can tell concurrent browser tabs apart.
  var tabId = Math.random().toString(36).slice(2, 8)

  function originOf(url) {
    try {
      return new URL(url, location.href).origin
    } catch (err) {
      return ""
    }
  }

  function truncate(value, max) {
    if (typeof value !== "string") return value
    if (value.length <= max) return value
    return value.slice(0, max)
  }

  function nowUrl() {
    try {
      return location.href
    } catch (err) {
      return ""
    }
  }

  // --- buffering + flush -----------------------------------------------

  var buffer = []
  var socket = null
  var connected = false
  var reconnectAttempt = 0
  var flushTimer = null
  var recentDedupe = Object.create(null)

  function dedupeKey(event) {
    if (event.kind !== "console" && event.kind !== "error") return null
    var stack = event.stack || ""
    var message = event.message || ""
    return event.kind + "|" + message + "|" + stack
  }

  function shouldDedupe(event) {
    var key = dedupeKey(event)
    if (!key) return false
    var last = recentDedupe[key]
    var now = event.ts
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return true
    recentDedupe[key] = now
    return false
  }

  function enqueue(event) {
    try {
      event.tab = tabId
      if (event.message !== undefined) event.message = truncate(event.message, MAX_MESSAGE)
      if (event.stack !== undefined) event.stack = truncate(event.stack, MAX_STACK)
      if (shouldDedupe(event)) return
      buffer.push(event)
      if (!connected && buffer.length > MAX_DROPPED_BUFFER) {
        buffer.splice(0, buffer.length - MAX_DROPPED_BUFFER)
      }
      if (buffer.length >= FLUSH_MAX_BATCH) flush()
    } catch (err) {
      // capture must never throw into the host page
    }
  }

  function flush() {
    try {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (!connected || buffer.length === 0) return
      var events = buffer
      buffer = []
      socket.send(JSON.stringify({ source: "injected", events: events }))
    } catch (err) {
      // drop this batch rather than throw
    }
  }

  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS)
  }

  // --- websocket transport ------------------------------------------------

  function connect() {
    try {
      socket = new WebSocket(wsUrl)
    } catch (err) {
      scheduleReconnect()
      return
    }

    socket.addEventListener("open", function () {
      connected = true
      reconnectAttempt = 0
      // Announce this tab so the server can route per-tab browser_read requests to this socket.
      try {
        socket.send(JSON.stringify({ type: "hello", tab: tabId }))
      } catch (err) {
        // ignore
      }
      scheduleFlush()
    })

    // Server -> browser control frames. Today only browser_read (a "snapshot" request): run the
    // shared extractor and reply with the result, correlated by id. Guarded so a malformed frame or
    // an extractor bug can never break the host page or the telemetry stream.
    socket.addEventListener("message", function (event) {
      try {
        var frame = JSON.parse(String(event.data))
        if (!frame || frame.type !== "snapshot") return
        var extractor = globalThis.__OPENCODE_LIVE_SNAPSHOT__
        var result =
          typeof extractor === "function"
            ? extractor(frame.request || {})
            : { found: false, url: nowUrl(), mode: "text", truncated: false, length: 0 }
        socket.send(JSON.stringify({ type: "snapshot_result", id: frame.id, result: result }))
      } catch (err) {
        // ignore
      }
    })

    socket.addEventListener("close", function () {
      connected = false
      scheduleReconnect()
    })

    socket.addEventListener("error", function () {
      try {
        socket.close()
      } catch (err) {
        // ignore
      }
    })
  }

  // Re-mint a capture ticket by re-fetching inject.js. The server holds tickets in memory, so a
  // restart invalidates the one embedded at page load and every reconnect with it is refused;
  // inject.js hands out a fresh ticket once the server has rehydrated this directory's live session.
  // Cross-origin read needs CORS to succeed — if it doesn't, we fall through and retry the old
  // ticket (no worse than before), and a page reload still recovers.
  function refreshTicket() {
    try {
      var url = config.server + "/live/inject.js?directory=" + encodeURIComponent(config.directory)
      return fetch(url, { cache: "no-store" })
        .then(function (res) {
          return res.ok ? res.text() : ""
        })
        .then(function (body) {
          var match = body.match(/__OPENCODE_LIVE__\s*=\s*(\{[\s\S]*?\});/)
          if (!match) return
          var next = JSON.parse(match[1])
          if (!next || !next.ticket) return
          config.ticket = next.ticket
          wsUrl = config.server.replace(/^http/, "ws") + "/live/connect?ticket=" + encodeURIComponent(next.ticket)
        })
        .catch(function () {})
    } catch (err) {
      return Promise.resolve()
    }
  }

  function scheduleReconnect() {
    var delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    reconnectAttempt++
    // First retry reuses the embedded ticket (likely just a transient drop, and it stays valid for
    // its TTL); once retries persist, assume the server restarted and re-mint before reconnecting.
    if (reconnectAttempt > 1) {
      setTimeout(function () {
        refreshTicket().then(connect)
      }, delay)
      return
    }
    setTimeout(connect, delay)
  }

  connect()
  setInterval(scheduleFlush, FLUSH_INTERVAL_MS)

  // --- error capture -------------------------------------------------------

  try {
    window.addEventListener("error", function (event) {
      try {
        var error = event.error
        enqueue({
          kind: "error",
          ts: Date.now(),
          url: nowUrl(),
          message: String((error && error.message) || event.message || "Unknown error"),
          stack: error && error.stack ? String(error.stack) : undefined,
          origin: "uncaught",
        })
      } catch (err) {
        // ignore
      }
    })

    window.addEventListener("unhandledrejection", function (event) {
      try {
        var reason = event.reason
        var isError = reason instanceof Error
        enqueue({
          kind: "error",
          ts: Date.now(),
          url: nowUrl(),
          message: String(isError ? reason.message : reason),
          stack: isError && reason.stack ? String(reason.stack) : undefined,
          origin: "unhandledrejection",
        })
      } catch (err) {
        // ignore
      }
    })
  } catch (err) {
    // ignore
  }

  // --- console capture -------------------------------------------------------

  try {
    ;["error", "warn"].forEach(function (level) {
      var original = console[level]
      if (typeof original !== "function") return
      console[level] = function () {
        try {
          original.apply(console, arguments)
        } catch (err) {
          // ignore
        }
        try {
          var args = Array.prototype.slice.call(arguments)
          var message = args
            .map(function (arg) {
              if (typeof arg === "string") return arg
              try {
                return JSON.stringify(arg)
              } catch (err) {
                return String(arg)
              }
            })
            .join(" ")
          var stack
          try {
            stack = new Error().stack
          } catch (err) {
            stack = undefined
          }
          enqueue({
            kind: "console",
            ts: Date.now(),
            url: nowUrl(),
            level: level,
            message: message,
            stack: stack,
          })
        } catch (err) {
          // ignore
        }
      }
    })
  } catch (err) {
    // ignore
  }

  // --- network capture -------------------------------------------------------

  try {
    var originalFetch = window.fetch
    if (typeof originalFetch === "function") {
      window.fetch = function (input, init) {
        var method = (init && init.method) || (input && input.method) || "GET"
        var requestUrl = typeof input === "string" ? input : input && input.url ? input.url : String(input)
        var start = Date.now()

        if (isOwnServerUrl(requestUrl)) return originalFetch.apply(window, arguments)

        return originalFetch.apply(window, arguments).then(
          function (response) {
            try {
              if (response.status >= 400) {
                enqueue({
                  kind: "network",
                  ts: Date.now(),
                  url: nowUrl(),
                  method: String(method).toUpperCase(),
                  requestUrl: String(requestUrl),
                  status: response.status,
                  durationMs: Date.now() - start,
                })
              }
            } catch (err) {
              // ignore
            }
            return response
          },
          function (error) {
            try {
              enqueue({
                kind: "network",
                ts: Date.now(),
                url: nowUrl(),
                method: String(method).toUpperCase(),
                requestUrl: String(requestUrl),
                status: 0,
                durationMs: Date.now() - start,
              })
            } catch (err) {
              // ignore
            }
            throw error
          },
        )
      }
    }
  } catch (err) {
    // ignore
  }

  try {
    var OriginalXHR = window.XMLHttpRequest
    if (typeof OriginalXHR === "function") {
      window.XMLHttpRequest = function () {
        var xhr = new OriginalXHR()
        var method = "GET"
        var requestUrl = ""
        var start = 0
        var skip = false

        var originalOpen = xhr.open
        xhr.open = function (m, u) {
          method = m || "GET"
          requestUrl = u || ""
          skip = isOwnServerUrl(requestUrl)
          return originalOpen.apply(xhr, arguments)
        }

        var originalSend = xhr.send
        xhr.send = function () {
          start = Date.now()
          if (!skip) {
            xhr.addEventListener("loadend", function () {
              try {
                var status = xhr.status
                if (status >= 400 || status === 0) {
                  enqueue({
                    kind: "network",
                    ts: Date.now(),
                    url: nowUrl(),
                    method: String(method).toUpperCase(),
                    requestUrl: String(requestUrl),
                    status: status,
                    durationMs: Date.now() - start,
                  })
                }
              } catch (err) {
                // ignore
              }
            })
          }
          return originalSend.apply(xhr, arguments)
        }

        return xhr
      }
    }
  } catch (err) {
    // ignore
  }

  function isOwnServerUrl(url) {
    try {
      return originOf(String(url)) === serverOrigin
    } catch (err) {
      return false
    }
  }

  // --- navigation capture -------------------------------------------------------

  try {
    var lastUrl = nowUrl()

    function emitNavigation() {
      try {
        var current = nowUrl()
        if (current === lastUrl) return
        enqueue({ kind: "navigation", ts: Date.now(), url: current, from: lastUrl })
        lastUrl = current
      } catch (err) {
        // ignore
      }
    }

    var originalPushState = history.pushState
    history.pushState = function () {
      var result = originalPushState.apply(history, arguments)
      emitNavigation()
      return result
    }

    var originalReplaceState = history.replaceState
    history.replaceState = function () {
      var result = originalReplaceState.apply(history, arguments)
      emitNavigation()
      return result
    }

    window.addEventListener("popstate", emitNavigation)
    window.addEventListener("hashchange", emitNavigation)

    enqueue({ kind: "navigation", ts: Date.now(), url: lastUrl, from: undefined })
  } catch (err) {
    // ignore
  }

  // --- click capture -------------------------------------------------------

  try {
    document.addEventListener(
      "click",
      function (event) {
        try {
          var target = event.target
          if (!(target instanceof Element)) return
          enqueue({
            kind: "click",
            ts: Date.now(),
            url: nowUrl(),
            selector: cssPath(target),
            text: innerTextSnippet(target),
          })
        } catch (err) {
          // ignore
        }
      },
      true,
    )
  } catch (err) {
    // ignore
  }

  // --- form field capture ------------------------------------------------------
  //
  // Records field fill-state (and, for non-sensitive fields, values) on commit and on submit, so
  // the agent can tell a filled form from an empty one. Secrets are redacted by default: password
  // inputs, sensitive autocomplete tokens, and sensitive-looking names/labels never transmit their
  // value — only { filled, length, redacted:true }. Setting __OPENCODE_LIVE__.fields = "none"
  // redacts every field's value and streams fill-state only.

  var MAX_VALUE = 200
  var MAX_FORM_FIELDS = 60
  var FIELD_MODE = config.fields === "none" ? "none" : "nonsensitive"
  var SENSITIVE_NAME = /pass|secret|token|otp|(^|[^a-z])code|cvv|cvc|card|ccnum|ssn|routing|account|\bpin\b|auth/i
  var SENSITIVE_AUTOCOMPLETE = {
    "current-password": true,
    "new-password": true,
    "one-time-code": true,
    "cc-number": true,
    "cc-csc": true,
    "cc-exp": true,
    "cc-exp-month": true,
    "cc-exp-year": true,
  }

  function isCapturableField(element) {
    if (!(element instanceof Element)) return false
    var tag = element.tagName
    if (tag === "TEXTAREA" || tag === "SELECT") return true
    if (tag !== "INPUT") return false
    var type = String(element.type || "text").toLowerCase()
    return (
      type !== "hidden" &&
      type !== "password-toggle" &&
      type !== "button" &&
      type !== "submit" &&
      type !== "reset" &&
      type !== "image" &&
      type !== "file"
    )
  }

  function labelFor(element) {
    try {
      var aria = element.getAttribute && element.getAttribute("aria-label")
      if (aria) return aria.trim()
      if (element.labels && element.labels.length > 0) {
        var text = element.labels[0].innerText || element.labels[0].textContent || ""
        if (text.trim()) return text.trim()
      }
      var placeholder = element.getAttribute && element.getAttribute("placeholder")
      if (placeholder) return placeholder.trim()
    } catch (err) {
      // ignore
    }
    return undefined
  }

  function fieldValue(element) {
    var type = String(element.type || "").toLowerCase()
    if (type === "checkbox" || type === "radio") return element.checked ? "on" : ""
    return String(element.value == null ? "" : element.value)
  }

  function isSensitiveField(element, name, label) {
    var type = String(element.type || "").toLowerCase()
    if (type === "password") return true
    var autocomplete = String((element.getAttribute && element.getAttribute("autocomplete")) || "").toLowerCase()
    if (SENSITIVE_AUTOCOMPLETE[autocomplete]) return true
    var haystack = [name || "", element.id || "", label || "", autocomplete].join(" ")
    return SENSITIVE_NAME.test(haystack)
  }

  function describeField(element) {
    var name = element.getAttribute && element.getAttribute("name") ? element.getAttribute("name") : undefined
    var label = labelFor(element)
    var value = fieldValue(element)
    var redacted = FIELD_MODE === "none" || isSensitiveField(element, name, label)
    var state = {
      selector: cssPath(element),
      name: name || undefined,
      id: element.id || undefined,
      fieldType:
        element.tagName === "INPUT" ? String(element.type || "text").toLowerCase() : element.tagName.toLowerCase(),
      label: label,
      filled: value.length > 0,
      length: value.length,
      redacted: redacted,
    }
    if (!redacted) state.value = truncate(value, MAX_VALUE)
    return state
  }

  try {
    document.addEventListener(
      "change",
      function (event) {
        try {
          if (!isCapturableField(event.target)) return
          enqueue({
            kind: "input",
            ts: Date.now(),
            url: nowUrl(),
            trigger: "change",
            fields: [describeField(event.target)],
          })
        } catch (err) {
          // ignore
        }
      },
      true,
    )

    document.addEventListener(
      "submit",
      function (event) {
        try {
          var form = event.target
          if (!(form instanceof Element)) return
          var elements = form.elements ? Array.prototype.slice.call(form.elements) : []
          var fields = elements.filter(isCapturableField).slice(0, MAX_FORM_FIELDS).map(describeField)
          if (fields.length === 0) return
          enqueue({
            kind: "input",
            ts: Date.now(),
            url: nowUrl(),
            trigger: "submit",
            fields: fields,
          })
        } catch (err) {
          // ignore
        }
      },
      true,
    )
  } catch (err) {
    // ignore
  }

  function cssPath(element) {
    var parts = []
    var node = element
    var depth = 0
    while (node && node.nodeType === 1 && depth < 3) {
      var part = node.tagName.toLowerCase()
      if (node.id) {
        part += "#" + node.id
        parts.unshift(part)
        break
      }
      if (node.classList && node.classList.length > 0) {
        part += "." + Array.prototype.slice.call(node.classList).join(".")
      }
      parts.unshift(part)
      node = node.parentElement
      depth++
    }
    return parts.join(" > ")
  }

  function innerTextSnippet(element) {
    var text = element.innerText || element.textContent || ""
    text = text.trim()
    if (!text) return undefined
    return text.length > 40 ? text.slice(0, 40) : text
  }
})()
