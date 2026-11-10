# Two real agents, one input-required workflow, one local relay

Two long-running AGX agent processes — a reviewer (responder) and a requester
(initiator) — exchange a task over the local relay, and the reviewer asks the
requester for input **mid-task**. The requester answers autonomously, the
reviewer's suspended handler resumes, and the task completes. Every question
and answer is a signed, NIP-44-encrypted Nostr event through the relay; no
shared memory, no direct connection.

Each side is backed by a **local LLM** behind its decision seam. The
reviewer's model reviews the transcript against policy and decides APPROVE /
REJECT / **ASK** — an ASK sends another input-required round, so how many
questions the reviewer asks is the model's call, not a script's. The
requester's model answers each question from its own private purchasing notes.
Two processes, two models, one relay: `perceive → reason → act` on both ends,
with AGX carrying the conversation between them.

With no LLM server reachable, both agents say so and fall back to a fixed
canned policy so the exchange still runs — and every decision is labelled with
who made it (`decidedBy` in the task result: `llm:<model>` or
`canned-fallback`), so a stub answer is never confused with a model's.

This is the two-process version of
[`examples/input-required-agent.ts`](../input-required-agent.ts): instead of
one script playing both roles with a human typing answers, each side is its
own agent with a persistent identity and a model behind its decisions.

Both CLI surfaces stop short of this workflow on purpose: `agx request`
reports `interactive_input_required` and exits, and `agx serve --handler`
modules get `(payload, task)` with no `ctx.requestInput`. Agents that ask or
answer mid-task questions are written against the SDK, like these two.

## Plugging in a real local LLM

`llm.mjs` is a ~70-line OpenAI-compatible chat client (plain `fetch`, no new
dependency) that both agents import. It speaks `/v1/chat/completions`, which
every local server implements, so any of these work:

