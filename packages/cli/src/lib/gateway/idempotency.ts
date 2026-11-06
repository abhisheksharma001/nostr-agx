import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { gatewayTaskOperationsPath, writePrivateJson } from "../paths.js";
import { ApiError } from "./http.js";

export const TASK_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_IDEMPOTENCY_KEY_CHARS = 255;
const MAX_TASK_OPERATIONS = 1_000;

const outcomeSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("success"),
		body: z.record(z.string(), z.unknown()),
	}),
	z.object({
		kind: z.literal("error"),
		status: z.number().int(),
		code: z.string(),
		message: z.string(),
		description: z.string().optional(),
	}),
]);
const operationSchema = z.object({
	id: z.string().regex(/^[0-9a-f]{64}$/),
	fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
	outcome: outcomeSchema.nullable(),
});
const fileSchema = z.object({
	version: z.literal(1),
	operations: z.array(operationSchema).default([]),
});

type Outcome = z.infer<typeof outcomeSchema>;
type Operation = z.infer<typeof operationSchema>;

export interface TaskIdempotencyOptions {
	now?: () => number;
	retentionMs?: number;
}

function unknownOutcome(): Outcome {
	return {
		kind: "error",
		status: 409,
		code: "result_unknown",
		message: "The gateway stopped before this task's outcome was recorded",
		description: "The remote agent may have executed the task. Check its effects before submitting new work with a different idempotency key.",
	};
}

function errorOutcome(error: unknown): Outcome {
	if (error instanceof ApiError) {
		return {
			kind: "error",
			status: error.status,
			code: error.code,
			message: error.message,
			...(error.description ? { description: error.description } : {}),
		};
	}
	return {
		kind: "error",
		status: 500,
		code: "internal_error",
		message: "The gateway could not complete the request",
	};
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function hash(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function parseIdempotencyKey(value: string | string[] | undefined): string | null {
	if (value === undefined) {
		return null;
	}
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_IDEMPOTENCY_KEY_CHARS ||
		!/^[!-~]+$/.test(value)
	) {
		throw new ApiError(
			400,
			"invalid_idempotency_key",
			`Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_CHARS} visible ASCII characters without whitespace`,
		);
	}
	return value;
}

/** Durable idempotent outcomes for POST /v1/tasks. The profile lock makes this
 * a single-writer store; callers sharing an operation also share its promise. */
export class TaskIdempotencyStore {
	private readonly path: string;
	private readonly now: () => number;
	private readonly retentionMs: number;
	private readonly records: Map<string, Operation>;
	private readonly inFlight = new Map<string, Promise<Record<string, unknown>>>();
	private closed = false;

	constructor(profile: string, options: TaskIdempotencyOptions = {}) {
		this.path = gatewayTaskOperationsPath(profile);
		this.now = options.now ?? Date.now;
		this.retentionMs = options.retentionMs ?? TASK_IDEMPOTENCY_RETENTION_MS;
		const raw: unknown = existsSync(this.path)
			? JSON.parse(readFileSync(this.path, "utf8"))
			: { version: 1, operations: [] };
		const parsed = fileSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(`${this.path} is not a gateway task-operation file this version can read`);
		}
		this.records = new Map(parsed.data.operations.map((operation) => [operation.id, operation]));
		let changed = this.prune();
		for (const operation of this.records.values()) {
			if (operation.outcome === null) {
				operation.outcome = unknownOutcome();
				operation.updatedAt = this.now();
				changed = true;
			}
		}
		if (changed) {
			this.persist();
		}
	}

	async execute(
		credential: string,
		key: string,
		body: unknown,
		operation: () => Promise<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		if (this.closed) {
			throw new ApiError(503, "gateway_stopping", "The gateway is stopping");
		}
		if (this.prune()) {
			this.persist();
		}
		const id = hash(`POST /v1/tasks\0${credential}\0${key}`);
		const fingerprint = hash(canonicalJson(body));
		const existing = this.records.get(id);
		if (existing) {
			if (existing.fingerprint !== fingerprint) {
				throw new ApiError(
					409,
					"idempotency_key_reused",
					"This idempotency key was already used with a different task request",
					"Use a new key for different work, or the original request body to retrieve its outcome.",
				);
			}
			const running = this.inFlight.get(id);
			if (running) {
				return running;
			}
			if (existing.outcome === null) {
				existing.outcome = unknownOutcome();
				existing.updatedAt = this.now();
				this.persist();
			}
			return this.replay(existing);
		}
		if (this.records.size >= MAX_TASK_OPERATIONS) {
			throw new ApiError(
				503,
				"idempotency_store_full",
				`The gateway already retains ${MAX_TASK_OPERATIONS} task outcomes`,
				"Retry after older outcomes expire, or submit without an idempotency key if duplicate execution is safe.",
			);
		}
		const created = {
			id,
			fingerprint,
			createdAt: this.now(),
			updatedAt: this.now(),
			outcome: null,
		} satisfies Operation;
		this.records.set(id, created);
		try {
			this.persist();
		} catch (error) {
			this.records.delete(id);
			throw error;
		}
		const running = this.perform(created, operation);
		this.inFlight.set(id, running);
		try {
			return await running;
		} finally {
			if (this.inFlight.get(id) === running) {
				this.inFlight.delete(id);
			}
		}
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		let changed = false;
		for (const operation of this.records.values()) {
			if (operation.outcome === null) {
				operation.outcome = unknownOutcome();
				operation.updatedAt = this.now();
				changed = true;
			}
		}
		if (changed) {
			this.persist();
		}
	}

	private async perform(
		operation: Operation,
		run: () => Promise<Record<string, unknown>>,
	): Promise<Record<string, unknown>> {
		let unexpected: unknown;
		let failed = false;
		try {
			operation.outcome = { kind: "success", body: await run() };
		} catch (error) {
			failed = true;
			unexpected = error;
			operation.outcome = errorOutcome(error);
		}
		operation.updatedAt = this.now();
		if (!this.closed && this.records.get(operation.id) === operation) {
			try {
				this.persist();
			} catch {
				operation.outcome = unknownOutcome();
				operation.updatedAt = this.now();
				throw new ApiError(
					500,
					"idempotency_store_failed",
					"The task finished, but its outcome could not be stored",
					"Do not retry with a different key until you have checked whether the remote agent executed the task.",
				);
			}
		}
		if (failed && !(unexpected instanceof ApiError)) {
			throw unexpected;
		}
		return this.replay(operation);
	}

	private replay(operation: Operation): Record<string, unknown> {
		const outcome = operation.outcome ?? unknownOutcome();
		if (outcome.kind === "success") {
			return outcome.body;
		}
		throw new ApiError(outcome.status, outcome.code, outcome.message, outcome.description);
	}

	private prune(): boolean {
		const cutoff = this.now() - this.retentionMs;
		let changed = false;
		for (const [id, operation] of this.records) {
			if (operation.updatedAt <= cutoff) {
				this.records.delete(id);
				changed = true;
			}
		}
		return changed;
	}

	private persist(): void {
		writePrivateJson(this.path, {
			version: 1,
			operations: Array.from(this.records.values()),
		});
	}
}
