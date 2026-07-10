export * as ConfigV1 from "./config"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, type DeepMutable } from "../../schema"
import { ConfigExperimental } from "../../config/experimental"
import { ConfigReference } from "../../config/reference"
import { ConfigAgentV1 } from "./agent"
import { ConfigAttachmentV1 } from "./attachment"
import { ConfigCommandV1 } from "./command"
import { ConfigFormatterV1 } from "./formatter"
import { ConfigLayoutV1 } from "./layout"
import { ConfigLSPV1 } from "./lsp"
import { ConfigMCPV1 } from "./mcp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigPluginV1 } from "./plugin"
import { ConfigProviderV1 } from "./provider"
import { ConfigServerV1 } from "./server"
import { ConfigSkillsV1 } from "./skills"

export type Layout = ConfigLayoutV1.Layout

export const WellKnown = Schema.Struct({
  config: Schema.optional(Schema.Json),
  remote_config: Schema.optional(Schema.Json),
})

const LogLevelRef = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.optional(Schema.String).annotate({ description: "Default shell to use for terminal and bash tool" }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  server: Schema.optional(ConfigServerV1.Server).annotate({
    description: "Server configuration for opencode serve and web commands",
  }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommandV1.Info)).annotate({
    description: "Command configuration, see https://opencode.ai/docs/commands",
  }),
  skills: Schema.optional(ConfigSkillsV1.Info).annotate({ description: "Additional skill folder paths" }),
  references: Schema.optional(ConfigReference.Info).annotate({
    description: "Named git or local directory references",
  }),
  reference: Schema.optional(ConfigReference.Info).annotate({
    description: "@deprecated Use 'references' field instead. Named git or local directory references",
  }),
  watcher: Schema.optional(Schema.Struct({ ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))) })),
  live: Schema.optional(
    Schema.Struct({
      watch: Schema.optional(
        Schema.Struct({
          command: Schema.optional(Schema.String).annotate({
            description:
              "Dev server command to spawn while a live session is active; its output is captured for the live agent",
          }),
          logFile: Schema.optional(Schema.String).annotate({
            description: "Existing log file to tail instead of spawning a command",
          }),
          cwd: Schema.optional(Schema.String).annotate({
            description: "Working directory for the watch command; defaults to the project directory",
          }),
        }),
      ),
      cdp: Schema.optional(
        Schema.Struct({
          endpoint: Schema.optional(Schema.String).annotate({
            description:
              "Chrome DevTools Protocol HTTP endpoint of a browser started with --remote-debugging-port (default http://localhost:9222)",
          }),
          filter: Schema.optional(Schema.String).annotate({
            description: "Only capture pages whose URL contains this substring (default 'localhost')",
          }),
        }),
      ).annotate({
        description:
          "Capture browser telemetry over the Chrome DevTools Protocol instead of (or in addition to) the injected script",
      }),
      fields: Schema.optional(Schema.Literals(["nonsensitive", "none"])).annotate({
        description:
          "Form-field capture mode. 'nonsensitive' (default) records values for non-sensitive fields and fill-state only (no value) for passwords and sensitive fields; 'none' records fill-state only for every field.",
      }),
      triggers: Schema.optional(
        Schema.Struct({
          networkFailures: Schema.optional(Schema.Boolean).annotate({
            description: "Wake the agent on failed/blocked network requests (status 0, incl. CORS). Default true",
          }),
          crossOriginDev: Schema.optional(Schema.Boolean).annotate({
            description:
              "Also wake on cross-origin requests to dev hosts (loopback or same-hostname different-port), not just same-origin. Default true",
          }),
          backendErrors: Schema.optional(Schema.Boolean).annotate({
            description: "Wake the agent on dev-server stderr lines that look like errors. Default true",
          }),
          consoleWarn: Schema.optional(Schema.Boolean).annotate({
            description: "Wake the agent on first-seen console.warn messages (noisier). Default false",
          }),
        }),
      ).annotate({ description: "Which signals wake the live agent" }),
    }),
  ).annotate({ description: "Live agent session configuration" }),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPluginV1.Spec))),
  share: Schema.optional(Schema.Literals(["manual", "auto", "disabled"])).annotate({
    description:
      "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
  }),
  autoshare: Schema.optional(Schema.Boolean).annotate({
    description: "@deprecated Use 'share' field instead. Share newly created sessions automatically",
  }),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Disable providers that are loaded automatically",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "When set, ONLY these providers will be enabled. All other providers will be ignored",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  small_model: Schema.optional(Schema.String).annotate({
    description: "Small model to use for tasks like title generation in the format of provider/model",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({ build: Schema.optional(ConfigAgentV1.Info), plan: Schema.optional(ConfigAgentV1.Info) }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "@deprecated Use `agent` field instead." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        plan: Schema.optional(ConfigAgentV1.Info),
        build: Schema.optional(ConfigAgentV1.Info),
        general: Schema.optional(ConfigAgentV1.Info),
        explore: Schema.optional(ConfigAgentV1.Info),
        title: Schema.optional(ConfigAgentV1.Info),
        summary: Schema.optional(ConfigAgentV1.Info),
        compaction: Schema.optional(ConfigAgentV1.Info),
      }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "Agent configuration, see https://opencode.ai/docs/agents" }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProviderV1.Info)).annotate({
    description: "Custom provider configurations and model overrides",
  }),
  mcp: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([ConfigMCPV1.Info, Schema.Struct({ enabled: Schema.Boolean })])),
  ).annotate({ description: "MCP (Model Context Protocol) server configurations" }),
  formatter: Schema.optional(ConfigFormatterV1.Info).annotate({
    description:
      "Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  lsp: Schema.optional(ConfigLSPV1.Info).annotate({
    description:
      "Enable or configure LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional instruction files or patterns to include",
  }),
  layout: Schema.optional(ConfigLayoutV1.Layout).annotate({ description: "@deprecated Always uses stretch layout." }),
  permission: Schema.optional(ConfigPermissionV1.Info),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  attachment: Schema.optional(ConfigAttachmentV1.Info).annotate({
    description: "Attachment processing configuration, including image size limits and resizing behavior",
  }),
  enterprise: Schema.optional(
    Schema.Struct({ url: Schema.optional(Schema.String).annotate({ description: "Enterprise URL" }) }),
  ),
  tool_output: Schema.optional(
    Schema.Struct({
      max_lines: Schema.optional(PositiveInt).annotate({
        description: "Maximum lines of tool output before it is truncated and saved to disk (default: 2000)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 51200)",
      }),
    }),
  ).annotate({
    description:
      "Thresholds for truncating tool output. When output exceeds either limit, the full text is written to the truncation directory and a preview is returned.",
  }),
  compaction: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic compaction when context is full (default: true)",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description: "Enable pruning of old tool outputs (default: false)",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction (default: 2)",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
      }),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Enable the batch tool" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Tools that should only be available to primary agents.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Continue the agent loop when a tool call is denied",
      }),
      mcp_timeout: Schema.optional(PositiveInt).annotate({
        description: "Timeout in milliseconds for model context protocol (MCP) requests",
      }),
      policies: Schema.optional(Schema.mutable(Schema.Array(ConfigExperimental.Policy))).annotate({
        description: "Policy statements applied to supported resources, such as provider access",
      }),
    }),
  ),
}).annotate({ identifier: "Config" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>
