// OpenCode live-capture on-demand page snapshot.
//
// Defines a single extraction function, __OPENCODE_LIVE_SNAPSHOT__, that reads the current page's
// content on request. It is shared byte-for-byte by both capture backends:
//   - the injected snippet (snippet.js) calls it in-page when the server sends a snapshot frame;
//   - the CDP backend ships this same source to the page via Runtime.evaluate.
// Running the identical function in both paths keeps behavior in lockstep, so there is one thing to
// test. Like snippet.js this is plain JavaScript (no imports, no build step) and every branch is
// guarded so a bug here can never throw into the host page.
//
// Shapes mirror packages/schema/src/live.ts (SnapshotRequest / SnapshotResult).
;(function () {
  var DEFAULT_MAX_CHARS = 20000
  var DEFAULT_MAX_NODES = 500

  function truncate(value, max, result) {
    if (typeof value !== "string") return value
    if (value.length <= max) return value
    result.truncated = true
    return value.slice(0, max)
  }

  function currentUrl() {
    try {
      return location.href
    } catch (err) {
      return ""
    }
  }

  function currentTitle() {
    try {
      return document.title || undefined
    } catch (err) {
      return undefined
    }
  }

  // --- accessibility extraction ------------------------------------------------
  //
  // A bounded walk producing { role, name, state } for interactive/landmark elements, approximating
  // how assistive tech reads the page. Deliberately shallow and capped; this is not a full ARIA
  // implementation, just enough for the agent to understand page structure and controls.

  var IMPLICIT_ROLE = {
    A: "link",
    BUTTON: "button",
    NAV: "navigation",
    MAIN: "main",
    HEADER: "banner",
    FOOTER: "contentinfo",
    ASIDE: "complementary",
    FORM: "form",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    IMG: "img",
    UL: "list",
    OL: "list",
    LI: "listitem",
    TABLE: "table",
    SELECT: "combobox",
    TEXTAREA: "textbox",
    LABEL: "label",
    NADA: undefined,
  }
  var INPUT_ROLE = {
    checkbox: "checkbox",
    radio: "radio",
    button: "button",
    submit: "button",
    reset: "button",
    range: "slider",
    search: "searchbox",
  }

  function roleOf(element) {
    var explicit = element.getAttribute && element.getAttribute("role")
    if (explicit) return explicit.trim().split(/\s+/)[0]
    var tag = element.tagName
    if (tag === "INPUT") {
      var type = String(element.type || "text").toLowerCase()
      return INPUT_ROLE[type] || "textbox"
    }
    return IMPLICIT_ROLE[tag]
  }

  // Landmark/structural roles take a name only from an explicit label, never from their subtree
  // text — deriving it from contents (a whole <main>/<form>) is both wrong per ARIA and noise.
  var NO_CONTENT_NAME = {
    main: true,
    navigation: true,
    banner: true,
    contentinfo: true,
    complementary: true,
    form: true,
    list: true,
    listitem: true,
    table: true,
    region: true,
  }

  function accessibleName(element, role) {
    try {
      var aria = element.getAttribute && element.getAttribute("aria-label")
      if (aria && aria.trim()) return aria.trim()
      var labelledby = element.getAttribute && element.getAttribute("aria-labelledby")
      if (labelledby) {
        var parts = labelledby
          .split(/\s+/)
          .map(function (id) {
            var ref = document.getElementById(id)
            return ref ? (ref.innerText || ref.textContent || "").trim() : ""
          })
          .filter(Boolean)
        if (parts.length) return parts.join(" ")
      }
      if (element.labels && element.labels.length > 0) {
        var labelText = element.labels[0].innerText || element.labels[0].textContent || ""
        if (labelText.trim()) return labelText.trim()
      }
      var alt = element.getAttribute && element.getAttribute("alt")
      if (alt && alt.trim()) return alt.trim()
      var placeholder = element.getAttribute && element.getAttribute("placeholder")
      if (placeholder && placeholder.trim()) return placeholder.trim()
      if (NO_CONTENT_NAME[role]) return undefined
      var text = (element.innerText || element.textContent || "").trim()
      if (text) return text.length > 80 ? text.slice(0, 80) : text
    } catch (err) {
      // ignore
    }
    return undefined
  }

  function stateOf(element) {
    var states = []
    try {
      var type = String(element.type || "").toLowerCase()
      if ((type === "checkbox" || type === "radio") && element.checked) states.push("checked")
      if (element.disabled) states.push("disabled")
      if (element.required) states.push("required")
      var expanded = element.getAttribute && element.getAttribute("aria-expanded")
      if (expanded === "true") states.push("expanded")
      if (expanded === "false") states.push("collapsed")
      if (element.getAttribute && element.getAttribute("aria-selected") === "true") states.push("selected")
      if (element.tagName === "OPTION" && element.selected) states.push("selected")
    } catch (err) {
      // ignore
    }
    return states.length ? states.join(",") : undefined
  }

  function walkA11y(root, maxNodes, result) {
    var nodes = []
    var stack = [root]
    while (stack.length > 0 && nodes.length < maxNodes) {
      var element = stack.shift()
      if (!element || element.nodeType !== 1) continue
      var role = roleOf(element)
      if (role) {
        var entry = { role: role }
        var name = accessibleName(element, role)
        if (name) entry.name = name
        var state = stateOf(element)
        if (state) entry.state = state
        nodes.push(entry)
      }
      var children = element.children
      if (children) {
        for (var i = 0; i < children.length; i++) stack.push(children[i])
      }
    }
    if (nodes.length >= maxNodes) result.truncated = true
    return nodes
  }

  globalThis.__OPENCODE_LIVE_SNAPSHOT__ = function (params) {
    var request = params || {}
    var mode = request.mode === "html" || request.mode === "a11y" ? request.mode : "text"
    var maxChars = typeof request.maxChars === "number" && request.maxChars > 0 ? request.maxChars : DEFAULT_MAX_CHARS
    var maxNodes = typeof request.maxNodes === "number" && request.maxNodes > 0 ? request.maxNodes : DEFAULT_MAX_NODES
    var result = {
      found: false,
      url: currentUrl(),
      title: currentTitle(),
      selector: request.selector || undefined,
      mode: mode,
      truncated: false,
      length: 0,
    }
    try {
      var root = request.selector ? document.querySelector(request.selector) : document.body
      if (!root) return result
      result.found = true
      if (mode === "html") {
        var html = String(root.outerHTML || "")
        result.length = html.length
        result.html = truncate(html, maxChars, result)
        return result
      }
      if (mode === "a11y") {
        var nodes = walkA11y(root, maxNodes, result)
        result.length = nodes.length
        result.nodes = nodes
        return result
      }
      var text = String(root.innerText || root.textContent || "")
      result.length = text.length
      result.text = truncate(text, maxChars, result)
      return result
    } catch (err) {
      return result
    }
  }
})()
