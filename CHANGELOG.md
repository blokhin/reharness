# Changelog

All notable changes to reharness are documented here. This project adheres to [Semantic Versioning](https://semver.org/);
while `0.x`, the runtime/compiler API may change between minor versions.

## 0.2.0

### Added
- **OpenCode and Hermes backends.** `--provider opencode` / `--provider hermes` (also `def.provider`,
  `REHARNESS_PROVIDER`) alongside `pi`. Both are single adapters in `src/runtime/providers.ts`, which is what 0.1.1's
  seam-preserving removal of the Claude Code backend was for. Surfaces pinned to released source: OpenCode
  `opencode-ai` v1.18.13, Hermes `hermes_cli/` on `main`.
- **`Provider.prepare(mode, config, sessionId?)`** — a provider may stage per-run side-channel state (scratch config
  dirs, env-borne prompts, usage files) and contribute env vars/argv before the spawn. Neither new backend accepts a
  system prompt on argv, so the `prompt` axis could not lower to flags: OpenCode gets it via a generated config dir
  (`OPENCODE_CONFIG_DIR`, using the config format's `{file:...}` substitution), Hermes via
  `HERMES_EPHEMERAL_SYSTEM_PROMPT`. Providers without the hook (Pi) spawn exactly as before.
- **`Provider.session` / `Provider.stream`** — declared multi-turn strategy (`"stdin" | "resume" | "none"`) and stdout
  shape (`"json" | "text"`). Neither new backend has a stdin turn protocol. OpenCode is `"resume"`: validator-driven
  re-prompting re-spawns per turn against the session id captured from turn 1 (`runAgentResume`), so context carries
  across turns but each fix round pays process startup — `pi` stays cheaper for validation loops. Hermes is `"none"`:
  its scripted entry point is the *top-level* `-z <prompt>`, which bypasses the chat parser (only `-m`, `--provider`,
  `-t`, `--usage-file` pass through), so resume is unreachable; `chat --continue` was rejected because "most recent
  session" is global mutable state that parallel leaves would steal from each other. Hermes also streams no events —
  stdout is the final text and usage arrives out-of-band via `--usage-file`.
- **`Provider.install`** — the ENOENT "backend not found" error now prints the right install command per backend
  instead of hardcoding Pi's.
- A `NormEvent` kind `session` (a backend reporting its session id), and a warning when a leaf's synthesized tools are
  dropped because the backend cannot load them — a silently-missing tool was the worst failure mode here.

### Fixed
- A `validate` callback on a backend declaring `session: "none"` (no in-session fix path) was silently skipped — the
  leaf passed unvalidated. The validator now runs once after a successful one-shot and a failure throws. No shipped
  backend uses that strategy, so this was latent, but the silent-pass shape was the dangerous part.
- OpenCode's `--format json` never emits a *pending* tool: `tool_use` fires only for a settled part
  (`status: completed|error`), so the adapter synthesizes both `tool_start` (carrying the args — which file, which
  command) and `tool_end` from that one event. The `status: "running"` branch was dead code, and tool args would
  never have reached the run log.
- Run accounting no longer reports a blank model on backends whose usage events carry no model id. OpenCode's
  `StepFinishPart` has no `model` field and `--format json` deliberately omits the `message.updated` line that would
  carry `modelID`, so `TokenState` is now seeded from the requested model (`freshTokenState`) and still overwritten by
  any backend that does report one.
- Interactive argv corrected on both new backends. OpenCode's TUI positional is `[project]`, a *path* — a task passed
  there would have been silently taken as a directory, so the seed now goes through `--prompt`. Hermes passes no task
  at all: its only prompt flag (`-q`) is explicitly non-interactive and would answer once and exit, and it has no
  seed-an-interactive-session flag.

### Notes
- **Hermes does not support synthesized tools.** Its released CLI has no path-based tool-loading flag (it has toolsets
  and skills, neither of which loads an arbitrary module), so `renderTool` returns nothing and the capability axis
  degrades with a warning rather than inventing a flag. Pin `pi`/`opencode` for pipelines that depend on an extracted
  routine.
- **Hermes skills are inlined into the ephemeral system prompt, not passed as `-s`.** That flag resolves skill *names*
  inside Hermes' own skills dir, while a leaf's skills are absolute paths; the only way to register an external
  directory is editing the user's global `~/.hermes/config.yaml`, which a leaf must not do. Inlining reaches the same
  end state without mutating user config. Both skill shapes are handled (a markdown file, or a dir holding `SKILL.md`).
- **Hermes needs no approval flag.** `-z` sets its own approval bypass internally, so there is no `--yolo` on our argv.
- **OpenCode runs headlessly with `--auto`.** Without it, it auto-*rejects* every permission request, so a leaf would
  complete having made no edits. This matches Pi's unattended `--no-session` behavior.
- OpenCode's generated config dir is keyed by a content hash and reused, because OpenCode fires a background
  `npm install @opencode-ai/plugin` into every config dir it loads and awaits it when a custom tool is present — a
  fresh dir per run would make each leaf pay a cold, network-dependent install.
- The generated config dir carries `package.json {"type":"module"}`. OpenCode's registry globs `{tool,tools}/*.{js,ts}`,
  and a bare `.js` holding ESM syntax is module-ambiguous: transpiling loaders treat it as CommonJS and the tool
  descriptor ends up at `default.default`, failing the registry's structural guard **silently** (the tool is skipped,
  not reported). The shim also normalizes that interop shape defensively. Covered by a test that imports the staged
  shim by `file://` URL and asserts OpenCode's own guard accepts it.

## 0.1.1 — 2026-06-15

Hardening & cleanup since the first release: accurate token accounting, a two-timer agent watchdog, output-side
render-once + a `c.dir`/`c.dirs` stage-reference check, the harness-compilation front, opt-in prompt-cache priming —
and the Claude Code backend removed (Pi is the sole backend).

### Added
- `compile --from-harness <dir>` — compile from an existing harness/implementation directory (research explores it in place).
- **Two-timer agent watchdog**: an L1 idle timer (kill on silence, reset by streaming) plus non-extendable L3 ceilings
  (`maxMs`/`maxUsd`/`maxTokens`). Env- and `--param`-configurable, default off; a trip fails loud into the verdict.
- **Accurate token accounting**: `cacheRead`/`cacheWrite` are captured (uncached input alone undercounted input ~30×);
  the run verdict reports total / output / cached tokens and the cache-discounted cost.
- **Output-side data-flow (render-once)**: an aggregator references its producers, never restates them — the dual of
  input need-to-know. New `c.dir`/`c.dirs` stage-reference check: a literal must name a producer stage (the workspace
  dual of config-flow), caught at compile time.
- **Opt-in prompt-cache priming for parallel fan-out** (`--param <parallel>.prime=1`): warm an agent-branch's shared
  prompt prefix once before the worker pool so the branches reuse it (input-side CSE). Semantically transparent,
  fail-soft, default off.

### Changed
- A timeout on **any** state now surfaces a warning in the run verdict, rather than being silently lost on non-`polish` states.
- Compiler prompts: a raw user/external input (`config.<arg>`) has no graph-authored schema, so its **first reader must
  be an `agent`** (never a `code` `JSON.parse` of free-form input); a missing **required** upstream producer is
  **fail-loud** (`throw` → ERROR), never defaulted to a plausible "success" value.
- Interprocedural `ctx.data` I/O extraction (follows ctx-threaded helper calls) for the definite-assignment check.

### Removed
- **Claude Code backend** (`--provider claude`). Pi is the only backend; the `Provider` seam in `runtime/providers.ts`
  remains so adding a new backend is one adapter, not a cross-cutting change.

## 0.1.0 — first public release

reharness compiles a natural-language request — or a recorded agent trace — into a **deterministic FSM pipeline**,
with model judgment only at the clearly-marked `agent` leaves. A fully-mechanical task compiles to **zero runtime
model calls**.

### Compiler
- `compile <description>` — request → human-approved PRD → FSM graph → generated TypeScript pipeline.
- `compile --from-session <path>` — distil a recorded session (any format) into a reusable pipeline.
- `amend [<command>] <request>` — fold a change into an existing pipeline's PRD and regenerate.
- `evolve [<command>]` — learn from the last run: self-heal failures, amortize repeated routines into tools, refine skills.
- One human checkpoint (the PRD), never the graph. Backends are pluggable: **Pi** (default) or **Claude Code**
  (`--provider claude`, to drive the agents on a subscription).

### Static analysis (a compiled pipeline is verified before it runs)
- Reachability + dead-end detection, definite-assignment data-flow over `ctx.data`, config-flow, guaranteed loop
  termination (every `loop` requires `max`), workspace-escape and substrate-violation checks, TypeScript compile.

### Runtime
- Deterministic hierarchical Moore-action transducer with run-to-completion; total, fail-loud transition function.
- `parallel` fork-join (real process parallelism), bounded `loop`, `switch`, `wait`, `call`, `approval`, `set`.
- Derived (never declared) inter-stage data flow; per-state `timeoutMs`; resume of an interrupted run.
- `c.shell` (boolean) and `c.exec` (full result) — both async, abortable, timeout-bounded, dry-run-aware.

### Tooling
- `graph <command>` — render the compiled FSM to Mermaid (`<command>.mmd`) or a self-contained interactive
  viewer (`--html`). Deterministic, no model call.
- `<command> --dry-run` — smoke-test routing, guards and data flow with agents/shells stubbed, for **0 tokens**.
- `--param` / `--params` per-run hyperparameter overrides.

### Reliability, security & operations
- Transient-failure retry with exponential backoff + jitter for agent calls (`REHARNESS_AGENT_RETRIES`).
- Clear "backend not found" errors instead of a raw `ENOENT`.
- Secret redaction in traces, terminal output and persisted state (URL credentials, `Authorization`, common token shapes).
- Bounded disk usage: per-command run retention (`REHARNESS_RUN_RETENTION`).

### Distribution
- The compiled `reharness/` bundle is a first-class, liftable deliverable: it declares `reharness` as a dependency,
  so `mv` it elsewhere, run `npm install`, and it runs. Run-exhaust is quarantined under a gitignored `.cache/`.

### Known limitations
See **Operating in production → Known limitations** in the README. Notably: no global wall-clock run timeout
(bound individual states); run records live next to their output target (no cross-target run browser); a lifted
bundle needs `reharness` installed at its new location; Linux/macOS are the tested platforms.
