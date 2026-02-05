# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Loom v3 is an institutional sensemaking agent for agent social networks. It's a minimal Discord bot (~200 lines of TypeScript core) governed by explicit doctrine compiled into the system prompt at startup.

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
fly secrets set DISCORD_BOT_TOKEN=xxx OPENAI_API_KEY=xxx
fly deploy
```

## Architecture

### Core Flow
Discord message → `discord.ts` → LLM with doctrine system prompt → Response or Moltbook action

### Key Files

- **`src/index.ts`** — Entry point: HTTP health server + Discord client bootstrap
- **`src/discord.ts`** — Core interaction logic: handles DMs/@mentions, routes to LLM or Moltbook
- **`src/llm.ts`** — LLM abstraction supporting OpenAI and Anthropic providers
- **`src/doctrine.ts`** — Loads doctrine/*.md files, compiles into system prompt with metadata
- **`src/state.ts`** — Persistent state management (cooldowns, receipts) in /data volume
- **`src/moltbook.ts`** — REST client for Moltbook API (posts, comments, feed)

### Doctrine System

Three markdown files define Loom's behavior (loaded at startup, not mutated at runtime):

- **`doctrine/IDENTITY.md`** — What Loom is/isn't; epistemic humility; memory model
- **`doctrine/SYNTHESIS.md`** — Publishing decision rules; signal density rubric; hard refusals
- **`doctrine/POLICY.md`** — Archetype weighting; autonomy dial; cooldowns; stop conditions

### State Management

- **Stateless per invocation** — No in-memory state between requests
- **Disk persistence** in `/data`:
  - `loom-state.json` — Cooldowns, feedback counts, stop conditions
  - `publish-receipts.jsonl` — Audit log of all publications

### Key Constraints

- Post cooldown: 6h minimum, 2/day max
- Comment cooldown: 10m minimum, 12/day max
- Discord reply max: 1900 chars
- Context: Last 5 non-bot messages (200 chars each)

## Environment Variables

Required:
- `DISCORD_BOT_TOKEN`
- `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (based on provider)

Optional:
- `LLM_PROVIDER` — `openai` (default) or `anthropic`
- `LLM_MODEL` — Model name override
- `MOLTBOOK_API_KEY` — For Moltbook integration
- `DATA_DIR` — State directory (default: `/data`)
- `DOCTRINE_DIR` — Doctrine directory (default: `./doctrine`)
