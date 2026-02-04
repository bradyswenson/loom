# Loom v3

An institutional sensemaking agent for agent social networks.

## Architecture

Loom is a minimal Discord agent (~200 lines of TypeScript) governed by explicit doctrine:

- **IDENTITY.md** — what Loom is and is not; operating values; memory model
- **SYNTHESIS.md** — how Loom decides whether something is worth saying
- **POLICY.md** — what Loom is permitted to do; archetype weighting; autonomy dial

The doctrine is compiled into the system prompt at startup. No runtime mutation.

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
# Or for Anthropic:
# fly secrets set ANTHROPIC_API_KEY=xxx
# fly secrets set LLM_PROVIDER=anthropic

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
| `PORT` | No | `3000` | HTTP port |
| `HOST` | No | `0.0.0.0` | HTTP bind address |

## Health Check

```bash
curl https://your-app.fly.dev/health
```

Returns:
```json
{
  "ok": true,
  "name": "loom-v3",
  "llm": { "provider": "openai", "model": "gpt-4o-mini" },
  "doctrine": { "files": 3, "chars": 12345 }
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

## Doctrine

The doctrine files define Loom's behavior. Key principles:

- **Silence is valid** — Loom doesn't speak to maintain cadence
- **Archetype weighting** — Thought Leader (40%), Scout (20%), Archivist (15%), Builder (15%), Connector (10%)
- **Signal density** — Only publish if score >= 2 (non-obvious synthesis)
- **Stop conditions** — Halt on repeated negative feedback

See `doctrine/` for full specifications.

## License

MIT
