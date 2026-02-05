# Loom

An institutional sensemaking agent for agent social networks.

## Architecture

Loom is a minimal Discord agent (~500 lines of TypeScript) governed by explicit doctrine:

- **IDENTITY.md** — what Loom is and is not; operating values; memory model
- **SYNTHESIS.md** — how Loom decides whether something is worth saying
- **POLICY.md** — what Loom is permitted to do; archetype weighting; autonomy dial

The doctrine is compiled into the system prompt at startup. No runtime mutation.

## Features

- **Discord integration** — responds to DMs and @mentions
- **Moltbook integration** — posts, comments, and reads from the agent social network
- **Autonomous mode** — periodically browses Moltbook and engages independently
- **Cooldown enforcement** — respects rate limits per doctrine (posts: 6h/2 per day, comments: 10m/12 per day)
- **Persistent state** — tracks activity, cooldowns, and receipts across restarts
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

# Or for Anthropic:
# fly secrets set ANTHROPIC_API_KEY=xxx
# fly secrets set LLM_PROVIDER=anthropic

# Enable autonomous mode (optional)
# fly secrets set AUTONOMOUS_MODE=true
# fly secrets set AUTONOMOUS_INTERVAL_MINUTES=30

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
| `AUTONOMOUS_MODE` | No | `false` | Enable autonomous Moltbook engagement |
| `AUTONOMOUS_INTERVAL_MINUTES` | No | `30` | Minutes between autonomous checks |
| `PORT` | No | `3000` | HTTP port |
| `HOST` | No | `0.0.0.0` | HTTP bind address |

## Discord Commands

Loom responds to DMs and @mentions. Special commands:

### Status & Reports
- `status` — show cooldowns, daily limits, autonomous mode status
- `activity` / `report` — show recent publish receipts
- `what have you done` — activity report

### Moltbook
- `post to moltbook about [topic]` — create a new post
- `post [id]` / `read post [id]` — fetch and display a specific post
- `check moltbook` / `browse now` — trigger an immediate autonomous check

### Autonomous Mode
- `start autonomous` / `go autonomous` — enable autonomous mode
- `stop autonomous` — disable autonomous mode

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
  "autonomous": { "running": true, "intervalMinutes": 30, "lastCheck": "..." }
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

See `doctrine/` for full specifications.

## Persistent State

State is stored in `/data` (mounted volume on Fly.io):

- `loom-state.json` — cooldowns, daily counters, stop conditions
- `publish-receipts.jsonl` — audit log of all publish attempts

## License

MIT
