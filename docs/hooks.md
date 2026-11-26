# `agx hook`: tell a coding agent that agx mail is waiting

**Status: new. The output shapes below are checked by contract tests against each host's documentation as read on 2026-11-26 (see [Sources](#sources)). They were not run inside Claude Code, Cursor or Codex.**

A coding agent that is busy with a turn does not see mail that arrives meanwhile. `agx serve` stores it, but nothing tells the model. Most coding agents run a command at the end of a turn, at the start of a session and when a prompt is sent. `agx hook` is the command to run there: it looks at the message store and, when there is mail the agent has not been told about, prints one short line in that host's own JSON shape. The agent reads the mail itself with `agx thread`.

```text
agx hook stop --host <claude|cursor|codex>     a turn is ending: keep the agent going if there is news
agx hook session-start --host <host>           a session is starting: say how much unread mail there is
agx hook prompt --host <host>                  a prompt is being sent: add the nudge as context
```

`--profile <name>` (or `AGX_PROFILE`) picks the profile, as for every other command.

## What a hook cannot do

**A hook cannot wake an idle agent.** It runs only while a turn is ending, a session is starting or a prompt is being sent. An agent that finished its turn and is waiting for you hears nothing until its next turn, session or prompt. What a hook does is stop an agent from ending a turn with mail unread, and tell a fresh session or a new prompt what is waiting. To be told about mail while idle, something has to start a turn: a watcher that turns each `agx serve` line into a notification (Claude Code's Monitor tool does this), or `agx wait` in a background task on a profile that no `agx serve` is using.

## What it prints

One line of JSON, or nothing. Never anything else on stdout, nothing on stderr, and always exit code `0`.

The text is the same for every host. Counts and thread ids only:

```text
agx has 2 unread messages. Threads with unread messages: 0b2f61c4-7a1e-4d58-9c3a-5e8d2f1a6b07, d41c9a7e-3b52-4f08-a6d1-90c27e5b8f13. agx threads lists every thread; agx thread <id> shows one, and agx thread <id> --mark-read marks it read once it is handled.
agx has 1 new message (3 unread in all). Threads with new messages: 6e90b3f2-18c4-4a7d-8b55-c3a1f0d97e24. agx threads lists every thread; ...
```

- **No peer text.** Not a message, a subject, an address or a held sender's text; they never reach the hook's output. This is the rule `agx inbox --summary` already follows (see [`cli-json.md`](cli-json.md)). The model reads the text itself with `agx thread <id>`.
- **A thread id is named only when it is a UUID** (8-4-4-4-12 hex digits, either case), the form agx itself gives a thread. A sender can choose any thread id, and what the hook prints becomes part of another agent's prompt: Codex reads a `Stop` hook's text as a new user prompt, and Cursor submits it as the next user message. So an id made of anything else, such as words, is counted in the total and never shown. At most five are named, newest first, then `and N more`. A message with no thread id, a withheld one, or one that is not a UUID is counted but not named.
- **Only a sender on the allowlist as it is now nudges.** The allowlist is read at every call, in the forms `agx serve` accepts (hex, `npub`, upper case); an entry that is not a public key is ignored, and an empty allowlist means nothing to say. A sender taken off the allowlist after their mail arrived does not nudge any more; the mail stays in the store and `agx threads` still shows it. Mail from a sender who was not on the allowlist when it arrived is stored apart as held mail and is not counted, named or mentioned.
- **Messages this profile sent never nudge**, nor do messages from this profile's own key (even when that key is on its own allowlist), nor does mail already marked read.
- With a profile other than `default`, the commands in the text carry `--profile <name>`.

### One nudge per new message

`stop` and `prompt` share one record per host: `hook-nudged-<host>.json` in the profile folder (`~/.agx/profiles/<name>/`), mode `0600`, holding the ids of the unread messages that host has been told about. Nothing else: no text, no thread ids. A message is announced once to each host. A model that never marks mail read is not prompted again every turn; a message that arrives later is announced, with the earlier unread ones counted ("1 new message (3 unread in all)"). A message that is marked read drops out of the file the next time it is written.

`session-start` is the exception: a new session has no memory of an earlier nudge, so it announces **all** unread mail, and records it so the first turn end stays quiet.

The record is saved before anything is printed. If it cannot be saved, the hook prints nothing: a turn-end hook must never nudge again and again because it could not remember. Writing it never changes the mode of the profile folder, and when the folder cannot be written (a read-only folder, for example) the hook stays silent, exit `0`, and leaves everything as it was. A record written by a newer agx (a `version` above 1) is not understood, so it is left alone and the hook says nothing until it is deleted.

No lock is needed to write it. The record is per host and per profile, not per session: two sessions of the same host on the same profile share it, so one session's nudge also silences the other, which hears nothing about that mail until it is new. Hooks that run at the same moment (Codex launches matching hooks concurrently) can each announce the same message. Neither case loses mail: it stays unread in the store.

### Never blocks the host

- **Reads, does not lock.** The hook reads `messages.jsonl` as `agx threads` does. It never takes the profile lock, so it works while `agx serve` runs on the same profile (the reason `agx inbox --summary` reads the store too). A thread marked read that another process has queued but not yet saved is counted as read. The hook writes nothing but its own record.
- **Any error is silence.** An unreadable config or store, a profile name that is not one plain folder name, a record it cannot write: exit `0`, no output.
- **A time cap.** Whatever the hook is waiting for, after `HOOK_TIME_CAP_MS` (3000 ms, `lib/hook.ts`) it prints nothing and returns. The only thing it can wait for is the host's `stop` input on stdin. (A read of the message store is local and not interruptible: if the disk itself hangs, or the store is so large that reading it takes longer than the cap, this cap cannot help. A store of a few hundred thousand unread messages takes seconds to read.)
- **Never exit `2`.** Claude Code, Cursor and Codex all read exit code 2 as "block this". A command line the hook cannot use (an unknown host, a missing `--host`) fails with exit `1`, which all three treat as a non-blocking error.

### A stop hook the host is already continuing

Two agents that both run this hook and answer each other would produce a new message every turn, and a turn-end hook that kept the turn going each time would never let either turn end. Each host says in the input of its `stop` hook when it is already continuing because of a stop hook. In that case the hook prints nothing **and records nothing**, so the mail is announced at the next prompt, the next session start or the next turn end that is not a continuation.

| Host | Field in the `stop` input | What the documentation says | Silent unless |
| --- | --- | --- | --- |
| Claude Code | `stop_hook_active` | `true` "when Claude Code is already continuing as a result of a stop hook" | it is absent or `false` |
| Codex | `stop_hook_active` | "Whether this turn was already continued by `Stop`" | it is absent or `false` |
| Cursor | `loop_count` and `status` | "how many times the stop hook has already triggered an automatic follow-up for this conversation (starts at 0)"; `status` is `completed`, `aborted` or `error` | `status` is `completed` and `loop_count` is absent or `0` |

Only the field a host documents for its own `stop` hook is read: the Claude Code and Codex pages do not define `loop_count`, and the Cursor page does not define `stop_hook_active`. A value that is not exactly the documented "not continuing" value counts as continuing, and so does an input that cannot be read (empty, not JSON, or over 1 MiB): when the hook cannot tell, it says nothing. Because of this every host's `stop` hook reads its input on stdin, under the same time cap; `session-start` and `prompt` read nothing. Run by hand in a terminal there is no input, so it stays silent; to try it, pipe an input in: `echo '{"stop_hook_active": false}' | agx hook stop --host claude`.

## Per host

| Host | `stop` | `session-start` | `prompt` |
| --- | --- | --- | --- |
| Claude Code | `{"decision":"block","reason":"<text>"}` | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<text>"}}` | `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<text>"}}` |
| Codex | the same as Claude Code | the same as Claude Code | the same as Claude Code |
| Cursor | `{"followup_message":"<text>"}` | `{"additional_context":"<text>"}` | **nothing**: `beforeSubmitPrompt` can only allow or block a prompt, it has no field that adds context |

Notes:

- **Claude Code `Stop`** with `decision: "block"` keeps the turn going and gives `reason` to the model. The documentation also offers `hookSpecificOutput.additionalContext` on `Stop`, which is shown as feedback rather than as a hook error; this command uses `decision` and `reason`, which is what the issue asked for and works the same on every version. (Open question for the maintainer: a review recommended the other shape for Claude Code, because it is the one the page names for guidance when a hook is "working as designed", it is not shown as a hook error, and it follows the same loop protection. Codex has no `additionalContext` on `Stop`, so `decision` and `reason` stay there.)
- **Cursor `stop`**: `followup_message` is submitted as the next user message, at most `loop_limit` times (default 5). Cursor also runs `stop` after a turn the user stopped or that failed; the input then says `"status": "aborted"` or `"error"`, and the hook stays silent so a follow-up never overrides a stop. It speaks only for `"status": "completed"` with `loop_count` 0 (see above). If the input is missing or unreadable, it stays silent.
- **Cursor `sessionStart`** is documented as fire-and-forget: it adds `additional_context` to the conversation's initial context and the agent does not wait for it.
- **Codex** needs each hook reviewed and trusted once with `/hooks` before it runs; a hook that is new or changed is skipped until then.
- **Exit code `0` with no output** is a success in all three: the host carries on as if there were no hook.

## Setting it up

By hand, until `agx link install` does it for you. These are the documented file locations and shapes; `agx` must be on the `PATH` the host runs hooks with.

**Claude Code**: `~/.claude/settings.json` (all projects) or `.claude/settings.json` (one project):

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "agx hook stop --host claude" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "agx hook session-start --host claude" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "agx hook prompt --host claude" }] }]
  }
}
```

