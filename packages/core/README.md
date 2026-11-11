# @nostr-agx/core

Transport-agnostic **NIP-AGX** protocol core. It makes an agent-exchange *correct and interoperable
by default* so an adopting runtime only decides *what to do with a task*.

Looking for agents to talk to? [Elladex](https://www.ellavox.ai/elladex) is a public NIP-AGX agent directory run by Ellavox AI.

`@nostr-agx/core` owns: A2A task/message/receipt shapes, the **task lifecycle** state machine,
**correlation** (receipt↔sent, reply↔thread), **receipts**, **replay protection**, **capability
matching**, and **content-type dispatch** — all over an injected `AgxTransport`. The Nostr transport
binding is [`@nostr-agx/nostr`](https://www.npmjs.com/package/@nostr-agx/nostr).

```ts
import { AgxClient } from "@nostr-agx/core";
import { localSigner, NostrTransport } from "@nostr-agx/nostr";

const agx = new AgxClient({
  transport: await NostrTransport.create({
    signer: localSigner(secretKey),
    relays,
    ws: WebSocket,
  }),
});

// The runtime only writes handlers; the library owns dispatch → lifecycle → result → receipt.
agx.handle("invoice.review", async (task) => {
  await task.report?.("reviewing");
  return paperclip.run(task.payload);
}, {
  description: "Review an invoice against approval policy",
  inputSchema: {
    type: "object",
    required: ["amount"],
    properties: { amount: { type: "number", minimum: 0 } },
  },
  outputSchema: {
    type: "object",
    required: ["approved"],
    properties: { approved: { type: "boolean" } },
  },
});

await agx.start();

// Optional: resolve the peer's typed card and reject bad input before publishing
// (`streamRequest` accepts the same option).
const result = await agx.request(peer, "invoice.review", { amount: 25 }, {
  validate: true,
  onTaskStatus(update) {
    console.log(update.seq, update.message); // Ordered `working` updates; request stays pending.
  },
});
```

Contracts are optional. Authorized invalid input returns `invalid_input` without running the handler;
invalid handler output returns `invalid_output`. Detailed validation paths stay local. Legacy handlers
and peers without typed schemas keep working, and validation never fetches a referenced schema.

Live transport listeners are registered by `start()` and removed by `stop()`.
Transport `onMessage` and `onReceipt` hooks return an `Unsubscribe` function;
calling it removes only that registration.
Hosts that only call `pump()` from their own scheduler can leave the client unstarted
and will dispatch messages only during those pump calls.

For human-in-the-loop work, a handler can await `ctx.requestInput(requirement)`.
Only `streamRequest()` opts in to interactive input; plain `request()` tells the
responder it cannot answer prompts and fails clearly if the task requires input.
An input-waiting handler releases its concurrency slot, and pending input count
and per-prompt duration are bounded by `maxPendingTaskInputs` and
`maxInputTimeoutMs`. A nonzero request timeout is the end-to-end task deadline.
The requester uses `streamRequest()` to observe `inputRequired`, `statusUpdate`,
`completed`, and `error`; its `result` promise resolves with the final output or
rejects on failure, timeout, or client stop. Stream updates use the same dispatch
path as polling, so live transport hooks are optional. The requester obtains an
answer through its own UI or policy and sends it with
`stream.provideInput(inputRequestId, answer)`. The answer continues the same task.
The suspended handler state is in memory and does not survive a process restart.
The handler must validate answers itself; an input requirement's `inputSchema` is advisory
and is not validated by the protocol core (task contracts above are a separate check). A requester timeout or stop sends a cancellation
so the responder stops waiting and does not send a late result.

> Status: **0.2.0 (draft)** — API is stabilizing alongside the NIP-AGX spec (`SPEC.md`).
