import { AgxCliError, EXIT } from "../lib/errors.js";
import { runInboxCommand } from "./inbox.js";

export interface WaitOptions {
	profile?: string;
	timeout?: string;
	summary?: boolean;
	verbose?: boolean;
	/** Host-owned cancellation; not a CLI option. */
	signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TIMEOUT_SEC = 3600;

function parseTimeout(value: string | undefined): number {
	if (value === undefined) {
		return DEFAULT_TIMEOUT_SEC;
	}
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SEC) {
		throw new AgxCliError(`--timeout must be a number of seconds from 1 to 3600, got "${value}".`, {
			exitCode: EXIT.usage,
		});
	}
	return seconds;
}

/** Wait for one inbox activity batch, print it, release the profile lock and exit. */
export async function waitCommand(options: WaitOptions): Promise<void> {
	const timeoutSec = parseTimeout(options.timeout);
	let controller: AbortController | undefined;
	const signal = options.signal ?? (controller = new AbortController()).signal;
	const interrupt = () => controller?.abort();
	if (!options.signal) {
		process.once("SIGINT", interrupt);
		process.once("SIGTERM", interrupt);
	}
	try {
		await runInboxCommand({
			profile: options.profile,
			summary: options.summary,
			verbose: options.verbose,
		}, {
			activity: true,
			timeoutSec,
			signal,
		});
	} finally {
		if (!options.signal) {
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", interrupt);
		}
	}
}
