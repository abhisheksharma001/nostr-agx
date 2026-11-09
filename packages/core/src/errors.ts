/**
 * A task-handler error whose message is SAFE to send across the trust boundary to
 * the requesting peer. By default a thrown handler error is reported to the peer
 * as a generic "handler failed" (and the real message logged locally), so an
 * internal error — a driver/ORM/HTTP failure carrying hostnames, table names, or
 * connection strings — never leaks to another org. Throw `AgxPublicError` when you
 * intend the message to be part of the protocol contract (e.g. "invoice not
 * found", "amount exceeds limit").
 *
 *   agx.handle("invoice.review", (t) => {
 *     if (!found) throw new AgxPublicError("invoice not found");
 *     ...
 *   });
 */
export class AgxPublicError extends Error {
	/** A machine-readable reason a workflow can branch on, when one was given. */
	readonly code?: AgxPublicErrorCode;
	/** Whether the same request may succeed if sent again, when stated. */
	readonly retryable?: boolean;
	/** Small public facts about the failure, when given. */
	readonly details?: AgxErrorDetails;

	/**
	 * `options` is optional and everything in it crosses the trust boundary, so
	 * it is checked here: a bad `code` or `details` throws a `TypeError` in the
	 * handler, which the peer sees only as the generic `handler failed`.
	 */
	constructor(message: string, options: AgxPublicErrorOptions = {}) {
		super(message);
		this.name = "AgxPublicError";
		if (options.code !== undefined) {
			if (!isAgxPublicErrorCode(options.code)) {
				throw new TypeError(
					`AgxPublicError code must be one of ${AGX_ERROR_CODES.join(", ")} or a namespaced code such as "acme.rate_limited"`,
				);
			}
			this.code = options.code;
		}
		if (options.retryable !== undefined) {
			if (typeof options.retryable !== "boolean") {
				throw new TypeError("AgxPublicError retryable must be a boolean");
			}
			this.retryable = options.retryable;
		}
		if (options.details !== undefined) {
			const problem = agxErrorDetailsProblem(options.details);
			if (problem) {
				throw new TypeError(`AgxPublicError details ${problem}`);
			}
			this.details = options.details;
		}
	}
}

/** The reasons a task can fail that every AGX implementation understands. */
export const AGX_ERROR_CODES = [
	"busy",
	"timeout",
	"invalid_input",
	"unavailable",
	"input_invalid",
] as const;
export type AgxErrorCode = (typeof AGX_ERROR_CODES)[number];

/** A code specific to one implementation or organisation. It must carry a
 * dotted namespace (`acme.rate_limited`) so it can never be mistaken for, or
 * collide with, a code from the closed set above. */
export type AgxNamespacedErrorCode = `${string}.${string}`;
export type AgxPublicErrorCode = AgxErrorCode | AgxNamespacedErrorCode;

/** Public facts about a failure: a few short scalars, never nested data. */
export type AgxErrorDetails = Record<string, string | number | boolean>;

export interface AgxPublicErrorOptions {
	code?: AgxPublicErrorCode;
	retryable?: boolean;
	details?: AgxErrorDetails;
}

export const MAX_ERROR_CODE_CHARS = 64;
export const MAX_ERROR_DETAIL_KEYS = 8;
export const MAX_ERROR_DETAIL_KEY_CHARS = 64;
export const MAX_ERROR_DETAIL_VALUE_CHARS = 200;

const NAMESPACED_CODE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;

/** True for a code in the closed set or a well-formed namespaced code. */
export function isAgxPublicErrorCode(code: unknown): code is AgxPublicErrorCode {
	if (typeof code !== "string" || code.length > MAX_ERROR_CODE_CHARS) {
		return false;
	}
	return (
		(AGX_ERROR_CODES as readonly string[]).includes(code) ||
		NAMESPACED_CODE.test(code)
	);
}

