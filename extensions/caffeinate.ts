/**
 * Keeps the Mac awake (display + system idle) while the agent is running,
 * and marks the terminal title with ☕️ while caffeinate is active.
 *
 * Spawns `caffeinate -di` on agent_start and terminates it on agent_settled
 * (fires when pi will not auto-retry or continue with queued messages).
 *
 * Title follows pi's own format ("π - [session - ]cwd"). pi rewrites the
 * title on session rename/switch/new/resume/fork, so the marker is
 * re-asserted shortly after those events while caffeinate is running.
 *
 * macOS only; no-ops elsewhere.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Matches pi's APP_TITLE default. Only differs for a custom-branded pi build
// (package.json `piConfig.name`); the title self-heals on the next rename/switch.
const APP_TITLE = "π";

export default function (pi: ExtensionAPI) {
	let proc: ChildProcess | null = null;
	let pending: ReturnType<typeof setTimeout> | null = null;

	const active = () => proc !== null;

	// Compose pi's title format, optionally prefixed with the caffeinate marker.
	const setTitle = (ctx: ExtensionContext, caffeinate: boolean) => {
		if (!ctx.hasUI) return;
		const cwdBasename = path.basename(ctx.sessionManager.getCwd());
		const name = ctx.sessionManager.getSessionName();
		const base = name ? `${APP_TITLE} - ${name} - ${cwdBasename}` : `${APP_TITLE} - ${cwdBasename}`;
		ctx.ui.setTitle(caffeinate ? `☕️ ${base}` : base);
	};

	// Re-assert the marker after pi rewrites the title. Delayed so we run
	// after pi's internal handler regardless of listener ordering.
	const reassert = (ctx: ExtensionContext) => {
		if (!active()) return;
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = null;
			setTitle(ctx, true);
		}, 50);
	};

	const start = (ctx: ExtensionContext) => {
		if (process.platform !== "darwin" || proc) return;
		// -d: prevent display sleep, -i: prevent system idle sleep
		proc = spawn("caffeinate", ["-di"], { stdio: "ignore" });
		proc.on("exit", () => (proc = null));
		setTitle(ctx, true);
	};

	const stop = (ctx?: ExtensionContext) => {
		if (!proc) return;
		proc.kill("SIGTERM");
		proc = null;
		// Only touch the title if caffeinate actually ran (non-macOS never does).
		if (ctx) setTitle(ctx, false);
	};

	pi.on("agent_start", (_event, ctx) => start(ctx));
	pi.on("agent_settled", (_event, ctx) => stop(ctx));
	pi.on("session_info_changed", (_event, ctx) => reassert(ctx));
	pi.on("session_start", (_event, ctx) => reassert(ctx));
	pi.on("session_shutdown", () => {
		if (pending) {
			clearTimeout(pending);
			pending = null;
		}
		stop();
	});
}
