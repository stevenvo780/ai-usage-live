# ai-usage-live

Terminal dashboard for local AI CLI usage — monitors Claude Code, Codex CLI, Gemini CLI, and Antigravity in a single btop-style TUI.

## Features

- **Real-time quota monitoring** for Claude, Codex, Gemini, and Antigravity
- **Effective token counting** — separates cache-read tokens from real consumption so Claude usage isn't inflated by prompt caching (cache reads can be 97%+ of reported totalTokens)
- **Live quota detection** from `claude /usage` and `gemini /stats model`
- **Codex rate-limit detection** from local session events
- **Model-by-model breakdown** with sorting by effective tokens
- **Auto-refresh** with configurable interval

## Installation

### From .deb package

```bash
bash package-ai-usage-live.sh
sudo dpkg -i dist/ai-usage-live_0.4.0_all.deb
```

### Manual

```bash
# Requires Node.js 18+ and optionally Python 3 for Gemini quota capture
chmod +x ai-usage-live ai-usage.sh ai-usage-quota
./ai-usage-live
```

## Commands

```bash
ai-usage-live                          # Interactive TUI
ai-usage-live --once                   # One-shot plain text summary
ai-usage-live daily all --refresh 5    # Auto-refresh every 5s
ai-usage-live daily antigravity        # Focus on Antigravity
ai-usage daily                         # ccusage daily summary
ai-usage claude blocks                 # Claude blocks view
ai-usage-quota show                    # Show quota config
ai-usage-quota edit                    # Edit quota limits
```

## TUI keys

```text
q exit
r refresh
1 daily, 2 weekly, 3 monthly, 4 session, 5 blocks
a all, c Claude, x Codex, g Gemini, v Antigravity
up/down select model
```

## Data sources

| Source | Method | Notes |
|---|---|---|
| Claude Code | `ccusage` local logs | Effective tokens = input + cacheCreate + output (excludes cache reads) |
| Claude quota | `claude -p /usage` | Reports session, weekly (all), weekly (Sonnet) percentages |
| Codex CLI | `ccusage` local logs + rate_limits from sessions | Auto-detects 5h and weekly windows |
| Gemini CLI | `ccusage` + `/stats model` capture | Cached 15min to avoid burning requests |
| Antigravity | Local transcript analysis | Sessions, model steps, activity timestamps |

## Why "effective tokens"?

Claude Code uses prompt caching aggressively. A typical session may show 918M `totalTokens`, but ~893M of those are **cache reads** — previously cached context being re-read at 90% discount. The actual new token consumption is only ~25M.

This dashboard shows **effective tokens** (input + cache creation + output) as the primary metric, with cache reads shown separately, so you get an accurate picture of your real consumption.

## Quota configuration

```bash
ai-usage-quota edit
```

Useful fields:

```json
{
  "claude": { "liveUsage": true, "liveUsageCacheSeconds": 60 },
  "gemini": { "liveCapture": true, "liveCaptureCacheMinutes": 15 },
  "antigravity": { "monthlyCredits": 1000, "usedCredits": 250, "resetsAt": "2026-07-01" }
}
```

Set `AI_USAGE_GEMINI_LIVE=0` or `"liveCapture": false` to disable Gemini CLI capture.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `REFRESH_SEC` | `10` | Auto-refresh interval in seconds |
| `AI_USAGE_CLAUDE_LIVE` | `1` | Set to `0` to disable Claude /usage |
| `AI_USAGE_GEMINI_LIVE` | `1` | Set to `0` to disable Gemini capture |
| `AI_USAGE_GEMINI_TIMEOUT` | `45` | Gemini capture timeout in seconds |
| `AI_USAGE_GEMINI_DEBUG_FILE` | — | Write raw Gemini capture output to file |

## License

MIT
