/** Local correlation needed to await a task result after requester restart.
 * No payload or secret belongs here. `key` is host-local and never goes on the wire. */
export interface PendingRequestRecord {
	key: string;
	taskId: string;
	peer: string;
	capability: string;
	deadlineAt: number | null;
	phase: "publishing" | "waiting";
}

/** Single-writer storage for outbound requests. A failed write must reject. */
export interface PendingRequestStore {
	list(): PendingRequestRecord[] | Promise<PendingRequestRecord[]>;
	save(record: PendingRequestRecord): void | Promise<void>;
	remove(key: string): void | Promise<void>;
}

export interface RecoveredPendingRequest {
	key: string;
	taskId: string;
	result: Promise<unknown>;
}

/** Publication may have happened, but the process stopped before recording it. */
export class AgxRequestUnknownError extends Error {
	readonly code = "result_unknown";

	constructor() {
		super("AGX request outcome unknown");
		this.name = "AgxRequestUnknownError";
	}
}

/** Durable correlation could not be written or removed safely. `mayHavePublished`
 * is false only when the first write failed, so the task was never sent. */
export class AgxPendingRequestStoreError extends Error {
	readonly code = "pending_request_store_failed";
	readonly mayHavePublished: boolean;

	constructor(options: { mayHavePublished?: boolean } = {}) {
		super("AGX request storage failed");
		this.name = "AgxPendingRequestStoreError";
		this.mayHavePublished = options.mayHavePublished ?? true;
	}
}