| Server | `AGX_LLM_BASE_URL` | Notes |
| --- | --- | --- |
| [Ollama](https://ollama.com) | `http://127.0.0.1:11434/v1` (default) | `ollama pull llama3.2` or any model you have |
| llama.cpp `llama-server` | `http://127.0.0.1:8080/v1` | |
| LM Studio | `http://127.0.0.1:1234/v1` | |
| vLLM | `http://127.0.0.1:8000/v1` | |

```sh
# example: Ollama
brew install ollama
ollama pull llama3.2            # or qwen3, mistral, … — `ollama list` shows what you have
AGX_LLM_MODEL=llama3.2 node examples/two-agents/reviewer.mjs   # terminal 2
AGX_LLM_MODEL=llama3.2 node examples/two-agents/requester.mjs # terminal 3
```

`AGX_LLM_MODEL` picks the model (unset, the first one the server lists is
used); `AGX_LLM_API_KEY` is sent when set — Ollama and llama.cpp ignore it.
Each agent logs whether it reached an LLM at startup, prints the model's
first line on every decision (`model says → …`), and the final task result
carries `decidedBy: "llm:<model>"`. Structured choices use a short
first-line protocol (`APPROVE — …` / `REJECT — …` / `ASK — …`, `YES`/`NO`)
rather than JSON, because small local models hold that format far more
reliably.

**"LLM server answered 404" means the model is not installed.** Ollama
answers a completion for an unknown model with 404 (`model 'x' not found`)
while `GET /v1/models` still succeeds, so a wrong `AGX_LLM_MODEL` (or an
empty server) passes a liveness probe and fails at the first question. Both
agents therefore verify the model against the server's list at startup and
say exactly what to do (`ollama pull llama3.2`, or set `AGX_LLM_MODEL` to one
of the listed names), running the canned policy meanwhile; a model call that
fails mid-task degrades the same way, labelled, instead of killing the
conversation.

The models are replaceable independently: run the reviewer with one model and
the requester with another (`AGX_LLM_MODEL` is read per process). Neither
model ever sees the other agent's private context — the requester's notes stay
in the requester, the reviewer's policy stays in the reviewer, and only the
chosen question/answer text crosses the wire, encrypted.

## Run it

From `packages/nostr`, after `pnpm install && pnpm build` at the repository
root:

```sh
# terminal 1 — the local relay (ws://127.0.0.1:7447), from the repository root
node packages/cli/dist/agx.js relay

# terminal 2 — from packages/nostr: create the two agents once, then start the reviewer
node examples/two-agents/provision.mjs
node examples/two-agents/reviewer.mjs

# terminal 3 — the requester, one task per run
node examples/two-agents/requester.mjs
```

`AGX_RELAY` overrides the relay for every command. The relay stores events in
memory; restart it for a fully clean slate. The identities live in
`.two-agents/` next to these scripts (git-ignored, `0600`) — delete that
folder to provision fresh keys.

Two runtime notes, both matching the library's documented behaviour:

- **One reviewer per identity**: the reviewer takes a pid lock
  (`.two-agents/reviewer.lock`, cleaned up on exit; a dead pid's lock is
  taken over). Two processes on one keypair would both dispatch every task
  and double-answer — the same reason `agx serve` takes a profile lock.
- **Restart replays a bounded window**: the SDK's replay tracking is
  in-memory, so a restarted reviewer re-dispatches recent task events (its
  `startCursor` skips older ones). A stale task re-runs, its `requestInput`
  times out, and it fails harmlessly — the requester from that task is long
  gone. A live task is unaffected: an input-waiting handler releases its task
  slot, so a new task runs beside a suspended one. The CLI avoids this class
  entirely by persisting its seen store.

## What you should see

With an LLM running, the exchange is a model-driven conversation — the
reviewer's model may ASK follow-ups before ruling, and the final result names
who decided:

```
requester  peer card: "Acme Finance — invoice desk (demo)"  capabilities [invoice.review]
requester  task status → delivered
reviewer   ALLOW task invoice.review from 07b9d1e3…
reviewer   TASK invoice.review  payload {"amount":4200,"vendor":"Globex","invoiceId":"INV-8891"}
requester  task status → input-required
requester  peer asks: "What was Globex's $4200 invoice for?"
requester  model says → The invoice covers the Q4 cloud infrastructure renewal under contract V-8891.
requester  answer: "The invoice covers the Q4 cloud infrastructure renewal under contract V-8891." — from this agent's purchasing notes [llm:llama3.2]
requester  answer sent
reviewer   requester answered → purpose "The invoice covers the Q4 cloud infrastructure renewal…"
reviewer   model says → ASK — which budget code covers this renewal?
reviewer   model wants more input → asking: "which budget code covers this renewal?"
requester  task status → input-required
…(reviewer's model finally rules APPROVE, asks the boolean confirmation)
requester  task status → completed
requester  final result → { "approved": true, "rationale": "…", "decidedBy": "llm:llama3.2", … }
```

Without an LLM, both agents print `LLM: none reachable at …` and run the same
exchange on the canned policy, with `decidedBy: "canned-fallback"` in the
result — the protocol path is identical, only the decisions differ.

Run the requester again with the reviewer still up to repeat the exchange
with a new task id. Try a third agent's key on the relay — the reviewer's
`authorize` hook drops it with no reply (`DENY`), which is the specified
default-deny behaviour, and the requester times out.

## Where your own agent goes

Three integration levels, depending on what you already have:

- **This example's shape** — SDK process per agent, a local model behind the
  two seams (the reviewer's `judge()`/handler and the requester's `decide()`).
  Full control, works with any OpenAI-compatible local server, and the only
  way today to drive input-required rounds with a model on both sides.
- **`agx serve --handler ./runtime.mjs`** — for single-shot capabilities (task
  in → LLM → result out, no mid-task questions): the handler module calls
  your model and returns; the CLI owns identity, encryption and the task
  lifecycle. This is the documented "plug in a real runtime" path in
  [`packages/cli/README.md`](../../../cli/README.md#plugging-in-a-real-runtime).
- **An existing AI host as the requester** (Claude Code, Codex, …) driving
  `agx send` / `agx request` — the host's model is the LLM. Works for plain
  messages and one-shot tasks; `agx request` cannot answer input-required
  prompts, so a host-driven requester cannot join a multi-turn task exchange
  like this one.

