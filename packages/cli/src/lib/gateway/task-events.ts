import type { TaskStatusUpdate } from "@nostr-agx/core";

/** A buffered `working` update. The terminal event is not buffered: it is
 * read from the task operation store when it is written. */
export interface TaskStreamEvent {
	id: number;
	event: "working";
	data: Record<string, unknown>;
	/** UTF-8 bytes of `JSON.stringify(data)`. */
	bytes: number;
}

const MAX_EVENTS_PER_TASK = 128;
/** Buffered bytes per task. The largest event (2,000 escaped control
 * characters) is about 12 KB, so at least five always fit. */
export const MAX_TASK_STREAM_BYTES = 64 * 1024;
/** Buffered bytes across all tasks: 64 running background tasks at 64 KiB each.
 * A quarter of the operation store's 16 MiB. */
export const MAX_TASK_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_STREAMS = 1_000;
const STREAM_RETENTION_MS = 24 * 60 * 60 * 1000;

export class TaskEventStream {
	private readonly events: TaskStreamEvent[] = [];
	private nextId = 1;
	private terminalId: number | undefined;
	private size = 0;
	private touchedAt: number;
	private readonly listeners = new Set<() => void>();
	/** Set by the stream set that holds it, to keep the total budget. */
	owner?: { enforceBudget(): void };

	constructor(
		private readonly now: () => number = Date.now,
		private readonly maxBytes: number = MAX_TASK_STREAM_BYTES,
	) {
		this.touchedAt = now();
	}

	push(update: TaskStatusUpdate): void {
		if (this.terminalId !== undefined) {
			return;
		}
		const data = {
			status: update.status,
			seq: update.seq,
			...(update.message === undefined ? {} : { message: update.message }),
		};
		const bytes = Buffer.byteLength(JSON.stringify(data));
		this.events.push({ id: this.nextId, event: "working", data, bytes });
		this.nextId += 1;
		this.size += bytes;
		this.touchedAt = this.now();
		while (
			this.events.length > MAX_EVENTS_PER_TASK ||
			(this.size > this.maxBytes && this.events.length > 0)
		) {
			this.dropOldest();
		}
		this.owner?.enforceBudget();
		this.notify();
	}

	/** Ends the stream. Its terminal event takes the next ID, or `minId` if that
	 * is higher, so a stream recreated after a restart never gives a client a
	 * terminal ID it has already passed. */
	markTerminal(minId = 0): void {
		if (this.terminalId !== undefined) {
			return;
		}
		this.terminalId = Math.max(this.nextId, minId);
		this.nextId = this.terminalId + 1;
		this.touchedAt = this.now();
		this.notify();
	}

	after(lastEventId: number): TaskStreamEvent[] {
		this.touchedAt = this.now();
		return this.events.filter((event) => event.id > lastEventId);
	}

	isTerminal(): boolean {
		return this.terminalId !== undefined;
	}

	getTerminalId(): number | undefined {
		return this.terminalId;
	}

	bytes(): number {
		return this.size;
	}

	hasEvents(): boolean {
		return this.events.length > 0;
	}

	touched(): number {
		return this.touchedAt;
	}

	dropOldest(): boolean {
		const dropped = this.events.shift();
		if (!dropped) {
			return false;
		}
		this.size -= dropped.bytes;
		return true;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}

export interface TaskEventStreamsOptions {
	now?: () => number;
	maxStreams?: number;
	maxStreamBytes?: number;
	maxTotalBytes?: number;
	retentionMs?: number;
}

export class TaskEventStreams {
	private readonly streams = new Map<string, TaskEventStream>();
	private readonly now: () => number;
	private readonly maxStreams: number;
	private readonly maxStreamBytes: number;
	private readonly maxTotalBytes: number;
	private readonly retentionMs: number;

	constructor(options: TaskEventStreamsOptions = {}) {
		this.now = options.now ?? Date.now;
		this.maxStreams = options.maxStreams ?? MAX_STREAMS;
		this.maxStreamBytes = options.maxStreamBytes ?? MAX_TASK_STREAM_BYTES;
		this.maxTotalBytes = options.maxTotalBytes ?? MAX_TASK_EVENT_BYTES;
		this.retentionMs = options.retentionMs ?? STREAM_RETENTION_MS;
	}

	/** A stream not yet registered under an ID, for events that may arrive
	 * before the task's public ID is known. */
	create(): TaskEventStream {
		const stream = new TaskEventStream(this.now, this.maxStreamBytes);
		stream.owner = this;
		return stream;
	}

	ensure(id: string, initial?: TaskEventStream): TaskEventStream {
		this.prune();
		const existing = this.streams.get(id);
		if (existing) {
			return existing;
		}
		while (this.streams.size >= this.maxStreams) {
			const victim = this.oldest(true) ?? this.oldest(false);
			if (victim === undefined) {
				break;
			}
			this.streams.delete(victim);
		}
		const created = initial ?? this.create();
		created.owner = this;
		this.streams.set(id, created);
		this.enforceBudget();
		return created;
	}

	get(id: string): TaskEventStream | undefined {
		this.prune();
		return this.streams.get(id);
	}

	totalBytes(): number {
		let total = 0;
		for (const stream of this.streams.values()) {
			total += stream.bytes();
		}
		return total;
	}

	/** Drops buffered events until the total fits: first from the finished
	 * stream touched longest ago, then from the running stream holding most. */
	enforceBudget(): void {
		while (this.totalBytes() > this.maxTotalBytes) {
			let victim: TaskEventStream | undefined;
			for (const stream of this.streams.values()) {
				if (
					stream.isTerminal() &&
					stream.hasEvents() &&
					(victim === undefined || stream.touched() < victim.touched())
				) {
					victim = stream;
				}
			}
			if (victim === undefined) {
				for (const stream of this.streams.values()) {
					if (victim === undefined || stream.bytes() > victim.bytes()) {
						victim = stream;
					}
				}
			}
			if (!victim?.dropOldest()) {
				return;
			}
		}
	}

	private oldest(terminal: boolean): string | undefined {
		let found: { id: string; touched: number } | undefined;
		for (const [id, stream] of this.streams) {
			if (stream.isTerminal() !== terminal) {
				continue;
			}
			if (found === undefined || stream.touched() < found.touched) {
				found = { id, touched: stream.touched() };
			}
		}
		return found?.id;
	}

	private prune(): void {
		const cutoff = this.now() - this.retentionMs;
		for (const [id, stream] of this.streams) {
			if (stream.touched() <= cutoff) {
				this.streams.delete(id);
			}
		}
	}
}
