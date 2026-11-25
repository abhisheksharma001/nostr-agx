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
agx has 2 unread messages. Threads with unread messages: thread-b, thread-a. agx threads lists every thread; agx thread <id> shows one, and agx thread <id> --mark-read marks it read once it is handled.
agx has 1 new message (3 unread in all). Threads with new messages: thread-d. agx threads lists every thread; ...
```

- **No peer text.** Not a message, a subject, an address or a held sender's text; they never reach the hook's output. This is the rule `agx inbox --summary` already follows (see [`cli-json.md`](cli-json.md)). The model reads the text itself with `agx thread <id>`.
- **Thread ids are the one thing a peer chose** that appears. A thread id is named only when it is 64 characters or fewer and made of letters, digits and `. _ : -` (the test the message store applies when it saves a thread id). At most five are named, newest first, then `and N more`. A message without a thread id, or with one that is withheld as unsafe, is counted but not named.
- **Held senders never nudge.** Mail from a sender who is not on the allowlist is stored apart and is not counted, not named and not mentioned.
- **Messages this profile sent never nudge**, and neither does mail already marked read.
- With a profile other than `default`, the commands in the text carry `--profile <name>`.

### One nudge per new message

`stop` and `prompt` share one record per host: `hook-nudged-<host>.json` in the profile folder (`~/.agx/profiles/<name>/`), mode `0600`, holding the ids of the unread messages that host has been told about. Nothing else: no text, no thread ids. A message is announced once to each host. A model that never marks mail read is not prompted again every turn; a message that arrives later is announced, with the earlier unread ones counted ("1 new message (3 unread in all)"). A message that is marked read drops out of the file the next time it is written.

`session-start` is the exception: a new session has no memory of an earlier nudge, so it announces **all** unread mail, and records it so the first turn end stays quiet.

The record is saved before anything is printed. If it cannot be saved, the hook prints nothing: a turn-end hook must never nudge again and again because it could not remember.

No lock is needed to write it. Every host gets its own file, and two hooks racing at worst announce a message twice.

### Never blocks the host

- **Reads, does not lock.** The hook reads `messages.jsonl` as `agx threads` does. It never takes the profile lock, so it works while `agx serve` runs on the same profile (the reason `agx inbox --summary` reads the store too). A thread marked read that another process has queued but not yet saved is counted as read. The hook writes nothing but its own record.
- **Any error is silence.** An unreadable config or store, a profile name that is not one plain folder name, a record it cannot write: exit `0`, no output.
- **A time cap.** Whatever the hook is waiting for, after `HOOK_TIME_CAP_MS` (3000 ms, `lib/hook.ts`) it prints nothing and returns. The only thing it can wait for is Cursor's `stop` input on stdin. (A read of the message store is local and not interruptible; if the disk itself hangs, this cap cannot help.)
- **Never exit `2`.** Claude Code, Cursor and Codex all read exit code 2 as "block this". A command line the hook cannot use (an unknown host, a missing `--host`) fails with exit `1`, which all three treat as a non-blocking error.

## Per host

| Host | `stop` | `session-start` | `prompt` |
| --- | --- | --- | --- |
| Claude Code | `{"decision":"block","reason":"<text>"}` | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<text>"}}` | `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<text>"}}` |
| Codex | the same as Claude Code | the same as Claude Code | the same as Claude Code |
| Cursor | `{"followup_message":"<text>"}` | `{"additional_context":"<text>"}` | **nothing**: `beforeSubmitPrompt` can only allow or block a prompt, it has no field that adds context |

Notes:

- **Claude Code `Stop`** with `decision: "block"` keeps the turn going and gives `reason` to the model. The documentation also offers `hookSpecificOutput.additionalContext` on `Stop`, which is shown as feedback rather than as a hook error; this command uses `decision` and `reason`, which is what the issue asked for and works the same on every version. (Open question: whether the other shape reads better in the transcript.)
- **Cursor `stop`**: `followup_message` is submitted as the next user message, at most `loop_limit` times (default 5). Cursor also runs `stop` after a turn the user stopped or that failed; the input then says `"status": "aborted"` or `"error"`, and the hook stays silent so a follow-up never overrides a stop. It speaks only for `"status": "completed"`. If the input is missing or unreadable, it stays silent.
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

What was not verified: that Cursor's user-level `~/.cursor/hooks.json` loads in its command-line agent (the issue that proposed this command reports it does not; the documentation says it loads), and any behaviour of the three hosts when the hook is actually run. Hook documentation changes often; re-read the pages before relying on a shape.
