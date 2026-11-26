import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The BUILT CLI (`dist/agx.js`) as real processes: two `agx link install` runs started
 * at the same moment on the same settings file, which also holds another tool's hook.
 * Neither install may be lost without a word, nothing may be truncated, the other
 * tool's hook must stay, and no temporary or lock file may be left.
 *
 *   pnpm build && E2E=1 pnpm exec vitest run src/test/link-install.e2e.test.ts
 *
 * Not part of `test:unit`: it needs a fresh build. Every run uses a throwaway HOME.
 */

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));
const TRIALS = 20;
const STALE_TRIALS = 100;

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

function start(home: string, args: string[]): Promise<Run> {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_") || key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR") {
			delete env[key];
		}
	}
	env.HOME = home;
	env.USERPROFILE = home;
	env.AGX_HOME = join(home, "agx-data");
	// link install connects to nothing; this is only so no command here could ever reach the default relay.
	env.AGX_RELAY = "ws://127.0.0.1:9";
	return new Promise((resolveRun, reject) => {
		const child = spawn(process.execPath, [AGX, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolveRun({ code, stdout, stderr }));
	});
}

function freshHome(): string {
	const home = mkdtempSync(join(tmpdir(), "agx-e2e-link-"));
	if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) {
		throw new Error(`refusing to use ${home}`);
	}
	mkdirSync(join(home, ".claude"));
	writeFileSync(
		join(home, ".claude", "settings.json"),
		`${JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "./other-tool-stop.sh" }] }] } }, null, 2)}\n`,
	);
	return home;
}

interface Settings {
	theme: string;
	hooks: Record<string, { hooks: { command: string }[] }[]>;
}

function commandsIn(settings: Settings, event: string): string[] {
	return (settings.hooks[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));
}

describe.skipIf(!existsSync(AGX))("agx link install: started twice at the same moment", () => {
	it(`${TRIALS} trials with different profiles: one install wins, the other is told so, and nothing else is lost`, async () => {
		let bothSucceeded = 0;
		for (let trial = 0; trial < TRIALS; trial++) {
			const home = freshHome();
			try {
				const [a, b] = await Promise.all([
					start(home, ["--profile", "a", "link", "install", "--agent", "claude"]),
					start(home, ["link", "install", "--agent", "claude"]),
				]);
				// A run that exits 0 says its entries are in the file; the other must say it refused.
				expect([0, 3], `trial ${trial} a: ${a.stderr}`).toContain(a.code);
				expect([0, 3], `trial ${trial} b: ${b.stderr}`).toContain(b.code);
				if (a.code === 0 && b.code === 0) {
					bothSucceeded++;
				}
				expect(a.code === 0 || b.code === 0, `trial ${trial}: neither install succeeded`).toBe(true);

				const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as Settings;
				expect(settings.theme).toBe("dark");
				expect(commandsIn(settings, "Stop").filter((command) => command === "./other-tool-stop.sh")).toHaveLength(1);
				const agxCommands = ["Stop", "SessionStart", "UserPromptSubmit"].map((event) => commandsIn(settings, event).filter((command) => command.includes("agx")));
				for (const commands of agxCommands) {
					expect(commands, `trial ${trial}`).toHaveLength(1);
				}
				const winnerWithProfile = agxCommands[0]?.[0]?.includes("--profile a") === true;
				expect(winnerWithProfile ? a.code : b.code, `trial ${trial}: the entries are from a run that did not succeed`).toBe(0);
				expect(readdirSync(join(home, ".claude"))).toEqual(["settings.json"]);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		}
		expect(bothSucceeded).toBe(0);
	}, 180_000);

	it(`${TRIALS} trials with three identical installs: all succeed and the file holds one set of entries`, async () => {
		for (let trial = 0; trial < TRIALS; trial++) {
			const home = freshHome();
			try {
				const runs = await Promise.all([1, 2, 3].map(() => start(home, ["link", "install", "--agent", "claude"])));
				for (const run of runs) {
					expect(run.code, `trial ${trial}: ${run.stderr}`).toBe(0);
				}
				const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as Settings;
				for (const event of ["Stop", "SessionStart", "UserPromptSubmit"]) {
					expect(commandsIn(settings, event).filter((command) => command.includes("agx")), `trial ${trial} ${event}`).toHaveLength(1);
				}
				expect(commandsIn(settings, "Stop")).toContain("./other-tool-stop.sh");
				expect(readdirSync(join(home, ".claude"))).toEqual(["settings.json"]);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		}
	}, 180_000);
});

/** A process number that belonged to a process that has ended. */
function deadPid(): number {
	const done = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
	return Number(done.stdout);
}

describe.skipIf(!existsSync(AGX))("agx link install: four installs at the same moment, with a lock a dead install left behind", () => {
	it(`${STALE_TRIALS} trials: exactly one install succeeds, none is lost without a word, the file is never torn`, async () => {
		const problems: string[] = [];
		for (let trial = 0; trial < STALE_TRIALS; trial++) {
			const home = freshHome();
			try {
				writeFileSync(join(home, ".claude", ".settings.json.agx-lock"), `${JSON.stringify({ pid: deadPid(), token: "left-by-an-install-that-died" })}\n`);
				const profiles = [undefined, "p1", "p2", "p3"];
				const runs = await Promise.all(
					profiles.map((profile) => start(home, [...(profile === undefined ? [] : ["--profile", profile]), "link", "install", "--agent", "claude"])),
				);
				const winners = runs.filter((run) => run.code === 0);
				if (winners.length !== 1) {
					problems.push(`trial ${trial}: ${winners.length} installs exited 0 (codes ${runs.map((run) => run.code).join(",")})`);
				}
				for (const run of runs.filter((other) => other.code !== 0)) {
					if (run.code !== 3) {
						problems.push(`trial ${trial}: a refused install exited ${run.code}: ${run.stderr.slice(0, 120)}`);
					}
				}
				let settings: Settings | undefined;
				try {
					settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as Settings;
				} catch {
					problems.push(`trial ${trial}: the file is not valid JSON`);
				}
				if (settings !== undefined) {
					if (settings.theme !== "dark" || !commandsIn(settings, "Stop").includes("./other-tool-stop.sh")) {
						problems.push(`trial ${trial}: the other tool's settings were lost`);
					}
					const stop = commandsIn(settings, "Stop").filter((command) => command.includes("agx"));
					const winnerIndex = runs.findIndex((run) => run.code === 0);
					const winnerProfile = profiles[winnerIndex];
					const wanted = `agx ${winnerProfile === undefined ? "" : `--profile ${winnerProfile} `}hook stop --host claude`;
					if (winners.length === 1 && (stop.length !== 1 || stop[0] !== wanted)) {
						problems.push(`trial ${trial}: the file does not hold the entries of the install that reported success`);
					}
				}
				const left = readdirSync(join(home, ".claude"));
				if (left.length !== 1 || left[0] !== "settings.json") {
					problems.push(`trial ${trial}: left behind: ${left.join(", ")}`);
				}
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		}
		// Printed in the failure message, so a run shows how many of the 100 went wrong.
		expect(problems.length, `${problems.length} problems in ${STALE_TRIALS} trials: ${problems.join(" | ")}`).toBe(0);
	}, 600_000);
});
