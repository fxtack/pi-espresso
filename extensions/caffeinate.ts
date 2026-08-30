/**
 * Keeps the Mac awake (display + system idle) while the agent is running.
 *
 * Spawns `caffeinate -di` on agent_start and terminates it on agent_settled
 * (fires when pi will not auto-retry or continue with queued messages).
 *
 * macOS only; no-ops elsewhere.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let proc: ChildProcess | null = null;

	const start = () => {
		if (process.platform !== "darwin" || proc) return;
		// -d: prevent display sleep, -i: prevent system idle sleep
		proc = spawn("caffeinate", ["-di"], { stdio: "ignore" });
		proc.on("exit", () => (proc = null));
	};

	const stop = () => {
		if (proc) {
			proc.kill("SIGTERM");
			proc = null;
		}
	};

	pi.on("agent_start", () => start());
	pi.on("agent_settled", () => stop());
	pi.on("session_shutdown", () => stop());
}
