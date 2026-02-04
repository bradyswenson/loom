/**
 * Loom v3 - Entry point
 *
 * A minimal Discord agent with configurable LLM backend.
 * Designed for Fly.io deployment with persistent state.
 */

import http from "http";
import { startDiscord } from "./discord.js";
import { getDoctrineMetadata } from "./doctrine.js";
import { getLLMConfig } from "./llm.js";
import { checkConnection as checkMoltbook, isConfigured as moltbookConfigured } from "./moltbook.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

// Moltbook connection status (updated async)
let moltbookStatus: { ok: boolean; agent?: string; error?: string } | null = null;

/**
 * Simple HTTP server for health checks (required by Fly.io).
 */
function startHealthServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const doctrine = getDoctrineMetadata();
      const llm = getLLMConfig();

      const health = {
        ok: true,
        name: "loom-v3",
        timestamp: new Date().toISOString(),
        llm,
        doctrine: doctrine ? {
          files: doctrine.files.length,
          chars: doctrine.totalChars,
          compiledAt: doctrine.compiledAt,
        } : null,
        moltbook: moltbookStatus,
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health, null, 2));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`health: listening on ${HOST}:${PORT}`);
  });

  return server;
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  console.log("loom-v3: starting...");

  // Validate required env vars
  const llmConfig = getLLMConfig();
  const requiredKey = llmConfig.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";

  if (!process.env[requiredKey]) {
    console.error(`loom-v3: ${requiredKey} not set`);
    process.exit(1);
  }

  // Start health server (Fly.io requires HTTP)
  startHealthServer();

  // Start Discord client
  const discordClient = await startDiscord();

  if (!discordClient) {
    console.log("loom-v3: running in health-only mode (no DISCORD_BOT_TOKEN)");
  }

  // Check Moltbook connection
  if (moltbookConfigured()) {
    moltbookStatus = await checkMoltbook();
    if (moltbookStatus.ok) {
      console.log(`moltbook: connected as ${moltbookStatus.agent}`);
    } else {
      console.error(`moltbook: connection failed - ${moltbookStatus.error}`);
    }
  } else {
    console.log("moltbook: MOLTBOOK_API_KEY not set, skipping");
    moltbookStatus = { ok: false, error: "not configured" };
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`loom-v3: received ${signal}, shutting down...`);
    if (discordClient) {
      discordClient.destroy();
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const surfaces = [
    discordClient ? "discord" : null,
    moltbookStatus?.ok ? "moltbook" : null,
  ].filter(Boolean).join(", ") || "none";
  console.log(`loom-v3: ready (provider=${llmConfig.provider}, model=${llmConfig.model}, surfaces=${surfaces})`);
}

main().catch((err) => {
  console.error("loom-v3: fatal error", err);
  process.exit(1);
});
