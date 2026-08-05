// Backend provider adapters. The runtime (agent.ts) is a GENERIC driver — spawn a CLI, stream events, optionally
// drive a long-lived multi-turn session — and everything backend-specific lives behind this one interface:
//   • how the three harness axes + prompt + model lower to argv (per mode), and
//   • how the backend's stdout events normalize to a small common vocabulary, and
//   • how a single user turn is framed onto the session's stdin (RPC).
// Adding a backend = one Provider. Today: Pi (the original), OpenCode, and Hermes. The FSM/compiler are
// provider-agnostic — a leaf is just "someone runs it" — and the seam is kept so a new backend is one Provider,
// not a cross-cutting change.
//
// Two axes had to widen to admit backends that aren't Pi-shaped (see CHANGELOG 0.1.2):
//   • `prepare()` — neither OpenCode nor Hermes has a --system-prompt flag, so the prompt axis can't lower to argv.
//     A provider gets to stage scratch files and contribute env vars before the spawn.
//   • `session`/`stream` — neither has Pi's stdin turn protocol, so validator-driven multi-turn is one spawn per
//     turn resuming a captured session id, and a backend with no event stream is read as plain text.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentRunConfig } from "./agent.js";

export type AgentMode = "oneshot" | "rpc" | "interactive";

/** The common event vocabulary every backend stream is normalized into (the only shape the driver understands). */
export type NormEvent =
  | { kind: "tool_start"; name: string; detail?: string }
  | { kind: "tool_end"; name: string; error?: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  // `costCumulative`: a backend that reports a running session total (rather than per-message deltas) sets this — the
  // driver SETs rather than ADDs so a multi-turn RPC session isn't double-counted. Tokens are always per-message deltas.
  // tokensIn/Out = UNCACHED input / output. cacheRead/cacheWrite = cached-input read / cache-creation tokens —
  // the bulk of input under prompt caching (omitting them undercounts input ~30×). costUSD is the cache-discounted $.
  | { kind: "usage"; model?: string; tokensIn: number; tokensOut: number; cacheRead?: number; cacheWrite?: number; costUSD: number; costCumulative?: boolean }
  // A backend that mints a session id on its stdout stream reports it once, so `session: "resume"` providers can
  // resume THAT session on the next turn. Pi never emits this (its RPC session is the live stdin pipe).
  | { kind: "session"; id: string }
  | { kind: "turn_end" };

/** How a provider drives a multi-turn (validator-driven) session — the `rpc` mode of the driver.
 *  • "stdin"  — one long-lived process; each turn is a JSON frame written to stdin (Pi).
 *  • "resume" — one spawn PER turn; turn 2+ re-attaches to the session id captured from turn 1.
 *  • "none"   — no multi-turn at all; the driver must fall back to one-shot and skip validation re-prompting. */
export type SessionMode = "stdin" | "resume" | "none";

/** How the backend's stdout is read. "json" = NDJSON events through `normalize`; "text" = no event stream at all,
 *  stdout is the assistant's final text and usage arrives out-of-band via `collectUsage`. */
export type StreamMode = "json" | "text";

/** Staged per-run side-channel state: env vars to merge into the spawn, plus a cleanup for any scratch dir. */
export interface Prepared {
  env?: Record<string, string>;
  /** Extra argv appended after `args()` — for paths only knowable after staging (e.g. a temp usage file). */
  extraArgs?: string[];
  /** Called in the driver's `finally`, always, even on abort/throw. Must never throw. */
  cleanup?: () => void;
  /** Read usage the backend wrote to a file rather than streaming (Hermes `--usage-file`). */
  collectUsage?: () => NormEvent[];
}

export interface Provider {
  readonly name: string;
  /** Default executable (overridable per run via `config.binary`). */
  readonly binary: string;
  /** How to install it — surfaced verbatim in the ENOENT "not found" error (first-run stumble #1). */
  readonly install: string;
  /** Multi-turn strategy. Absent ⇒ "stdin" (Pi's protocol), so an older provider object still type-checks. */
  readonly session?: SessionMode;
  /** stdout shape. Absent ⇒ "json" (NDJSON events). */
  readonly stream?: StreamMode;
  /** Build the argv (excluding the binary) for a run mode from the leaf config. */
  args(mode: AgentMode, c: AgentRunConfig): string[];
  /** One backend stdout event (already JSON-parsed) → zero or more normalized events. */
  normalize(raw: any): NormEvent[];
  /** Frame one user turn as a JSON object written to the RPC session's stdin. */
  frame(message: string): object;
  /** Stage per-run side-channel state (scratch config dirs, env-borne prompts, usage files) before the spawn.
   *  Absent ⇒ nothing to stage: argv + inherited env is the whole contract (Pi). `sessionId` is set on a resume
   *  turn so the provider can lower it to argv/env. */
  prepare?(mode: AgentMode, c: AgentRunConfig, sessionId?: string): Prepared;
  /** Render this backend's plugin artifact(s) for a synthesized tool, given the neutral routine module's filename
   *  (a sibling it imports relatively). Pure string generation — written next to the routine at bind time, for ALL
   *  backends, so whichever backend runs the command later finds its variant. Empty ⇒ this backend needs no file. */
  renderTool(routineFile: string): { name: string; content: string }[];
}

// ── Pi (original backend) ────────────────────────────────────────────────────
// prompt/appendPrompt are FILE paths; Pi's `--system-prompt`/`--append-system-prompt` read a file.
export const piProvider: Provider = {
  name: "pi",
  binary: "pi",
  install: "npm i -g @mariozechner/pi-coding-agent",
  session: "stdin",
  stream: "json",
  args(mode, c) {
    const a =
      mode === "oneshot" ? ["--mode", "json", "-p", "--no-session"]
      : mode === "rpc" ? ["--mode", "rpc", "--no-session"]
      : ["--no-session"];
    if (c.piModel) a.push("--model", c.piModel);
    a.push("--system-prompt", c.prompt);
    if (c.appendPrompt) a.push("--append-system-prompt", c.appendPrompt);
    if (mode !== "interactive") {
      for (const s of c.skills ?? []) a.push("--skill", s);    // axis: knowledge
      a.push(...piExtensionArgs(c.extensions ?? []));          // axis: capability (synthesized routine → .pi.mjs)
    }
    if (mode === "oneshot" || (mode === "interactive" && c.task)) a.push(c.task);
    return a;
  },
  normalize(e) {
    const out: NormEvent[] = [];
    if (e.type === "tool_execution_start" && e.toolName) {
      out.push({ kind: "tool_start", name: e.toolName, detail: e.args?.path || e.args?.command?.slice(0, 60) || "" });
    } else if (e.type === "tool_execution_end" && e.toolName) {
      out.push({ kind: "tool_end", name: e.toolName, error: e.isError ? (e.result?.content?.[0]?.text || "") : undefined });
    } else if (e.type === "message_end" && e.message?.role === "assistant") {
      const m = e.message;
      if (m.usage) out.push({ kind: "usage", model: m.model, tokensIn: m.usage.input || 0, tokensOut: m.usage.output || 0, cacheRead: m.usage.cacheRead || 0, cacheWrite: m.usage.cacheWrite || 0, costUSD: m.usage.cost?.total || 0 });
      for (const c of m.content || []) {
        if (c.type === "thinking" && c.thinking) out.push({ kind: "thinking", text: c.thinking });
        if (c.type === "text" && c.text) out.push({ kind: "text", text: c.text });
      }
    } else if (e.type === "agent_end") {
      out.push({ kind: "turn_end" });
    }
    // `response` / `extension_ui_request` / `extension_error` / `queue_update` ⇒ [] (RPC acks / headless-irrelevant)
    return out;
  },
  frame(message) { return { type: "prompt", message }; },
  renderTool(routineFile) { return [{ name: routineFile.replace(/\.routine\.mjs$/, ".pi.mjs"), content: piToolSource(routineFile) }]; },
};

// ── OpenCode (sst/opencode) ──────────────────────────────────────────────────
// Verified against the released CLI (`opencode-ai` v1.18.13; `packages/opencode/src/cli/cmd/run.ts`).
//
// Three surfaces differ from Pi and drive everything below:
//  1. NO --system-prompt flag. A system prompt is an *agent* config field, and config text supports `{file:...}`
//     substitution — so we generate a config dir with an agent whose `prompt` is "{file:<c.prompt>}" and route it in
//     with OPENCODE_CONFIG_DIR, then select it with `--agent`. appendPrompt lowers to `instructions`, which is
//     additive by design (the exact base-prompt merge semantics don't matter: either way our text is injected).
//  2. Custom tools are NOT an argv flag. The tool registry globs `{tool,tools}/*.{js,ts}` across config dirs, so the
//     synthesized routine's wrapper is written into `<configdir>/tool/` at prepare time. Tool id = filename stem.
//  3. Permissions: run headlessly WITHOUT --auto and opencode AUTO-REJECTS every permission request (run.ts
//     `permission.asked` → reply "reject"). Pi under --no-session is effectively unattended, so --auto is required
//     for parity — a leaf that silently loses every edit is worse than a loud failure.
//
// Stream: `--format json` emits NDJSON {type, timestamp, sessionID, ...}. Turn completion is NOT observable on
// stdout (the loop breaks on a `session.status`→idle event it does not itself emit), so turn_end comes from process
// exit — which is also why multi-turn is `session: "resume"` rather than a stdin protocol.
export const opencodeProvider: Provider = {
  name: "opencode",
  binary: "opencode",
  install: "npm i -g opencode-ai",
  session: "resume",
  stream: "json",
  args(mode, c) {
    // `run [message..]` is headless; the TUI is the bare `opencode [project]` command. Both accept
    // --model/--agent/--session/--auto, but they differ in how the task is passed, and it matters: the TUI's
    // positional is a PROJECT PATH, so pushing the task there would be silently read as a directory. The TUI takes
    // the seed via --prompt instead.
    const a = mode === "interactive" ? [] : ["run", "--format", "json"];
    if (c.piModel) a.push("--model", c.piModel);
    a.push("--agent", OC_AGENT);
    if (mode !== "interactive") a.push("--auto"); // else every permission request is auto-rejected
    if (mode === "interactive") { if (c.task) a.push("--prompt", c.task); }
    else a.push(c.task);
    return a;
  },
  normalize(e) {
    const out: NormEvent[] = [];
    if (typeof e?.sessionID === "string" && e.sessionID) out.push({ kind: "session", id: e.sessionID });
    const p = e?.part;
    if (e?.type === "tool_use" && p?.tool) {
      // `tool_use` is emitted ONLY for a settled part (status completed|error) — opencode never streams a pending
      // tool in --format json. So both halves are synthesized from this one event: the start carries the args
      // (which file / which command — the useful log line), the end carries the outcome.
      const st = p.state ?? {};
      const input = st.input ?? {};
      out.push({ kind: "tool_start", name: p.tool, detail: String(input.filePath ?? input.path ?? input.command ?? "").slice(0, 60) });
      out.push({ kind: "tool_end", name: p.tool, error: st.status === "error" ? String(st.error ?? "") : undefined });
    } else if (e?.type === "text" && p?.text) {
      out.push({ kind: "text", text: p.text });
    } else if (e?.type === "reasoning" && p?.text) {
      out.push({ kind: "thinking", text: p.text });
    } else if (e?.type === "step_finish") {
      // StepFinishPart is exactly {reason, snapshot?, cost, tokens:{input,output,reasoning,cache:{read,write}}} —
      // note there is NO model field, and `--format json` deliberately omits the `message.updated` line that would
      // carry `modelID`. So the model is not discoverable from this stream; the driver seeds it from config instead.
      // `cost` is per-step, so ADD.
      const t = p?.tokens ?? {};
      out.push({
        kind: "usage",
        tokensIn: t.input || 0, tokensOut: t.output || 0,
        cacheRead: t.cache?.read || 0, cacheWrite: t.cache?.write || 0,
        costUSD: p?.cost || 0,
      });
    } else if (e?.type === "error") {
      out.push({ kind: "tool_end", name: "opencode", error: String(e.error?.data?.message ?? e.error?.name ?? e.error ?? "") });
    }
    return out;
  },
  // Unused: session mode is "resume", so the driver never writes turns to stdin. Kept non-throwing to satisfy the
  // interface (a caller that ignores `session` and frames a turn anyway gets an inert object, not a crash).
  frame(message) { return { type: "prompt", message }; },
  prepare(mode, c, sessionId) {
    // The agent's `prompt` field takes a config-substitution reference to our prompt FILE — no flag needed.
    const agent: Record<string, unknown> = { mode: "primary", prompt: `{file:${c.prompt}}` };
    if (c.piModel) agent.model = c.piModel;
    const cfg: Record<string, unknown> = { $schema: "https://opencode.ai/config.json", agent: { [OC_AGENT]: agent } };
    // Knowledge axis + appendPrompt → `instructions` (a list of file paths, additive to the system prompt).
    const instructions = [...(c.appendPrompt ? [c.appendPrompt] : []), ...(mode !== "interactive" ? c.skills ?? [] : [])];
    if (instructions.length) cfg.instructions = instructions;
    const cfgJson = JSON.stringify(cfg, null, 2);

    // Capability axis: the registry globs `{tool,tools}/*.{js,ts}` in every config dir. Our wrappers are .mjs
    // (ESM, as rendered at bind time), so re-export each through a globbed `.js` shim that imports it by abspath.
    // The shim's default export is the wrapper's {description,args,execute} — the shape opencode's `isPluginTool`
    // guard requires — and the tool id is the shim's filename stem.
    const shims: Array<{ name: string; content: string }> = [];
    if (mode !== "interactive") {
      for (const e of c.extensions ?? []) {
        const wrapper = isRoutine(e) ? e.replace(/\.routine\.mjs$/, ".opencode.mjs") : e;
        const stem = wrapper.split("/").pop()!.replace(/\.(opencode\.)?mjs$/, "").replace(/[^A-Za-z0-9_-]/g, "_");
        // `?? mod` unwraps CJS-interop double-wrapping: a loader that treats this `.js` as CommonJS hands back the
        // ESM namespace as `default`, so the tool object would sit at `default.default` and fail the registry's
        // structural guard silently (verified against Node's own resolver + a transpiling loader).
        shims.push({
          name: `${stem}.js`,
          content: `import mod from ${JSON.stringify(wrapper)};\nexport default mod?.default ?? mod;\n`,
        });
      }
    }

    // The dir is keyed by a hash of its CONTENTS rather than mkdtemp'd per run, because opencode fires a background
    // `npm install @opencode-ai/plugin` into every config dir it loads — and AWAITS it whenever a custom tool is
    // present. A fresh dir per attempt would make every leaf pay a cold, network-dependent install; a content-keyed
    // dir is cold once and warm thereafter, while a changed prompt/toolset still gets a new dir (no stale reuse).
    const key = createHash("sha256").update(cfgJson).update(shims.map((s) => s.name + s.content).join("\0")).digest("hex").slice(0, 16);
    const dir = join(tmpdir(), `reharness-oc-${key}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.json"), cfgJson);
    if (shims.length) {
      // `type: module` is REQUIRED, not cosmetic: the registry globs `*.{js,ts}`, and a bare `.js` holding ESM syntax
      // is module-ambiguous — older runtimes reject it outright and transpiling loaders silently make it CommonJS.
      // (opencode's own background `npm install` merges its dependency into this file and preserves the field.)
      writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");
      mkdirSync(join(dir, "tool"), { recursive: true });
      for (const s of shims) writeFileSync(join(dir, "tool", s.name), s.content);
    }

    return {
      // OPENCODE_CONFIG_DIR is prepended to the config-dir search list (project config still loads and could
      // fight our agent definition, so disable it — a leaf must be reproducible, not cwd-dependent).
      env: { OPENCODE_CONFIG_DIR: dir, OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
      extraArgs: sessionId ? ["--session", sessionId] : [],
      // Deliberately NOT removed: the warm `node_modules` is the point (see the hash note above). It lives in the
      // OS temp dir and is keyed by content, so it is self-limiting and OS-reclaimed.
      cleanup: () => {},
    };
  },
  renderTool(routineFile) {
    return [{ name: routineFile.replace(/\.routine\.mjs$/, ".opencode.mjs"), content: opencodeToolSource(routineFile) }];
  },
};

/** Name of the generated agent we define and select with --agent (must not collide with a user's own agents). */
const OC_AGENT = "reharness";

/** Read a leaf's skill as TEXT, for a backend that has no path-addressable skill flag (Hermes). A skill is either a
 *  markdown file or a directory holding SKILL.md; anything unreadable yields "" so one bad skill can't fail the leaf. */
function readSkillText(skillPath: string): string {
  for (const p of [skillPath, join(skillPath, "SKILL.md")]) {
    try { return readFileSync(p, "utf8"); } catch { /* try the next shape */ }
  }
  return "";
}

/** OpenCode custom tool: a default-exported {description, args, execute}. `args` accepts a plain JSON-Schema
 *  property map (registry.ts `legacyJsonSchema` path) — so no zod dependency is pulled in. */
function opencodeToolSource(routineFile: string): string {
  return `import { tool, run } from "./${routineFile}";
export default {
  description: tool.description,
  args: (tool.schema && tool.schema.properties) || {},
  async execute(args) {
    const r = run(args);
    return typeof r === "string" ? r : JSON.stringify(r);
  },
};
`;
}

// ── Hermes (NousResearch/hermes-agent) ───────────────────────────────────────
// Verified against `hermes_cli/{main,oneshot}.py` on main.
//
// Hermes is the thinnest surface of the three. Its scripted entry point is the TOP-LEVEL `-z/--oneshot <prompt>`
// (not a `chat` subcommand flag — `-z` bypasses the chat parser entirely), and exactly four things pass through it:
// `-m/--model`, `--provider`, `-t/--toolsets`, `--usage-file`. Everything else about the adapter follows from that:
//
//  1. NO event stream. `-z` prints the final assistant text and nothing else — no per-tool or per-message events to
//     normalize, hence `stream: "text"`. Usage isn't on stdout either: it lands in the `--usage-file` JSON, written
//     even when the run fails. prepare() stages that file and collectUsage() reads it back.
//  2. NO session resume under `-z` (resume is a `chat` flag, and `chat` in turn cannot write a usage file), so
//     `session: "none"`: a validator runs ONCE after the one-shot and a failure is loud. `chat -q --continue` was
//     the alternative, but "most recent session" is global mutable state — under reharness's parallel fan-out two
//     concurrent leaves would resume each other's session. Correctness beats a fix-round.
//  3. NO verifiable custom-tool loading path. Hermes has toolsets and skills, but nothing in the released CLI loads
//     an arbitrary tool module from a path, so `renderTool` returns [] and the capability axis degrades loudly.
//  4. Skills do NOT lower to `-s`: that flag resolves skills by NAME inside Hermes' own skills dir, while a leaf's
//     skills are absolute paths (registering them would mean editing the user's global ~/.hermes/config.yaml). The
//     knowledge axis is preserved by INLINING each skill's text into the ephemeral system prompt instead — the same
//     end state as Pi's `--skill`, reached without mutating user config.
//
// Approvals need no flag: `-z` sets Hermes' own bypass internally, matching Pi's unattended `--no-session`.
export const hermesProvider: Provider = {
  name: "hermes",
  binary: "hermes",
  install: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
  session: "none",
  stream: "text",
  args(mode, c) {
    // Interactive: plain `chat`, so the user's own display.interface (TUI vs classic REPL) still decides. The task
    // is deliberately NOT passed: hermes' only prompt flag is `-q`, which is *non-interactive* — using it would make
    // the session answer once and exit. Unlike Pi's positional seed, hermes has no seed-an-interactive-session flag,
    // so the operator types the first turn. The system prompt and skills still arrive via the env staged in prepare().
    if (mode === "interactive") {
      const a = ["chat"];
      if (c.piModel) a.push("-m", c.piModel);
      return a;
    }
    // Top-level `-z <prompt>`: stdout is the final answer only. --usage-file is appended by prepare().
    const a = ["-z", c.task];
    if (c.piModel) a.push("-m", c.piModel);
    return a;
  },
  // No event stream: stdout is plain text, surfaced by the driver as a single `text` event. Never called.
  normalize() { return []; },
  frame(message) { return { type: "prompt", message }; },
  prepare(mode, c) {
    const dir = mkdtempSync(join(tmpdir(), "reharness-hm-"));
    const usageFile = join(dir, "usage.json");
    const env: Record<string, string> = {};
    // No --system-prompt flag: the prompt travels as CONTENT via env. appendPrompt and the knowledge axis are
    // concatenated onto it (Hermes has neither an append channel nor path-addressable skills — see note 4).
    try {
      const parts = [readFileSync(c.prompt, "utf8")];
      if (c.appendPrompt) parts.push(readFileSync(c.appendPrompt, "utf8"));
      if (mode !== "interactive") for (const s of c.skills ?? []) parts.push(readSkillText(s));
      env.HERMES_EPHEMERAL_SYSTEM_PROMPT = parts.filter(Boolean).join("\n\n");
    } catch { /* unreadable prompt file ⇒ backend defaults, same as an absent flag */ }

    const extraArgs = mode === "interactive" ? [] : ["--usage-file", usageFile];

    return {
      env, extraArgs,
      cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
      collectUsage: () => {
        try {
          const u = JSON.parse(readFileSync(usageFile, "utf8"));
          const out: NormEvent[] = [];
          if (typeof u.session_id === "string" && u.session_id) out.push({ kind: "session", id: u.session_id });
          out.push({
            kind: "usage", model: u.model,
            tokensIn: u.input_tokens || 0, tokensOut: u.output_tokens || 0,
            cacheRead: u.cache_read_tokens || 0, cacheWrite: u.cache_write_tokens || 0,
            costUSD: u.estimated_cost_usd || 0,
          });
          return out;
        } catch { return []; } // best-effort accounting: a missing usage file must not fail the leaf
      },
    };
  },
  // No verifiable path-based tool loading in the released CLI — see note above. Deliberately empty.
  renderTool() { return []; },
};

// ── synthesized-tool plumbing (the "extract one neutral routine, render per backend" model) ──────────────────
// A synthesized tool is authored ONCE as a neutral routine module `<name>.routine.mjs` exporting `{ tool, run }`
// (tool = {name, description, schema:JSON-Schema}; run = the pure frozen routine). A backend renders a thin wrapper
// around it (Pi: `renderTool` above) and lowers a `*.routine.mjs` extension ref to its own load flags (below). A
// non-routine extension entry (a hand-written capability file) passes through with the backend's native flag.
const isRoutine = (e: string) => e.endsWith(".routine.mjs");

function piExtensionArgs(extensions: string[]): string[] {
  const a: string[] = [];
  for (const e of extensions) a.push("--extension", isRoutine(e) ? e.replace(/\.routine\.mjs$/, ".pi.mjs") : e);
  return a;
}

/** Pi extension wrapping the neutral routine (parameters = the routine's JSON Schema — Pi accepts it directly). */
function piToolSource(routineFile: string): string {
  return `import { tool, run } from "./${routineFile}";
export default function (pi) {
  pi.registerTool({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.schema,
    execute: async (_id, params) => {
      const r = run(params);
      return { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }], details: {} };
    },
  });
}
`;
}

const REGISTRY: Record<string, Provider> = { pi: piProvider, opencode: opencodeProvider, hermes: hermesProvider };

/** Every registered backend — used at tool-bind time to render all variants (any backend may run the command later). */
export function allProviders(): Provider[] { return Object.values(REGISTRY); }

/** Resolve a backend by name (def.provider / RunOptions.provider / REHARNESS_PROVIDER); defaults to Pi. */
export function resolveProvider(name?: string): Provider {
  const p = REGISTRY[name || "pi"];
  if (!p) throw new Error(`Unknown provider "${name}" (known: ${Object.keys(REGISTRY).join(", ")})`);
  return p;
}
