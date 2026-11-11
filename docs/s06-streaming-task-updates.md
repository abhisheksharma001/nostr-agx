# S-06 — Implement `working` status updates

**PR:** one, stacked on S-04.
**Depends on:** S-04, PR #19 (`input-required` in the `res` envelope); S-05 structured errors is independent.
**Files:** packages/core/src/task.ts, packages/core/src/client.ts, core client tests and documentation, packages/core/SPEC.md.

**Today:** A requester waits for a terminal result with no authenticated progress updates from the handler.

**Change:** add a `working` variant to the `t:"res"` envelope, `{ t: "res", taskId, status: "working", seq, message? }`, next to `input-required` (PR #19), sent only when the request opts in with `supportsWorking: true` (like `supportsInput`). `streamRequest()` and `request(..., { onTaskStatus })` opt in; a plain `request()` does not, and without the opt-in `ctx.report` sends nothing. A handler publishes it with `ctx.report(message?)`, next to `ctx.requestInput`. Sequence numbers start at 1 and increase. A requester sees it as `statusUpdate` `"working"` plus a `progress` event on `streamRequest()`, and through a per-request `onTaskStatus` on `request()`. `resolvePending` treats `working` as nonterminal: same original-peer and `contextId` binding as `input-required`, duplicate or older sequence numbers ignored, the request left pending, the deadline not extended, and no cancellation even on a plain `request()`. Add `working` to registered typed skill features. Unknown, late, and post-terminal updates follow the existing plain-message trust path and receive no automatic reply.

**Acceptance:** WHEN an authorized handler reports `working` THEN the requester SHALL receive the ordered public update and SHALL keep the original request pending until a terminal result or its original deadline.

**Verify:** focused core tests for delivery, ordering, duplicates, wrong sender, unknown task, post-terminal traffic, publish failure, unchanged timeout, opt-in (no update to a requester that did not ask, including main's request shapes), and no update after the terminal result or a cancel; then `pnpm build && pnpm type-check && pnpm test && pnpm check:packages`.

**Must not:** add token-by-token model streaming, raw reasoning, implicit deadline extension, gateway SSE, durable resume, new dependencies, or S-01/S-02 operation-storage changes.

## Options considered

1. `working` inside the `t:"res"` envelope, reusing #19's pending-request handling: one non-terminal mechanism, one set of peer and `contextId` checks. Selected, with an opt-in request flag `supportsWorking`. Without the flag it would not be safe for older requesters: #19's `streamRequest()` reads an unknown `res` from the bound peer as `TaskNotFoundError` and drops its pending input (only 0.5.0 and plain `request()` fall through to a plain message). A requester that predates this change never sets the flag, so it never sees `working`.
2. A separate `t:"status"` envelope (the first version of this step): additive and safe for older peers, but a second dispatch path beside #19's, with its own weaker binding. Rejected after #19 merged.
3. Plain text messages: cannot provide task correlation, ordering, or terminal-state rules. Rejected.

## Public boundary

A status message is handler-supplied public text and must not contain secrets, credentials, raw reasoning, stack traces, or internal host details. Reporting is best-effort: transport failures are logged and do not fail the task. Sequence numbers provide ordering and deduplication, not delivery guarantees.
