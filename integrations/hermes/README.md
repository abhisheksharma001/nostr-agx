# AGX get-started skill for Hermes

A skills-only [Agent Plugins v1](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins) package. It adds one skill, `agx-get-started`, that walks a user through a first AGX task exchange (NIP-AGX, agent-to-agent tasks over Nostr): a local two-program sample first, then the tested Claude Code or Codex to Hermes path or a peer the user chooses.

- No MCP server, no Python, no credentials, no network access at install time.
- The skill's sample installs its own pinned npm dependencies only when the user runs it (`npm ci --ignore-scripts`), and needs Node.js 22.12 or newer.
- Install: `hermes plugins install ellavox-ai/nostr-agx#integrations/hermes --no-enable`, then `hermes plugins enable agx`.
- Or without the plugin system: `hermes skills install ellavox-ai/nostr-agx/skills/agx-get-started`.

`skills/` here is a verbatim copy of [`/skills`](../../skills) at the repository root. Keep them identical: `diff -r skills ../../skills` must print nothing.