/** Why `details` cannot cross the trust boundary, or null when it can. */
export function agxErrorDetailsProblem(details: unknown): string | null {
	if (
		typeof details !== "object" ||
		details === null ||
		Array.isArray(details) ||
		Object.getPrototypeOf(details) !== Object.prototype
	) {
		return "must be a plain object";
	}
	const entries = Object.entries(details);
	if (entries.length > MAX_ERROR_DETAIL_KEYS) {
		return `may have at most ${MAX_ERROR_DETAIL_KEYS} keys`;
	}
	for (const [key, value] of entries) {
		if (key.length === 0 || key.length > MAX_ERROR_DETAIL_KEY_CHARS) {
			return `keys must be 1 to ${MAX_ERROR_DETAIL_KEY_CHARS} characters`;
		}
		if (typeof value === "string") {
			if (value.length > MAX_ERROR_DETAIL_VALUE_CHARS) {
				return `string values may be at most ${MAX_ERROR_DETAIL_VALUE_CHARS} characters`;
			}
		} else if (typeof value === "number") {
			if (!Number.isFinite(value)) {
				return "numbers must be finite";
			}
		} else if (typeof value !== "boolean") {
			return "values must be strings, numbers or booleans";
		}
	}
	return null;
}

/**
 * The structured part of a peer's `failed` result, with anything that does not
 * meet the limits above dropped. A peer controls these fields, so a bad one is
 * ignored rather than trusted — the `error` message still arrives.
 */
export function readPublicErrorFields(raw: {
	code?: unknown;
	retryable?: unknown;
	details?: unknown;
}): AgxPublicErrorOptions {
	const out: AgxPublicErrorOptions = {};
	if (isAgxPublicErrorCode(raw.code)) {
		out.code = raw.code;
	}
	if (typeof raw.retryable === "boolean") {
		out.retryable = raw.retryable;
	}
	if (raw.details !== undefined && agxErrorDetailsProblem(raw.details) === null) {
		out.details = raw.details as AgxErrorDetails;
	}
	return out;
}

/**
 * What a requester's `request()` rejects with when the peer reports a failure.
 * It is an ordinary `Error` whose message is the peer's `error` text, so code
 * that only reads `.message` is unaffected; a workflow can also branch on
 * `code` and `retryable`. All three are claims the peer made, not facts.
 */
export class AgxTaskFailedError extends Error {
	readonly code?: AgxPublicErrorCode;
	readonly retryable?: boolean;
	readonly details?: AgxErrorDetails;

	constructor(message: string, fields: AgxPublicErrorOptions = {}) {
		super(message);
		this.name = "AgxTaskFailedError";
		this.code = fields.code;
		this.retryable = fields.retryable;
		this.details = fields.details;
	}
}

/**
 * Thrown by a task handler to leave a task unanswered: no result goes back, not
 * even a failure, and the task is recorded as handled so this client does not
 * run it again. For a host that runs the same identity in more than one place
 * and finds, once the handler has started, that the task is another
 * instance's to answer. The requester hears nothing from THIS client, so
 * decline only a task something else will answer.
 */
export class AgxTaskDeclined extends Error {
	constructor(reason = "task declined") {
		super(reason);
		this.name = "AgxTaskDeclined";
	}
}

/**
 * A message body over {@link MAX_BODY} characters, thrown by
 * `buildExchangePayload` rather than silently shortening it.
 *
 * This is a BACKSTOP, not the intended failure path. Every caller that can
 * produce a user-facing result checks the length first and reports it cleanly —
 * `AgxClient.fitsWire`, `NostrTransport.publishMessage`, `egress.ts`. Reaching
 * this throw means one of them was bypassed, which is exactly when a loud
 * failure beats a body delivered with its tail missing.
 */
export class AgxBodyTooLongError extends Error {
	constructor(public readonly chars: number) {
		super(
			`AGX message body is too long (${chars} characters). Callers must check the limit and report it; reaching this means the body would otherwise have been truncated silently.`,
		);
		this.name = "AgxBodyTooLongError";
	}
}

/**
 * `evidence` that does not fit the wire schema (too many records or fields, a
 * value too long, a time that is not ISO 8601), thrown by
 * `buildExchangePayload`. A receiver would drop such evidence whole, so it is
 * refused at the sender instead of shipping a claim nobody can read.
 *
 * Like {@link AgxBodyTooLongError}, a BACKSTOP: `NostrTransport.publishMessage`
 * checks with `exchangeEvidenceProblem` first and returns `ok: false`.
 */
export class AgxEvidenceInvalidError extends Error {
	constructor(public readonly problem: string) {
		super(`AGX message evidence is invalid: ${problem}`);
		this.name = "AgxEvidenceInvalidError";
	}
}
