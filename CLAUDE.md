# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Loom v3 is an institutional sensemaking agent for agent social networks. It's a Discord bot (~500 lines of TypeScript core) governed by explicit doctrine compiled into the system prompt at startup. It integrates with Moltbook (an agent-only social network) and can operate autonomously.

## Commands

```bash
# Install dependencies
npm install

# Build TypeScript to dist/
npm run build

# Run the built application
npm start

# Development mode (ts-node)
npm run dev
```

No test or lint commands are configured.

### Fly.io Deployment

```bash
fly launch --no-deploy
fly volumes create loom_data --region dfw --size 1
fly secrets set DISCORD_BOT_TOKEN=xxx OPENAI_API_KEY=xxx MOLTBOOK_API_KEY=xxx
fly secrets set AUTONOMOUS_MODE=true  # Optional: enable autonomous mode
fly deploy
```

## Architecture

### Core Flow
Discord message → `discord.ts` → Command handler or LLM → Response or Moltbook action

Autonomous mode: Timer → `autonomous.ts` → LLM decides action → Moltbook post/comment/observe

### Key Files

- **`src/index.ts`** — Entry point: HTTP health server + Discord client + autonomous init
- **`src/discord.ts`** — Core interaction logic: handles DMs/@mentions, commands, routes to LLM or Moltbook
- **`src/llm.ts`** — LLM abstraction supporting OpenAI and Anthropic providers
- **`src/doctrine.ts`** — Loads doctrine/*.md files, compiles into system prompt with metadata
- **`src/state.ts`** — Persistent state management (cooldowns, receipts, stop conditions) in /data volume
- **`src/moltbook.ts`** — REST client for Moltbook API (posts, comments, feed, submolts)
- **`src/autonomous.ts`** — Autonomous engagement loop for proactive Moltbook participation

### Doctrine System

Three markdown files define Loom's behavior (loaded at startup, not mutated at runtime):

- **`doctrine/IDENTITY.md`** — What Loom is/isn't; epistemic humility; memory model
- **`doctrine/SYNTHESIS.md`** — Publishing decision rules; signal density rubric; hard refusals
- **`doctrine/POLICY.md`** — Archetype weighting; autonomy dial; cooldowns; stop conditions; autonomous behavior (P8-P10)

### State Management

- **Stateless per invocation** — No in-memory state between requests
- **Disk persistence** in `/data`:
  - `loom-state.json` — Cooldowns, feedback counts, stop conditions
  - `publish-receipts.jsonl` — Audit log of all publications (includes autonomous=true flag)

### Discord Commands

Status & Reports:
- `status` — Show cooldowns, daily limits, autonomous mode status
- `activity` / `report` — Show recent publish receipts

Moltbook:
- `post to moltbook about [topic]` — Create a new post (forces POST action)
- `post [id]` / `read post [id]` — Fetch and display a specific post with top comments

Autonomous Mode:
- `start autonomous` / `go autonomous` — Enable autonomous mode
- `stop autonomous` — Disable autonomous mode
- `check moltbook` / `browse now` — Trigger immediate autonomous check

### Key Constraints

- Post cooldown: 6h minimum, 2/day max
- Comment cooldown: 10m minimum, 12/day max
- Discord reply max: 1900 chars
- Context: Last 5 non-bot messages (200 chars each)
- Autonomous interval: 30m default (configurable)

## Environment Variables

Required:
- `DISCORD_BOT_TOKEN`
- `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (based on provider)

Optional:
- `LLM_PROVIDER` — `openai` (default) or `anthropic`
- `LLM_MODEL` — Model name override (default: `gpt-5-mini` or `claude-sonnet-4-20250514`)
- `MOLTBOOK_API_KEY` — For Moltbook integration
- `AUTONOMOUS_MODE` — `true` to enable autonomous Moltbook engagement
- `AUTONOMOUS_INTERVAL_MINUTES` — Minutes between autonomous checks (default: 30)
- `DATA_DIR` — State directory (default: `/data`)
- `DOCTRINE_DIR` — Doctrine directory (default: `./doctrine`)

## OpenAI API Note

The `gpt-5-mini` model requires `max_completion_tokens` instead of `max_tokens`. This is handled in `llm.ts`.
