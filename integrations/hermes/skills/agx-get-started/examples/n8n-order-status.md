# Optional: build an n8n order-status receiver

For a task exchange without n8n, use the [tested local sample](local-sample.md). It is not a prerequisite when the user has chosen n8n. This optional example is for someone who wants to operate an n8n receiver. It looks up fictional orders and performs no purchases, sends no emails, reads no business data, and calls no AI model.

## Version and review status

The [workflow JSON](n8n-order-status.json) is an inactive import draft for published `@nostr-agx/n8n-nodes-agx@0.4.0`, which includes the trigger behavior from [Sean's PR #7](https://github.com/ellavox-ai/nostr-agx/pull/7). On self-hosted n8n, use **Settings → Community Nodes → Install** with package `@nostr-agx/n8n-nodes-agx` and select version **0.4.0** if the installed n8n exposes a version selector. For an exact command-line install, an operator can run `npm install @nostr-agx/n8n-nodes-agx@0.4.0` in their existing n8n user folder's `nodes` directory (normally `~/.n8n/nodes`), then restart that n8n instance. Do not run this in the AGX example folder. This bundle does not install, import, or activate the workflow. Do not assume n8n Cloud support.

The custom node type, credential name and parameters were checked against the published 0.4.0 package. The lookup code was exercised locally with simulated n8n input, and this workflow imported successfully as inactive through the real n8n 2.43.7 CLI in a disposable container. Credential provisioning, node execution and task exchange remain unverified; see [validation history](../references/validation-history.md) for the exact evidence limits.

## Receiver configuration — operator steps

1. In self-hosted n8n with the AGX nodes available, import `n8n-order-status.json`. It is inactive, has no credential bindings, and has an empty allowlist. It cannot receive tasks until configured.
2. Create an **AGX Agent Identity API** credential using a dedicated demo key. The operator follows the terminal-only provisioning block below; put the key only in n8n's credential manager, never this chat or the workflow JSON. Neither assistant adapter permits the assistant to export a key. Do not reuse the assistant's identity.
3. Configure a reachable relay that the requester also reads. For a local relay, `127.0.0.1` means the machine/container running n8n, not necessarily the requester's machine; a Docker deployment needs a mutually reachable address. This guide does not provision a public relay.
4. Select that credential on **AGX Order Status**. Use the public `npub` printed during provisioning below; no additional identity-check workflow is needed. Share only that public address with the requester.
5. Put the requester's actual public address into **Allowed Agents**. Leave **Accept All Agents** off. The only served capability is `demo.order-status`.
6. Keep **Advertise Agent Card** off for this first private test; both sides already know the receiver and capability from the operator's configuration. No directory listing or public capability announcement is needed. Keep **Send Error Messages** off.
7. Start **Listen for test event** just before the request for one exchange, or activate the workflow for an ongoing receiver. The trigger result timeout is **10 seconds**, below the requester's **30 seconds**. Test runs handle one event and do not persist the same replay state as active runs; do not treat replay behavior in a manual test as production evidence.

No AGX Send node is required after the lookup: the trigger returns the last node's JSON as the task result. Adding a separate send would be a plain message, not the correlated task result.

### Operator-only credential provisioning

With a task-capable global CLI installed (use published `@nostr-agx/cli@0.4.0` for a new installation), run the following in your own terminal. This creates an isolated key directory and prints a public address. Keep the directory path until the optional demo is finished. The separate local sample still uses its own locked 0.3.0 dependency and does not need this global CLI.

```sh
DEMO_AGX_HOME=$(mktemp -d "${TMPDIR:-/tmp}/agx-n8n-review.XXXXXX")
env AGX_HOME="$DEMO_AGX_HOME" agx identity new --profile n8n-demo
env AGX_HOME="$DEMO_AGX_HOME" agx identity show --profile n8n-demo
```

To copy the secret directly into the **Secret Key** field of n8n's credential dialog, the operator runs this separately, in the same terminal. It prints a secret; do not paste its output into an assistant or share the terminal transcript:

```sh
env AGX_HOME="$DEMO_AGX_HOME" agx identity export --profile n8n-demo --yes
```

Configure the relay in the n8n credential separately. CLI workflow import passed, but this credential-provisioning sequence and real n8n task exchange remain unverified here. The lack of that optional integration never blocks the default local sample.

## Requester steps — follow the selected assistant adapter

Use the requester's existing identity and selected profile; have the operator confirm its public key is the one allowed on n8n. A requester allowlist change is not needed merely to receive the correlated result of its own typed request.

The following is a template, not a command to run literally. Replace `N8N_NPUB` with the operator-confirmed public address. If a named profile is in use, add its explicit `--profile` option before `--`.

```sh
agx request --payload '{"orderId":"DEMO-1001"}' --timeout 30000 -- N8N_NPUB demo.order-status
```

- **Claude draft mode:** the user runs the command in their own terminal.
- **Claude confirmed assisted-send mode:** only after approving this exact recipient, capability and payload, the user approves the host's send prompt too.
- **ChatGPT/Codex:** the user always runs the command in their own terminal. This task cannot be submitted as an `agx ui` message draft.

Expected task output (inside the CLI's completed task result):

```json
{
  "source": "agx-get-started-demo",
  "demo": true,
  "orderId": "DEMO-1001",
  "found": true,
  "status": "ready-for-pickup",
  "nextStep": "Collect at the fictional demo warehouse."
}
```

This is real protocol-level delegation to an n8n workflow over synthetic data. It does not demonstrate AI reasoning, access to an actual order system, autonomous desktop receiving, or a human-message reply. Report the precise milestone.

## Review checks before publishing this example

- Known allowed requester gets a completed task with exactly the expected output above.
- Missing/non-string/overlong `orderId` returns `found: false, error: invalid-order-id`; a bounded but unknown ID returns `found: false, error: order-not-found`. No arbitrary input is reflected back.
- A different, unallowed requester causes no lookup execution and receives no task result; timeout alone is not proof of this, so inspect receiver executions too.
- Stopping the test listener or deactivating the workflow makes the receiver unavailable. Do not automatically resend after a timeout.
- For an active workflow, save/restart n8n and check replay behavior separately, including a fresh request succeeding. The PR claims durable event claims; this example has not independently verified them. A crash may still leave a task without a result.

Deactivate the workflow after the demo and stop any dedicated local relay in the terminal that started it. The assistant remains an on-demand client or session watcher; it does not inherit n8n's availability.
