# Token Saver

A Claude Code mod for using Claude more efficiently. It shows what your tokens cost and how much of your limits is left, tells you whether the prompt cache is warm and keeps it warm, checks or auto-picks the effort before you send, shows what fills your context, and hands a long chat off to a fresh one.

## Install

**Claude Code, any computer** (this repository is private, so that computer needs GitHub access: sign in once with Git Credential Manager, or `gh auth login` then `gh auth setup-git`). At the prompt of a terminal session:

```
/plugin install token-saver --marketplace Schattiges/token-saver
```

Answer `y` to add the marketplace, then pick the user scope. From a shell instead:

```
claude plugin install token-saver --marketplace Schattiges/token-saver
```

**Claude desktop app (Code tab)**: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Schattiges/token-saver`, then **Add plugin**.

**Cowork and every device on your account**: open `token-saver.plugin` in a chat with Claude, press **Save plugin** on its card, then **Continue**. A plugin saved to your account syncs to the Claude apps you sign in to.

**From a local folder** (development): `claude --plugin-dir <folder>`, or add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` so every session loads it.

## What it does

**Usage bar above the prompt.** One row with context fill, your 5-hour and weekly limits and when they reset, a prompt-cache light: "● hot 47m" (green), "◐ cooling 6m" (amber, the last 10 minutes of a 1h cache or 90 s of a 5m one), "○ cold 47m" (red; how long it has been cold, in minutes up to 3 hours, then hours, then days from 2 days on, plus what your next message costs to re-cache, "next msg +$0.80"), with the lifetime beside it ("/1h"), and the session's cost. It has Preflight, Handoff and Stats buttons. In a terminal the same figures show in the status line.

**Cost under every reply.** Next to "Baked for 1m 4s": what that turn cost at API prices, how many requests it took, its cache hit rate, and the effort if this mod changed it.

**Token stats** (`/tokens` or the Stats button):
- **Now**: each limit with a burn rate, when it hits 100% at that rate, and where you end at the window's average pace; what Claude Code used in the window and roughly what 1% costs; context fill and what each request re-reads; cache state and keep-warm; this session's tokens and cost; subagents; the last turn and the last cold start.
- **Context**: what fills this chat by kind (file reads, command output, your messages, replies), the largest single items, and what to do about them.
- **Days / Weeks / Months**: requests, input, output, cache read and write, and cost per period, plus a 24-hour sparkline.
- **Models / Projects / Sessions**: the last 30 days by model (with cache hit rate), by working folder, and the most expensive chats.
- **Tips**: advice from your own numbers.

History comes from Claude Code's transcripts (`~/.claude/projects`), so it covers sessions from before you installed the mod. Where there are none, as in Cowork, it comes from the mod's own log of every request it has seen.

**Preflight.** Start a prompt with `??`, press Preflight with a draft in the prompt box, or run `/preflight <prompt>`. A cheap model (Haiku by default, a fraction of a cent) reads the prompt and the recent conversation, then shows:
- the suggested **effort** (low to max) and why,
- **what Claude will likely do**, step by step,
- an **estimated cost** range at the effort you pick, with the cache state,
- an **improved prompt**, questions worth settling first, and one way to make it cheaper.

Then **Send improved**, **Send mine**, **Edit improved**, **Edit mine** or **Cancel**, optionally with an effort for that one turn.

**Preflight modes** (setting or the stats pane's button): `prefix` checks prompts that start with `??`; `always` checks every prompt (start one with `!!` to skip); **`auto`** opens no pane: the cheap model picks the effort for each prompt, it applies to that turn, and a toast says which; `off` leaves only the button and `/preflight`.

**Handoff** (`/handoff [focus]` or the Handoff button). A fork of this chat writes a dense brief: goal, state, decisions, files, commands, next steps, gotchas. The fork reads the cached context, so it is cheap. **Continue in a fresh chat** clears the context and puts the brief in the prompt; **Copy** and **Put in prompt** do what they say. Briefs are saved under `~/.claude/handoffs/`; `/handoff-load` brings back the folder's latest in a new chat. Past 60% context (configurable) it suggests a handoff.

**Keep-warm** (`/keepwarm on`). While you are idle it sends a tiny cache-read ping shortly before the prompt cache expires, so your next message does not re-write the whole context. It stops after a set time idle. The stats pane compares one ping with a cold restart.

**Cache lifetime** is learned from this chat's own requests as soon as one writes the cache; before that from your latest main-chat transcript (subagents, which always write 5-minute caches, are left out). A resumed chat starts the timer at its last reply, so a cache that is still hot shows hot.

**Warnings**: the cache about to cool while you are idle (with what a cold restart would cost), a turn over $1, limits past 75% and 90%, a limit that reset, a cold cache that re-wrote a big context, the daily budget reached.

## Commands

| Command | What it does |
|---|---|
| `/tokens` | Open the stats pane |
| `/preflight [prompt]` | Check a prompt (or the draft in the prompt box) |
| `/handoff [focus]` | Write a handoff |
| `/handoff-load` | Put this folder's latest handoff in the prompt |
| `/keepwarm [on\|off]` | Turn keep-warm on or off |

## Settings

In `/config` or the plugin's options: cache lifetime (`auto`, `5m`, `1h`), keep-warm and how long it runs, preflight mode (`prefix`, `always`, `auto`, `off`), the helper model, the expensive-turn warning, a daily budget, the handoff threshold, and whether the usage bar shows. The Keep-warm and Preflight buttons in the stats pane apply at once.

## Good to know

- **Costs are theoretical**: API list prices for the tokens used. A Pro or Max plan is billed flat; the numbers show which work is expensive and help you stay under your limits.
- Limits are the API's own readings, the same as `/usage`. claude.ai and Cowork share them, so "≈ per 1%" is a rough guide.
- Estimates are estimates: the helper guesses steps and output, and the cost range is wide on purpose.
- An effort picked in Preflight or by `auto` applies to one turn. On models without per-message effort a change restarts the cache once; if it does, the cold-start warning says so and what it cost.
- Keep-warm pings count toward usage like any request, at the cache-read price.
- Commands answer with one short line, so the mod adds almost nothing to your context.

## Development

`claude plugin validate .` and `claude plugin test .` from this folder. The hooks module is `hooks/register.tsx`; prices are in `hooks/pricing.ts`.
