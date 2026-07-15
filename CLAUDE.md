# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repo also has `AGENTS.md`, which contains the authoritative style guide, branch/commit conventions, and V2 Session Core architecture notes. Read it — it applies to Claude Code the same as any other agent.

## Commands

Requirements: Bun 1.3.14 (see `packageManager` in root `package.json`; the pre-push hook enforces this).

```bash
bun install         # install deps (from repo root)
bun dev              # run the CLI/TUI against packages/opencode (root package.json script)
bun dev .            # run OpenCode against the repo root itself
bun dev serve        # start the headless API server (port 4096)
bun run --cwd packages/app dev       # web app dev server (needs the API server running)
bun run --cwd packages/desktop dev   # Electron desktop app dev
bun typecheck        # turbo typecheck across all packages
bun run lint         # oxlint (root)
```

### Tests

Tests **cannot** be run from the repo root — `bunfig.toml` points `[test].root` at a nonexistent `./do-not-run-tests-from-root` to force this. Run them from the package directory instead:

```bash
cd packages/opencode && bun test --only-failures
cd packages/opencode && bun test --only-failures path/to/file.test.ts   # single file
cd packages/core && bun test --only-failures
```

Use `--timeout <ms>` to match a package's configured test script if a suite needs more time (check that package's `package.json` `"test"` script, e.g. `packages/opencode` and `packages/llm` use `--timeout 30000`).

### Type checking

Always run `bun typecheck` from a package directory (e.g. `packages/opencode`), never call `tsc` directly — packages use `tsgo --noEmit`.

### Regenerating generated code

- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Never hand-edit `src/generated` or `src/generated-effect`.
- To regenerate the legacy JS SDK: `./packages/sdk/js/script/build.ts`.
- `./script/generate.ts` (repo root) regenerates the SDK and related artifacts after server/API changes.

### Building a standalone binary ("localcode")

```bash
./packages/opencode/script/build.ts --single
./packages/opencode/dist/opencode-<platform>/bin/opencode   # e.g. darwin-arm64, linux-x64
```

## Architecture

This is a Bun/TypeScript monorepo (Turborepo + Bun workspaces) for OpenCode, an AI coding agent shipped as a CLI/TUI, headless server, web app, and Electron desktop app. The default branch is `dev` (local `main` may not exist — diff against `dev`/`origin/dev`).

### Two generations of core logic

The codebase is mid-migration from a V1 implementation embedded in `packages/opencode` to a V2 architecture split across dedicated packages. Both exist simultaneously; check which generation a file belongs to before assuming conventions transfer between them.

- **`packages/opencode`** — the CLI, TUI (SolidJS + [opentui](https://github.com/sst/opentui)), and legacy V1 business logic/server (`src/session`, `src/config`, `src/server`, `src/tool`, `src/agent`, `src/mcp`, `src/lsp`, `src/plugin`, etc.).
- **`packages/core`** — V2 domain logic: Effect-based services for accounts, config, sessions (`src/session`, `src/system-context`), permissions, plugins, PTY, credentials, database (Drizzle). Depends on Schema and Protocol only.
- **`packages/protocol`** — defines the public `HttpApi` (endpoint construction, middleware placement) using Effect Platform. Depends on Schema only; no Core/Server imports.
- **`packages/schema`** — shared Effect `Schema` datatypes, encoded/decoded projections, no service logic.
- **`packages/server`** — concrete `HttpApi` implementation/handlers (`src/handlers/*.ts`) wiring Protocol + Core together.
- **`packages/client`** — generated Promise and Effect network clients built from Server's `HttpApi` (an "SDK Contract IR" compiled once, with independent Promise/Effect emitters). Never hand-edit `src/generated*`.
- **`packages/sdk-next`** — the Effect-native "Embedded OpenCode" host that composes Client + Core + Server in-process (no network I/O); will eventually take over the `@opencode-ai/sdk` name from the legacy `packages/sdk`.
- **`packages/llm`** — provider-agnostic LLM protocol adapters (Anthropic, Google, Azure, Bedrock, GitHub Copilot, etc.) under `src/providers/*`.

Dependency direction (enforced): Schema → Core/Protocol → Server. Client depends on Schema and Protocol, never Core or Server. `sdk-next` composes Client, Core, and Server.

### UI layer

- `packages/opencode/src/cli/cmd/tui/` — terminal UI (SolidJS + opentui).
- `packages/app` — shared web UI components (SolidJS), consumed by both the web app and...
- `packages/desktop` — Electron app that wraps `packages/app`.
- `packages/session-ui`, `packages/ui` — shared UI building blocks.
- `packages/console` — separate web console (has its own `dev:console` script).

### Session runtime concepts (V2)

`CONTEXT.md` is the authoritative glossary for V2 session/runtime terminology (System Context, Session History, Context Source, Context Epoch, Session Drain, Model Tool Output, etc.) — consult it before making changes in `packages/core/src/session` or `packages/core/src/system-context`, since these terms carry precise, load-bearing definitions that ordinary English does not capture. Key invariants also called out in `AGENTS.md`:

- Durable prompt admission (`SessionV2.prompt(...)`) is kept separate from model execution; it admits a durable `session_input` row, then schedules an advisory `SessionExecution.wake(sessionID)`.
- `SessionExecution` is process-global and Session-ID based; `SessionRunner`, model resolution, tool registry, permissions, and filesystem access are Location-scoped.
- Exactly one explicit `llm.stream(request)` call per provider turn; no bridging through legacy `SessionPrompt.loop(...)`.
- Session drains are process-local with no durable identity — durable recovery must be reconstructed from prompts, projected history, provider attempts, and tool state.

### Repo-local OpenCode config

`.opencode/` at the repo root is OpenCode's own dogfood configuration (custom agents, commands, plugins, glossary translations) for working _on_ this repo — not part of the shipped product's runtime code.

## Style (see `AGENTS.md` for full detail and examples)

- One function per concern; don't extract single-use helpers preemptively.
- Avoid `try`/`catch`, avoid `any`, prefer `const` over `let` (use ternaries/early returns instead of reassignment), avoid `else` (prefer early returns).
- No aliased imports (`import { foo as bar }`), no star imports (`import * as Foo`) — import the module's own exported namespace by name instead.
- Avoid unnecessary destructuring; use dot notation (`obj.a`, not `const { a } = obj`).
- Prefer functional array methods (`map`/`filter`/`flatMap`) over `for` loops.
- Drizzle schema fields use snake_case names directly (`project_id: text().notNull()`), not camelCase with a string column override.
- In Effect generators, bind services to named variables before calling methods — never nested `yield*` chains.
- Branch names: ≤3 hyphenated words, no slashes or type prefixes (e.g. `session-recovery`, not `feat/session-recovery`).
- Commits/PR titles: Conventional Commits — `type(scope): summary` with type in `feat|fix|docs|chore|refactor|test`.
