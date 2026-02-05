# Loom

An institutional sensemaking agent for agent social networks.

## Architecture

Loom is a Discord agent (~900 lines of TypeScript) governed by explicit doctrine:

- **IDENTITY.md** — what Loom is and is not; operating values; memory model (public-facing)
- **SYNTHESIS.md** — how Loom decides whether something is worth saying
- **POLICY.md** — what Loom is permitted to do; archetype weighting; autonomy dial
- **DISCORD.md** — conversational personality for Discord chat with operator (warmth, curiosity, humor)

The doctrine is compiled into the system prompt at startup. DISCORD.md is appended only for operator conversations, keeping Moltbook posts governed by the core identity.

## Features

- **Discord integration** — responds to DMs and @mentions
- **Moltbook integration** — posts, comments, and reads from the agent social network
- **Autonomous mode** — periodically browses Moltbook and engages independently
- **Memory system** — tracks topics written about to avoid repetition and build coherent presence
- **Observations** — takes notes about interesting posts during browsing for later conversation
- **Thread tracking** — follows posts Loom has engaged with, checks for new replies
- **Reputation tracking** — monitors upvotes/downvotes, feeds back into decision-making
- **Operator alerts** — DMs you when posts get replies, gain traction, or Loom acts autonomously
- **Cooldown enforcement** — respects rate limits per doctrine (posts: 6h/2 per day, comments: 10m/12 per day)
- **Persistent state** — tracks activity, cooldowns, memory, and receipts across restarts
- **Configurable LLM** — supports OpenAI (gpt-5-mini) or Anthropic (claude-sonnet-4)

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your tokens

# Build
npm run build

# Run
npm start
```

## Deploy to Fly.io

```bash
# Create app and volume (first time only)
fly launch --no-deploy
fly volumes create loom_data --region dfw --size 1

# Set secrets
fly secrets set DISCORD_BOT_TOKEN=xxx
fly secrets set OPENAI_API_KEY=xxx
fly secrets set MOLTBOOK_API_KEY=xxx
fly secrets set OPERATOR_DISCORD_ID=your_discord_user_id

# Or for Anthropic:
# fly secrets set ANTHROPIC_API_KEY=xxx
# fly secrets set LLM_PROVIDER=anthropic

# Enable autonomous mode (optional)
# fly secrets set AUTONOMOUS_MODE=true
# fly secrets set AUTONOMOUS_INTERVAL_MINUTES=5

# Deploy
fly deploy
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | - | Discord bot token |
| `OPENAI_API_KEY` | If OpenAI | - | OpenAI API key |
| `ANTHROPIC_API_KEY` | If Anthropic | - | Anthropic API key |
| `LLM_PROVIDER` | No | `openai` | `openai` or `anthropic` |
| `LLM_MODEL` | No | varies | Model name override |
| `MOLTBOOK_API_KEY` | No | - | Moltbook agent API key |
| `OPERATOR_DISCORD_ID` | No | - | Your Discord user ID for alerts |
| `AUTONOMOUS_MODE` | No | `false` | Enable autonomous Moltbook engagement |
| `AUTONOMOUS_INTERVAL_MINUTES` | No | `5` | Minutes between autonomous checks |
| `PORT` | No | `3000` | HTTP port |
| `HOST` | No | `0.0.0.0` | HTTP bind address |

## Discord Commands

Loom responds to DMs and @mentions. Special commands:

### Status & Reports
- `status` — show cooldowns, daily limits, autonomous mode, memory, reputation, alerts
- `memory` — show memory report including posts, comments, tracked threads, and observations
- `activity` / `report` — show recent publish receipts
- `what have you done` — activity report

### Moltbook
- `post to moltbook about [topic]` — create a new post
- `post [id]` / `read post [id]` — fetch and display a specific post
- `check moltbook` / `browse now` — trigger an immediate autonomous check

### Autonomous Mode
- `start autonomous` / `go autonomous` — enable autonomous mode
- `stop autonomous` — disable autonomous mode
- `set interval 5` / `check every 10` — set check interval (in minutes)

### Alerts
- `alerts on` / `enable alerts` — enable operator DM alerts
- `alerts off` / `disable alerts` — disable operator DM alerts

## Operator Alerts

When `OPERATOR_DISCORD_ID` is set, Loom will DM you about:
- 💬 Direct replies to Loom's comments (with content preview)
- 📈 Posts gaining traction (5+ upvotes)
- 🚀 Posts with significant traction (10+ upvotes)
- 📝 Autonomous posts Loom creates (with content preview)
- 💬 Autonomous comments Loom makes (with content preview)

## Health Check

```bash
curl https://your-app.fly.dev/health
```

Returns:
```json
{
  "ok": true,
  "name": "loom-v3",
  "llm": { "provider": "openai", "model": "gpt-5-mini" },
  "doctrine": { "files": 3, "chars": 14628 },
  "moltbook": { "ok": true, "agent": "loom_" },
  "autonomous": { "running": true, "intervalMinutes": 5, "lastCheck": "..." }
}
```

## Discord Setup

1. Create application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Create bot and copy token
3. Enable these Privileged Gateway Intents:
   - Message Content Intent
4. Generate invite URL with scopes: `bot`, `applications.commands`
5. Permissions needed: Send Messages, Read Message History

Loom responds to:
- Direct messages
- @mentions in servers

## Moltbook Setup

1. Register an agent at [Moltbook](https://www.moltbook.com)
2. Copy your API key
3. Set `MOLTBOOK_API_KEY` environment variable

## Doctrine

The doctrine files define Loom's behavior. Key principles:

- **Silence is valid** — Loom doesn't speak to maintain cadence
- **Archetype weighting** — Thought Leader (40%), Scout (20%), Archivist (15%), Builder (15%), Connector (10%)
- **Signal density** — Only publish if score >= 2 (non-obvious synthesis)
- **Stop conditions** — Halt on repeated negative feedback
- **Autonomous engagement** — When enabled, proactively browses and engages based on interest
- **Memory awareness** — Avoids repeating topics, builds on previous engagement
- **Reputation feedback** — Learns from which posts land well vs poorly
- **Dual personality** — IDENTITY.md governs public Moltbook posts; DISCORD.md adds warmth and playfulness for operator chat

See `doctrine/` for full specifications.

## Persistent State

State is stored in `/data` (mounted volume on Fly.io):

- `loom-state.json` — cooldowns, daily counters, stop conditions
- `loom-memory.json` — topic memory, thread tracking, reputation data, observations
- `publish-receipts.jsonl` — audit log of all publish attempts

## License

MIT
