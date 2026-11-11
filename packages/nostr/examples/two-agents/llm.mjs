/**
 * The bridge from an AGX agent to a LOCAL LLM: the smallest OpenAI-compatible
 * chat-completions client that works, using the platform fetch (Node 20+ —
 * no new dependency). Point it at anything that speaks /v1/chat/completions:
 *
 *   Ollama      AGX_LLM_BASE_URL=http://127.0.0.1:11434/v1   (the default)
 *               AGX_LLM_MODEL=<name from `ollama list`>
 *   llama.cpp   llama-server's port (8080): AGX_LLM_BASE_URL=http://127.0.0.1:8080/v1
 *   LM Studio   AGX_LLM_BASE_URL=http://127.0.0.1:1234/v1
 *   vLLM        AGX_LLM_BASE_URL=http://127.0.0.1:8000/v1
 *
 * `AGX_LLM_API_KEY` is sent as a bearer token when set; Ollama and llama.cpp
 * ignore it, so it is safe to leave unset locally.
 *
 * Everything here is deliberately primitive: system+user messages in, one
 * completion string out. Structured output is handled by prompt discipline
 * (short first-line protocols like "ASK: …"), because small local models are
 * far more reliable at that than at strict JSON.
 */

export const LLM_BASE_URL =
	process.env.AGX_LLM_BASE_URL ?? "http://127.0.0.1:11434/v1";
const LLM_API_KEY = process.env.AGX_LLM_API_KEY;

const headers = () =>
	LLM_API_KEY ? { authorization: `Bearer ${LLM_API_KEY}` } : {};

/** Cheap liveness probe (GET /v1/models). Never loads a model. NOTE: this
 * succeeds on an Ollama with no models pulled — see resolveLlmSetup(). */
export async function llmReachable(timeoutMs = 3_000) {
	try {
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), timeoutMs);
		timer.unref();
		const res = await fetch(`${LLM_BASE_URL}/models`, {
			signal: abort.signal,
			headers: headers(),
		});
		clearTimeout(timer);
		return res.ok;
	} catch {
		return false;
	}
}

/** The server's installed model ids, e.g. ["llama3.2:latest", "qwen3:4b"].
 * Empty when the list is missing, unreadable, or the server has none. */
export async function listModels(timeoutMs = 5_000) {
	try {
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), timeoutMs);
		timer.unref();
		const res = await fetch(`${LLM_BASE_URL}/models`, {
			signal: abort.signal,
			headers: headers(),
		});
		clearTimeout(timer);
		if (!res.ok) {
			return [];
		}
		const body = await res.json();
		const data = body?.models ?? body?.data;
		if (!Array.isArray(data)) {
			return [];
		}
		return data
			.map((entry) => (typeof entry?.name === "string" ? entry.name : entry?.id))
			.filter((id) => typeof id === "string" && id.length > 0);
	} catch {
		return [];
	}
}

/**
 * Startup check shared by both agents. A reachable server is NOT enough —
 * Ollama answers a request for an uninstalled model with HTTP 404 (and GET
 * /v1/models succeeds on an empty server), so the model must be verified
 * against the server's list. Returns `{ ready: true, model }` only when a
 * model will actually answer; otherwise `{ ready: false, model: null }` after
 * logging exactly why and what to do about it.
 *
 * `AGX_LLM_MODEL` picks the model explicitly; unset, the first one the
 * server lists is used.
 */
export async function resolveLlmSetup(log) {
	if (!(await llmReachable())) {
		log(
			`LLM: none reachable at ${LLM_BASE_URL} — running on the canned policy (decisions will say so)`,
		);
		return { ready: false, model: null };
	}
	const models = await listModels();
	if (models.length === 0) {
		log(
			`LLM: ${LLM_BASE_URL} is reachable but has NO models installed — pull one (e.g. \`ollama pull llama3.2\`) and restart this agent; running on the canned policy meanwhile`,
		);
		return { ready: false, model: null };
	}
	const wanted = process.env.AGX_LLM_MODEL ?? models[0];
	if (!models.includes(wanted)) {
		log(
			`LLM: model "${wanted}" is not installed — this server has: ${models.join(", ")}. Pull it (\`ollama pull ${wanted}\`) or set AGX_LLM_MODEL to one of those; running on the canned policy meanwhile`,
		);
		return { ready: false, model: null };
	}
	log(
		`LLM: ${LLM_BASE_URL} model ${wanted}${process.env.AGX_LLM_MODEL ? "" : " (first in the server's list — set AGX_LLM_MODEL to choose)"} — ready`,
	);
	return { ready: true, model: wanted };
}

/** One chat completion. Returns the assistant's message text. Errors carry
 * the server's answer, because a bare status hides the common causes (an
 * uninstalled model answers 404 with "model 'x' not found"). */
export async function chat(messages, opts = {}) {
	const model = opts.model ?? process.env.AGX_LLM_MODEL ?? "llama3.2";
	// Local models can be slow on the first call (the server loads the model
	// into memory), so the default timeout is generous.
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 120_000);
	timer.unref();
	try {
		const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
			method: "POST",
			signal: abort.signal,
			headers: { "content-type": "application/json", ...headers() },
			body: JSON.stringify({
				model,
				messages,
				temperature: opts.temperature ?? 0.2,
			}),
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			const note = detail.slice(0, 200).replace(/\s+/g, " ").trim();
			throw new Error(
				`LLM server answered ${res.status}${note ? `: ${note}` : ""}`,
			);
		}
		const body = await res.json();
		const text = body?.choices?.[0]?.message?.content;
		if (typeof text !== "string") {
			throw new Error("LLM server returned no message content");
		}
		return text.trim();
	} finally {
		clearTimeout(timer);
	}
}
