# pi-espresso ☕️

[English](README.md) | [简体中文](README.zh-CN.md)

A [pi](https://pi.dev) extension that keeps your Mac awake — **display included** — while the agent is working, and marks the terminal title with ☕️ so you can see it at a glance.

The name is the feature list: most keep-awake extensions only run `caffeinate -i` (block system idle sleep). pi-espresso pulls a **double shot** — `-d -i` — so your screen stays on too. The moment the agent settles, your Mac goes right back to sleep on its own; nothing lingers.

## Why

pi can run for minutes at a time — long refactors, test suites, multi-step tasks. If you look away, macOS dims the display or the machine idles to sleep mid-task. Closing the lid or sleeping manually should always work; only the *unattended* idle path should be suspended, and only while the agent is actually running.

## How it works

The extension listens to pi's agent lifecycle events and manages a `caffeinate` child process around them:

| Event | Action |
|-------|--------|
| `agent_start` | Spawns `caffeinate -di`, sets the ☕️ title marker |
| `agent_settled` | Kills caffeinate (`SIGTERM`) and restores the title. `agent_settled` fires only when pi will not continue on its own — auto-retries, auto-compaction, and queued follow-up messages keep the assertion alive, with no flicker between them |
| `session_info_changed` / `session_start` | If caffeinate is still active, re-asserts the ☕️ title after a short delay (pi rewrites the title on `/name` renames and session switch/new/resume/fork) |
| `session_shutdown` | Final cleanup |

- `-d` prevents **display** sleep; `-i` prevents **system idle** sleep.
- On non-macOS platforms the extension is a complete no-op — safe to sync across machines.
- Title changes are guarded by `ctx.hasUI` and skipped in print/JSON modes.

## Terminal title marker

While caffeinate runs, the terminal title becomes:

```
☕️ π - [session name - ]cwd-basename
```

This mirrors pi's native title format exactly, only prefixed. The marker is set on `agent_start` and restored on `agent_settled`. Because pi rewrites the title itself on renames and session switches, the extension re-asserts the marker (delayed 50 ms, so it always lands after pi's own handler) on `session_info_changed` and `session_start` while the assertion is active.

## Requirements

- **macOS** — `caffeinate` ships with macOS; nothing extra to install.
- **pi** — any recent version; uses only the public extension API.

## Install

```bash
# Option 1: install from a local path (records in ~/.pi/agent/settings.json)
pi install /path/to/pi-espresso

# Option 2: install from a git repo, pinned to a ref
pi install git:github.com/<you>/pi-espresso@v1

# Option 3: symlink the single file into the global extension directory
ln -s /path/to/pi-espresso/extensions/espresso.ts ~/.pi/agent/extensions/espresso.ts
```

Then restart pi, or run `/reload` in an open session.

## How is this different from `pi-caffeinate`?

[`pi-caffeinate`](https://www.npmjs.com/package/pi-caffeinate) is a solid cross-platform extension, but it makes the opposite trade-off on display sleep:

| | pi-caffeinate | pi-espresso |
|---|---|---|
| Platforms | macOS / Linux / Windows | macOS only (no-op elsewhere) |
| Display sleep | Unaffected by design | **Prevented** while the agent runs |
| Flags | `caffeinate -i` | `caffeinate -di` |
| Stop event | `agent_end` (re-engages between queued messages and retries) | `agent_settled` (no flicker) |
| Crash cleanup | `process.on("exit")` safety net | `session_shutdown` only |
| Title marker | — | ☕️ with re-assert after pi rewrites |

If you want display sleep untouched, use `pi-caffeinate`. If your problem is the screen going dark mid-task, this is the one.

## Known limitations

- **`kill -9`**: pi has no event to catch `SIGKILL`, so caffeinate would be orphaned and keep the machine awake until it is killed manually. Mitigation idea: spawn with `caffeinate -di -w <pi-pid>` so caffeinate watches pi's pid and exits on its own. (`pi-caffeinate`'s `process.on("exit")` net covers crashes, SIGINT and SIGTERM — worth adopting; SIGKILL remains uncatchable by any means.)
- **Custom-branded pi builds**: the title base is composed as `π - …` to match pi's default `APP_TITLE`. If your pi build renames itself via `piConfig.name`, the composed title will differ slightly until the next pi-driven rewrite self-heals it.

## Development

```
pi-espresso/
├── extensions/
│   └── espresso.ts    # the entire extension (single file, zero runtime deps)
├── package.json       # pi package manifest
└── README.md
```

- Syntax check: `node --check extensions/espresso.ts`
- The extension only imports Node builtins at runtime; the `@earendil-works/pi-coding-agent` import is type-only.
- For local use, symlink `extensions/espresso.ts` into `~/.pi/agent/extensions/` and edit in place — pi's loader follows symlinks.
