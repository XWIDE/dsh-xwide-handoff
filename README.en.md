# dsh-xwide-handoff

> A **handoff** plugin for **DeepSeek Harness (DSH)**: one `/handoff` turns a nearly-full chat into a **structured handoff card + a clean new session**, pinned to the top of the sidebar. It can also **prepare the next leg automatically** when the context runs hot.

[中文（主页，先显示中文）](README.md) · **English** · [Install & Usage Guide](docs/INSTALL.md) · [Changelog](CHANGELOG.md) · [MIT License](LICENSE)

> **Status: v0.2.1 · beta.** The core flow (`/handoff` → card → new session → auto-numbered title → pin) runs daily on the author's machine; cross-machine install paths (notably `childMode: none`) are **not verified on a second box** yet. Two-step install, the config table and five troubleshooting cases live in the [Install & Usage Guide](docs/INSTALL.md).

---

## The problem

Long tasks fill the context window. DSH's built-in auto-compaction is **lossy** — it eats detail, and you are still in the same session, still filling up.

This plugin takes a different route — **handoff**:

1. Write down *where we are* — what was changed, what was verified, what is next — as a **handoff card**;
2. Create a **zero-context new session** and inject that card as its first message;
3. The new session is **auto-named** (`<original>_01`, `_02`, … from a persistent counter), **auto-pinned** and **filed into the source session's project group**.

You changed rooms; the baton did not drop.

## Install

```bash
# inside your DSH profile directory
pnpm add dsh-xwide-handoff
```

**Download & drop (no npm / pnpm needed)**: copy this repository to `<your profile>\local-plugins\dsh-x-wide_handoff\`, add one mount row to the end of the profile's `cordis.patch.yml`, then **restart DSH**:

```yaml
- id: dsh-xwide-handoff
  name: './local-plugins/dsh-x-wide_handoff/index.js'
  config:
    enabled: true
    commandName: handoff
    childMode: create
    recentUserMessages: 6
```

> ⚠️ **Only one mount instance may exist.** The package's own bundle patch inserts the row; adding your own `- insert:` on top = two instances (command registered twice, watchers doubled). Symptom: `/handoff registered` printed twice in the boot log. See [troubleshooting ①](docs/INSTALL.md).

## Usage

You should see `handoff` in the slash-command palette (proof the command is registered), or type `/handoff` directly:

![The handoff command in the DSH command palette](docs/img/handoff-command.png)

```
/handoff Focus: finish the X parser rewrite; a.js already changed; regression not verified
```

- Anything after `/handoff` lands in the card's "本次交接重点" (focus) section.
- **Omitting it is fine** — the card still carries "files touched this round" and your last 6 user messages.
- The command reports the new session id/title and pins it.

**Note**: `/handoff` is a slash command — **only the user can type it**; a model cannot invoke it. That is exactly why the plugin also ships auto-ready (below): at threshold it *prepares* the handoff for you.

## Auto-ready (`autoReady`)

When enabled, the plugin watches every `turn/end` and reads how much context the last request carried:

```
usage = latest assistant/message .usage.inputTokens / contextWindow
```

- **≥ `readyPct` (default 0.7)** → it runs a full handoff: create session, name it, pin it, inject the card, and drive its first turn (so it is guaranteed to appear in the sidebar).
- **It does not switch sessions for you** — you click the pinned session. DSH exposes no server-side "switch the browser's session" API, and that boundary is intentional.
- Fuses: one prepare per session, global cooldown (10 min default), and the switch defaults to **off**.

> ⚠️ Use `inputTokens`, **not** `usage.totalTokens`. The latter is cumulative spend (we have seen 205k) and will trigger on everything.

## Configuration

```yaml
- id: dsh-xwide-handoff
  name: './local-plugins/dsh-x-wide_handoff/index.js'
  config:
    commandName: handoff          # command name
    childMode: create             # none | create | fork
    recentUserMessages: 6         # how many of your messages the card carries
    compact: false                # run local compaction before handing off (keep false on local models)
    titleTemplate: '{base}_{seq}' # supports {base} {seq} {note} {time}
    seqWidth: 2                   # _01
    maxTitleChars: 64
    repinLimit: 3                 # self-heal re-pin attempts
    autoReady: false              # auto-ready master switch
    readyPct: 0.7
    readyCooldownMs: 600000
    contextWindow: 262144         # model window (defaults to the author's local model — set your own)
    cardSections: { guide: true, files: true, usage: true }
