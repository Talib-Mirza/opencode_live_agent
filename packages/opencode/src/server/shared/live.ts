export const LIVE_CONNECT_TICKET_QUERY = "ticket"

const LIVE_CONNECT_PATH = "/live/connect"
const LIVE_INJECT_PATH = "/live/inject.js"

// Both live-capture routes are hit by the user's app under development (a script tag and a
// WebSocket from an arbitrary dev-server origin), which cannot carry Basic Auth credentials.
// Auth middleware skips Basic Auth for them; the handlers gate access instead — inject.js only
// responds for directories with an explicitly started live session, and connect consumes a
// possession ticket minted by inject.js.
export function isLiveInjectPath(pathname: string) {
  return pathname === LIVE_INJECT_PATH
}

export function hasLiveConnectTicketURL(url: URL) {
  return url.pathname === LIVE_CONNECT_PATH && !!url.searchParams.get(LIVE_CONNECT_TICKET_QUERY)
}