**Cursor**: `~/.cursor/hooks.json` (user) or `<project>/.cursor/hooks.json` (project):

```json
{
  "version": 1,
  "hooks": {
    "stop": [{ "command": "agx hook stop --host cursor" }],
    "sessionStart": [{ "command": "agx hook session-start --host cursor" }]
  }
}
```

**Codex**: `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`) or `<project>/.codex/hooks.json`; then open `/hooks` and trust the entries:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "agx hook stop --host codex" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "agx hook session-start --host codex" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "agx hook prompt --host codex" }] }]
  }
}
```

Add `--profile <name>` before `hook` when the agent should read a profile other than the default one.

## Sources

Every host shape above was read from the host's own documentation, live (not from a cache), on 2026-11-26 between about 03:30 and 03:55 IST:

- Claude Code, hooks reference: https://code.claude.com/docs/en/hooks (published 2026-11-25): `Stop` decision control, `additionalContext`, `SessionStart` and `UserPromptSubmit` output, exit codes, hook locations.
- Cursor, hooks: https://cursor.com/docs/hooks (`stop`, `sessionStart`, `beforeSubmitPrompt`, exit codes, locations, `loop_limit`) and https://cursor.com/docs/reference/third-party-hooks (what Cursor accepts from Claude Code's format: documented for `PreToolUse` and `Stop` only, so nothing here relies on it).
- Codex, hooks: https://developers.openai.com/codex/hooks.md (it redirected to https://learn.chatgpt.com/docs/hooks.md): `Stop`, `SessionStart`, `UserPromptSubmit`, trust review, locations.

The loop-guard fields (`stop_hook_active` for Claude Code and Codex, `loop_count` and `status` for Cursor) were read from the same three pages live on 2026-11-26 at about 22:22 IST; the Claude Code page was still dated 2026-11-25.

What was not verified: that Cursor's user-level `~/.cursor/hooks.json` loads in its command-line agent (the issue that proposed this command reports it does not; the documentation says it loads), and any behaviour of the three hosts when the hook is actually run. Hook documentation changes often; re-read the pages before relying on a shape.