```

### `childMode`

| value | behaviour | when |
|---|---|---|
| `create` | server creates a **fresh empty session** (zero context; inherits cwd + agentPreset) | **recommended default**; no client half required |
| `none` | server creates nothing; the card JSON rides in the command result and `client.js` creates a **visible** session through the GUI-native API | when you need the exact "New chat" behaviour; requires `client.js` wired as `dsh.client`; **not verified across machines** |
| `fork` | inherits the full history (context **not** cleared) | rename-only scenarios |

> ⚠️ None of them may set `parentSession` — DSH excludes sessions carrying `parentSession` from the list and the recoverable set; that is the classic "handoff finished but no new session shows up" bug.

## What the card looks like

```markdown
调节Qwen3.8 Agent对接本地模型_07          ← first line = target title (the naming heuristic reads it)

# 交接卡 · 调节Qwen3.8 Agent对接本地模型_07

## 接手须知（先读这一段）
1. Read the full card: the newest .md in the source session's handoff/ directory
2. State your plan first: which item, roughly how long, any branches
3. Do not redo finished steps: everything under "本轮动过的文件" was already changed
4. When unsure, go verify — the files, directories and session logs are all on disk

- 源会话上下文：约 18461 tokens（carried by the last request; judge pressure by this, not cumulative）

## 本轮动过的文件（3 files, extracted from 5 write/edit calls）
- `C:\…\local-plugins\dsh-x-wide_handoff\index.js`（write×1 edit×4）

## 最近你的原话（逐条原文）
1. …
```

## How it works (for people changing the code)

- **Naming**: sequence numbers come from an on-disk counter (`~/.dsh/named-handoff-counter.json`, bucketed per cwd). They are **not** derived from the source title's trailing number — the source session is always freshly opened with no such suffix, so that approach always yields `_01`. The name list lives in `~/.dsh/named-handoff-names.json`.
- **Three pinning channels**: ① the card's first line is the target title (the built-in title service reads it); ② `ctx.sessions.using(...).binding.session.rename()` (absent on some builds); ③ `session.append("session/title", …)`.
- **Self-heal re-pin**: the official title service deliberately overwrites pinned titles ("overwriting a pinned user title is the point"), so the plugin watches title events and re-pins names it owns (up to `repinLimit`).
- **`prompt` needs a signal**: `sessionController.prompt(request, signal)`'s wrapper calls `signal.throwIfAborted()` on its first line — pass `new AbortController().signal`.
- **`blank` only flips on `turn/start`**: the sidebar filters `blank: true` sessions out entirely (and renders them as "New session"). Injecting a message does not flip it — you must actually drive a turn.

## Compatibility

This plugin uses **DSH internals** (not a stable public contract), verified against:

| What | Where |
|---|---|
| `sessionController.prompt / create / resolveAgent` | `@deepseek-ai/dsh-api-session-controller` |
| `session.append` `surfaceOp` semantics | `@deepseek-ai/dsh-session` (`SURFACE_EVENT_TYPES` = system/developer/user/assistant/message + tool/result) |
| `system/message` must be the first surface node | `@deepseek-ai/dsh-session-format-v3-to-v4` `foldSurface()` |
| `workspaceRegistry.pinSession` | `@deepseek-ai/dsh-workspace` |
| `projectController.baseline / assign` | `dsh-project-groups` (**optional**; skipping when absent) |
| sidebar `blank` filter | `@deepseek-ai/dsh-client-ui-workspace` |

**Re-check this table after upgrading DSH.** Every internal call degrades gracefully: failures are logged, never fatal to the handoff.

## Roadmap

- [ ] Complete `childMode: "none"` client-half wiring and regression
- [ ] User-defined card templates
- [ ] Include recently run commands in the card
- [ ] Publish to npm / the DSH plugin market for one-click install

## License

MIT © 2026 XWIDE
