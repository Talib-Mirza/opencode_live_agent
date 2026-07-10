import type { Plugin } from "vite"

export interface OpencodeLiveOptions {
  server?: string
}

export function opencodeLive(options?: OpencodeLiveOptions): Plugin {
  let root = process.cwd()

  return {
    name: "opencode-live",
    apply: "serve",
    configResolved(config) {
      root = config.root
    },
    transformIndexHtml() {
      const server = options?.server ?? process.env.OPENCODE_SERVER_URL ?? "http://localhost:4096"
      const src = `${server}/live/inject.js?directory=${encodeURIComponent(root)}`
      return [
        {
          tag: "script",
          attrs: { type: "module", src },
          injectTo: "head",
        },
      ]
    },
  }
}

export default opencodeLive
