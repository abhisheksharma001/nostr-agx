import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { configError } from "./errors.js";
import { clearAbandoned } from "./lock.js";
import { configPath, ensureDir } from "./paths.js";

/**
 * A short lock around `config.json`'s read-modify-write.
 *
 * `config.json` is shared by every profile and every command. Without a lock, two
 * `agx` commands that overlap each read the same old file and the later write
 * drops the earlier one, with both exiting 0 — and a `deny` can be undone by an
 * `allow`. This is NOT the profile lock in `lock.ts`: that one is held for the whole
 * life of `serve`, `inbox`, `gateway` and `ui`, and `identity allow` must still work
 * while one of them runs. This one is held for the milliseconds a write takes.
 */

/** How long a writer waits for another one before it gives up. A holder normally lets go within milliseconds. */
export const CONFIG_LOCK_WAIT_MS = 5_000;
/** A lock file not touched for this long is abandoned, whatever its pid says: the section it guards takes milliseconds. */
export const CONFIG_LOCK_STALE_MS = 30_000;
const POLL_MS = 10;

interface LockRecord {
	pid: number;
	host: string;
	token: string;
}

export function configLockPath(): string {
	return `${configPath()}.lock`;
}

function readRecord(path: string): LockRecord | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const { pid, host, token } = parsed as Partial<LockRecord>;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
			return null;
		}
		return { pid, host: typeof host === "string" ? host : "", token: typeof token === "string" ? token : "" };
	} catch {
		return null;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** True when nobody is holding the lock: an empty file, a holder that has exited, or one nobody refreshed for too long. */
function abandoned(path: string, record: LockRecord | null): boolean {
	if (record === null) {
		return true;
	}
	try {
		if (Date.now() - statSync(path).mtimeMs > CONFIG_LOCK_STALE_MS) {
			return true;
		}
	} catch {
		return true;
	}
	if (record.host === "" || record.host === hostname()) {
		// Our own pid in a file we do not hold is an earlier life of this pid.
		return record.pid === process.pid || !isAlive(record.pid);
	}
	// Another host: a pid means nothing there, so only its age counts (above).
	return false;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Block this thread for `ms`. `updateProfile` and its callers are synchronous, so the wait must be too. */
function pause(ms: number): void {
	Atomics.wait(sleeper, 0, 0, ms);
}

function acquire(waitMs: number): () => void {
	const path = configLockPath();
	ensureDir(dirname(path));
	const token = randomUUID();
	const mine = `${path}.${process.pid}.${token.slice(0, 8)}`;
	writeFileSync(mine, `${JSON.stringify({ pid: process.pid, host: hostname(), token })}\n`, { mode: 0o600 });
	const deadline = Date.now() + waitMs;
	try {
		for (;;) {
			try {
				// A hard link is created whole or not at all, so no one ever sees a half-written lock.
				linkSync(mine, path);
				// A clearer that judged an older record may have removed this link already.
				if (readRecord(path)?.token === token) {
					return () => {
						if (readRecord(path)?.token === token) {
							rmSync(path, { force: true });
						}
					};
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw error;
				}
			}
			const holder = existsSync(path) ? readRecord(path) : null;
			if (abandoned(path, holder) && Date.now() < deadline) {
				clearAbandoned(path, holder);
				continue;
			}
			if (Date.now() >= deadline) {
				throw configError(
					`Could not take the config lock: another agx command has been writing ${configPath()} for more than ${Math.round(waitMs / 1000)} seconds.`,
					`If no other agx command is running, remove the lock and try again:\n    rm ${path}`,
				);
			}
			pause(POLL_MS);
		}
	} finally {
		rmSync(mine, { force: true });
	}
}

let depth = 0;

/**
 * Run `fn` while holding the config lock. Re-entrant within one process, so a
 * caller that already holds it can call `updateProfile` without waiting for itself.
 */
export function withConfigLock<T>(fn: () => T, options: { waitMs?: number } = {}): T {
	if (depth > 0) {
		return fn();
	}
	const release = acquire(options.waitMs ?? CONFIG_LOCK_WAIT_MS);
	depth = 1;
	try {
		return fn();
	} finally {
		depth = 0;
		release();
	}
}
