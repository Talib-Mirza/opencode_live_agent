export * as LiveSignature from "./signature"

import { Live } from "@opencode-ai/schema/live"

const NORMALIZE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"],
  [/\b0x[0-9a-f]+\b/gi, "<hex>"],
  [/\b\d+\b/g, "<n>"],
]

export function normalize(message: string) {
  return NORMALIZE_PATTERNS.reduce((result, [pattern, token]) => result.replaceAll(pattern, token), message)
}

// First stack line that carries a file:line position, used to distinguish identical
// messages thrown from different places without keying on full (env-varying) stacks.
export function topFrame(stack: string | undefined) {
  if (!stack) return ""
  const frame = stack.split("\n").find((line) => /:\d+/.test(line))
  return frame?.trim() ?? ""
}

export function resolveUrl(requestUrl: string, pageUrl: string) {
  return URL.parse(requestUrl, pageUrl)
}

export function sameOrigin(requestUrl: string, pageUrl: string) {
  const page = URL.parse(pageUrl)
  const request = resolveUrl(requestUrl, pageUrl)
  if (!page || !request) return false
  return page.origin === request.origin
}

function isLoopback(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
}

// Same as sameOrigin but also treats dev-time cross-origin requests as app-owned: a page and a
// request that are both loopback (localhost:3000 -> localhost:8000) or share a hostname on a
// different port. Genuine third-party remote APIs (api.stripe.com) still return false.
export function appOwned(requestUrl: string, pageUrl: string) {
  const page = URL.parse(pageUrl)
  const request = resolveUrl(requestUrl, pageUrl)
  if (!page || !request) return false
  if (page.origin === request.origin) return true
  if (isLoopback(page.hostname) && isLoopback(request.hostname)) return true
  return page.hostname === request.hostname
}

// Collapse id-like path segments so /api/user/42 and /api/user/7 share one signature.
export function pathTemplate(requestUrl: string, pageUrl: string) {
  const resolved = resolveUrl(requestUrl, pageUrl)
  if (!resolved) return requestUrl
  return resolved.pathname
    .split("/")
    .map((segment) => (/^(\d+|[0-9a-f]{8,}|[0-9a-f-]{36})$/i.test(segment) ? ":id" : segment))
    .join("/")
}

export function signatureFor(event: Live.Telemetry) {
  switch (event.kind) {
    case "error":
      return `error ${normalize(event.message)} @ ${topFrame(event.stack)}`
    case "console":
      return `console.${event.level} ${normalize(event.message)} @ ${topFrame(event.stack)}`
    case "network":
      return `${event.method} ${pathTemplate(event.requestUrl, event.url)} ${event.status}`
    case "navigation":
    case "click":
    case "input":
      return undefined
  }
}
