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
	// `declare` so no empty `code`/`retryable`/`details` keys appear on an error
	// that was not given them. These are for reading locally; what is SENT is
	// the copy the constructor kept (see `publicErrorFieldsToSend`), so setting
	// one of these later, or in a subclass, does not change what the peer gets.
	/** A machine-readable reason a workflow can branch on, when one was given. */
	declare readonly code?: AgxPublicErrorCode;
	/** Whether the same request may succeed if sent again, when stated. */
	declare readonly retryable?: boolean;
	/** Small public facts about the failure: a frozen copy of what was given. */
	declare readonly details?: AgxErrorDetails;

	/**
	 * `options` is optional and everything in it crosses the trust boundary, so
	 * it is checked here: a bad `code` or `details` throws a `TypeError` in the
	 * handler, which the peer sees only as the generic `handler failed`. Only
	 * what passes this check is ever sent.
	 */
	constructor(message: string, options?: AgxPublicErrorOptions | null) {
		super(message);
		this.name = "AgxPublicError";
		// Read each option once, so a getter cannot pass the check with one value
		// and then hand over another.
		const { code, retryable, details } = options ?? {};
		const accepted: AgxPublicErrorOptions = {};
		if (code !== undefined) {
			if (!isAgxPublicErrorCode(code)) {
				throw new TypeError(
					`AgxPublicError code must be one of ${AGX_ERROR_CODES.join(", ")} or a namespaced code such as "acme.rate_limited"`,
				);
			}
			accepted.code = code;
			this.code = code;
		}
		if (retryable !== undefined) {
			if (typeof retryable !== "boolean") {
				throw new TypeError("AgxPublicError retryable must be a boolean");
			}
			accepted.retryable = retryable;
			this.retryable = retryable;
		}
		if (details !== undefined) {
			const checked = checkedErrorDetails(details);
			if ("problem" in checked) {
				throw new TypeError(`AgxPublicError details ${checked.problem}`);
			}
			accepted.details = checked.value;
			this.details = checked.value;
		}
		fieldsToSend.set(this, Object.freeze(accepted));
	}
}

/**
 * What each `AgxPublicError` constructor accepted. Kept outside the error
 * object, and written only by the constructor, so a subclass field, a later
 * assignment or a getter on the error cannot change what crosses the trust
 * boundary.
 */
const fieldsToSend = new WeakMap<AgxPublicError, Readonly<AgxPublicErrorOptions>>();

/** The structured fields to send for `error`: only what its constructor
 * checked and accepted, or none. */
export function publicErrorFieldsToSend(
	error: AgxPublicError,
): Readonly<AgxPublicErrorOptions> {
	return fieldsToSend.get(error) ?? {};
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

/** True for a code in the closed set or a well-formed namespaced code. A
 * namespace may not be a closed-set word, so `busy.later` is refused: it would
 * read as `busy` to anything that looks only at the first segment. */
export function isAgxPublicErrorCode(code: unknown): code is AgxPublicErrorCode {
	if (typeof code !== "string" || code.length > MAX_ERROR_CODE_CHARS) {
		return false;
	}
	if ((AGX_ERROR_CODES as readonly string[]).includes(code)) {
		return true;
	}
	return (
		NAMESPACED_CODE.test(code) &&
		!(AGX_ERROR_CODES as readonly string[]).includes(code.split(".")[0])
	);
}

/**
 * A validated, frozen copy of `details`, or the reason it cannot cross the
 * trust boundary. The copy is what gets checked and what gets used, so an
 * object changed after the check, or one with getters that answer differently
 * the second time, cannot get past it.
 */
export function checkedErrorDetails(
	details: unknown,
): { value: AgxErrorDetails } | { problem: string } {
	if (typeof details !== "object" || details === null || Array.isArray(details)) {
		return { problem: "must be a plain object" };
	}
	const proto = Object.getPrototypeOf(details);
	if (proto !== Object.prototype && proto !== null) {
		return { problem: "must be a plain object" };
	}
	const entries = Object.entries(details);
	if (entries.length > MAX_ERROR_DETAIL_KEYS) {
		return { problem: `may have at most ${MAX_ERROR_DETAIL_KEYS} keys` };
	}
	for (const [key, value] of entries) {
		if (key.length === 0 || key.length > MAX_ERROR_DETAIL_KEY_CHARS) {
			return { problem: `keys must be 1 to ${MAX_ERROR_DETAIL_KEY_CHARS} characters` };
		}
		if (key === "__proto__") {
			return { problem: 'may not use the key "__proto__"' };
		}
		if (typeof value === "string") {
			if (value.length > MAX_ERROR_DETAIL_VALUE_CHARS) {
				return {
					problem: `string values may be at most ${MAX_ERROR_DETAIL_VALUE_CHARS} characters`,
				};
			}
		} else if (typeof value === "number") {
			if (!Number.isFinite(value)) {
				return { problem: "numbers must be finite" };
			}
		} else if (typeof value !== "boolean") {
			return { problem: "values must be strings, numbers or booleans" };
		}
	}
	return { value: Object.freeze(Object.fromEntries(entries)) as AgxErrorDetails };
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
	// Read each field once: the check and the copy must see the same value.
	const { code, retryable, details } = raw;
	const out: AgxPublicErrorOptions = {};
	if (isAgxPublicErrorCode(code)) {
		out.code = code;
	}
	if (typeof retryable === "boolean") {
		out.retryable = retryable;
	}
	if (details !== undefined) {
		const checked = checkedErrorDetails(details);
		if ("value" in checked) {
			out.details = checked.value;
		}
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
	declare readonly code?: AgxPublicErrorCode;
	declare readonly retryable?: boolean;
	declare readonly details?: AgxErrorDetails;

	constructor(message: string, fields: AgxPublicErrorOptions = {}) {
		super(message);
		this.name = "AgxTaskFailedError";
		if (fields.code !== undefined) {
			this.code = fields.code;
		}
		if (fields.retryable !== undefined) {
			this.retryable = fields.retryable;
		}
		if (fields.details !== undefined) {
			this.details = fields.details;
		}
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
