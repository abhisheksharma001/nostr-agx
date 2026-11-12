import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_SEEN_RETENTION_SEC, type SeenStore } from "@nostr-agx/core";
import { z } from "zod";
import { AgxCliError, EXIT } from "./errors.js";
import { seenPath, statePath, writePrivateJson, writePrivateText } from "./paths.js";

/**
 * Durable poll state for `agx serve`.
 *
 * The transport re-delivers its whole poll window on every poll by design — the
 * 120-second overlap plus the two-day NIP-59 backdate lookback — so without a
 * persisted `SeenStore` a restart re-runs handlers for messages that were already
 * answered. And without a persisted cursor a restart re-drains the
 * whole inbox from zero. Both files are written atomically after each poll.
 */

const stateSchema = z.object({
	version: z.literal(1).default(1),
	/** Unix seconds. 0 means "drain everything". */
	cursor: z.number().default(0),
	lastPumpAt: z.string().nullable().default(null),
	advertisedAt: z.string().nullable().default(null),
	listingId: z.string().nullable().default(null),
	listingSlug: z.string().nullable().default(null),
	stats: z
		.object({
			received: z.number().default(0),
			replied: z.number().default(0),
			denied: z.number().default(0),
			tasks: z.number().default(0),
		})
		.default({ received: 0, replied: 0, denied: 0, tasks: 0 }),
});

export type AgxState = z.infer<typeof stateSchema>;

/**
 * The file could not be used, and agx will not replace it. The poll cursor and
 * the replay memory live in these files: an empty one in their place re-drains
 * the inbox and runs handlers again for messages already answered, and the next
 * save would overwrite a file a newer agx wrote.
 */
function unreadableStateFile(path: string, why: string): AgxCliError {
	return new AgxCliError(
		`${path} could not be read (${why}), so agx stopped rather than start from an empty one.`,
		{
			exitCode: EXIT.config,
			remediation: `If it is damaged, move it aside (mv "${path}" "${path}.bad") and run agx again; it starts empty, which re-reads the inbox. If a newer agx wrote it, use that agx.`,
		},
	);
}

/** Read and parse a state file that exists; a file that is not JSON names itself. */
function readStateJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw unreadableStateFile(
			path,
			error instanceof Error ? error.message : "unreadable",
		);
	}
}

export function loadState(profile: string): AgxState {
	const path = statePath(profile);
	if (!existsSync(path)) {
		return stateSchema.parse({});
	}
	const parsed = stateSchema.safeParse(readStateJson(path));
	if (!parsed.success) {
		throw unreadableStateFile(path, "unexpected contents or a newer version");
	}
	return parsed.data;
}

export function saveState(profile: string, state: AgxState): void {
	writePrivateJson(statePath(profile), state);
}

export function updateState(
	profile: string,
	patch: Partial<AgxState>,
): AgxState {
	const next = { ...loadState(profile), ...patch };
	saveState(profile, next);
	return next;
}

const seenEntrySchema = z.object({ id: z.string(), seenAt: z.number() });

/** v2: each id with the time it was recorded, so retention is by age. */
const seenSchemaV2 = z.object({
	version: z.literal(2),
	entries: z.array(seenEntrySchema).default([]),
	failures: z.record(z.string(), z.number()).default({}),
});

/** v1 (count-bounded, no timestamps). Read once and upgraded on the next flush. */
const seenSchemaV1 = z.object({
	version: z.literal(1).default(1),
	ids: z.array(z.string()).default([]),
	failures: z.record(z.string(), z.number()).default({}),
});

/** Memory/disk guard only — retention is `DEFAULT_SEEN_RETENTION_SEC`, the same
 * time window as `InMemorySeenStore`'s. Evicting an id still inside the poll
 * window re-delivers it, so this sits far above what that window holds. */
const MAX_SEEN = 200_000;

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * File-backed replay protection. Single-writer by construction — `agx serve`
 * takes a per-profile lock — which is what `SeenStore`'s check-then-act contract
 * requires. `hasMany` is implemented so a poll costs one lookup pass rather than
 * one per event.
 *
 * Ids are kept by AGE: the poll window is a time span (two days of NIP-59
 * backdate), and a count-bounded list evicted history that was still inside it —
 * each gift-wrapped event records two ids, and junk wraps take slots too.
 */
