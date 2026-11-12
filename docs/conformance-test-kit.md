# AGX conformance test kit

## Today

The repository tests its own TypeScript implementation, but another implementation cannot reuse those tests without importing TypeScript internals.

S-31 adds one versioned JSON document of task-envelope vectors and a reference test that runs every vector through `parseTaskEnvelope`. The JSON is the contract; the reference test only checks this implementation against it.

Each vector has a stable `id`, the `spec` section it checks, exact input `text`, and `valid`. A valid vector also carries the expected `envelope`. An implementation parses `text` as JSON and applies the task-envelope rules in `packages/core/SPEC.md`. It must accept valid vectors with the expected fields and reject invalid ones. Property order and a particular serialization are not requirements.

A green run covers only the vectors in the document. It is not a claim of complete AGX or Nostr interoperability.

## Acceptance

WHEN an implementation runs `conformance/task-envelopes.json` THEN it SHALL accept every valid vector with its expected envelope and reject every invalid vector.

## Reference verification

```sh
pnpm --filter @nostr-agx/core exec vitest run src/conformance.test.ts
```

Pass: every vector passes, vector IDs are unique, and every valid vector includes its expected envelope.

## Left out

- Relay, network, cryptographic, and Nostr event vectors.
- Task execution, lifecycle transitions, authorization, and replay behavior.
- A standalone runner, conformance reports, certification, and implementation badges.
- Wire-format changes, new dependencies, and production API changes.