export class FileSeenStore implements SeenStore {
	private readonly path: string;
	/** id -> recorded-at (unix seconds); insertion order is time order. */
	private seenAt: Map<string, number>;
	private failures: Record<string, number>;
	private dirty = false;
	/** The host's poll cursor (unix seconds); see {@link holdFor}. */
	private cursor: number;

	constructor(profile: string) {
		this.path = seenPath(profile);
		this.cursor = loadState(profile).cursor;
		if (!existsSync(this.path)) {
			this.seenAt = new Map();
			this.failures = {};
			return;
		}
		const raw = readStateJson(this.path);
		const v2 = seenSchemaV2.safeParse(raw);
		if (v2.success) {
			this.seenAt = new Map(v2.data.entries.map((e) => [e.id, e.seenAt]));
			this.failures = v2.data.failures;
			return;
		}
		const v1 = seenSchemaV1.safeParse(raw);
		if (!v1.success) {
			throw unreadableStateFile(
				this.path,
				"unexpected contents or a newer version",
			);
		}
		const data = v1.data;
		// v1 kept no timestamps: treat every id as recorded now, which keeps it
		// for a full retention window rather than risk re-delivering it.
		const loadedAt = nowSec();
		this.seenAt = new Map(data.ids.map((id) => [id, loadedAt]));
		this.failures = data.failures;
		this.dirty = data.ids.length > 0;
	}

	/**
	 * Polls reach back from the host's cursor, which stays put while a relay
	 * does not answer (a poll that may have missed events must not move it).
	 * Ids are kept for the retention window counted from the cursor whenever it
	 * is behind, so a relay that is down for days does not make the store
	 * forget events the poll still returns, and run them again.
	 */
	holdFor(cursor: number): void {
		this.cursor = cursor;
	}

	private cutoff(now: number): number {
		return (this.cursor > 0 ? Math.min(now, this.cursor) : now) - DEFAULT_SEEN_RETENTION_SEC;
	}

	private live(id: string, now = nowSec()): boolean {
		const at = this.seenAt.get(id);
		return at !== undefined && at > this.cutoff(now);
	}

	private prune(now: number): void {
		const cutoff = this.cutoff(now);
		for (const [id, at] of this.seenAt) {
			if (at > cutoff && this.seenAt.size <= MAX_SEEN) {
				break;
			}
			this.seenAt.delete(id);
			this.dirty = true;
		}
	}

	has(id: string): boolean {
		return this.live(id);
	}

	hasMany(ids: string[]): Set<string> {
		const now = nowSec();
		const hits = new Set<string>();
		for (const id of ids) {
			if (this.live(id, now)) {
				hits.add(id);
			}
		}
		return hits;
	}

	add(id: string): void {
		const now = nowSec();
		if (!this.live(id, now)) {
			this.seenAt.delete(id);
			this.seenAt.set(id, now);
			this.dirty = true;
		}
		// Handled, or dead-lettered: its failure count has done its job.
		if (id in this.failures) {
			delete this.failures[id];
			this.dirty = true;
		}
		this.prune(now);
	}

	/** In-memory like `add`; the file is written once per poll by `flush()`. */
	addMany(ids: string[]): void {
		for (const id of ids) {
			this.add(id);
		}
	}

	recordFailure(id: string): number {
		const next = (this.failures[id] ?? 0) + 1;
		this.failures[id] = next;
		this.dirty = true;
		return next;
	}

	/** Persist only when something changed — a quiet poll writes nothing. */
	flush(): void {
		if (!this.dirty) {
			return;
		}
		// Compact: a busy agent keeps tens of thousands of ids here, and the
		// file is rewritten on every poll that handled something.
		writePrivateText(
			this.path,
			`${JSON.stringify({
				version: 2,
				entries: Array.from(this.seenAt, ([id, seenAt]) => ({
					id,
					seenAt,
				})),
				failures: this.failures,
			})}\n`,
		);
		this.dirty = false;
	}
}
