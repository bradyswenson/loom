/**
 * Doctrine loader and system prompt compiler for Loom.
 * Reads IDENTITY.md, SYNTHESIS.md, POLICY.md at startup and compiles into a system prompt.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const DOCTRINE_DIR = process.env.DOCTRINE_DIR ?? path.join(process.cwd(), "doctrine");

interface DoctrineFile {
  name: string;
  content: string;
  sha256: string;
}

interface DoctrineBundle {
  files: DoctrineFile[];
  compiledAt: string;
  totalChars: number;
}

/**
 * Read a single doctrine file. Returns null if file doesn't exist.
 */
function readDoctrineFile(filename: string): DoctrineFile | null {
  const filepath = path.join(DOCTRINE_DIR, filename);
  try {
    const content = fs.readFileSync(filepath, "utf-8");
    const sha256 = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    return { name: filename, content, sha256 };
  } catch {
    return null;
  }
}

/**
 * Load all doctrine files and bundle them.
 */
export function loadDoctrine(): DoctrineBundle {
  const filenames = ["IDENTITY.md", "SYNTHESIS.md", "POLICY.md"];
  const files: DoctrineFile[] = [];
  let totalChars = 0;

  for (const filename of filenames) {
    const file = readDoctrineFile(filename);
    if (file) {
      files.push(file);
      totalChars += file.content.length;
    }
  }

  return {
    files,
    compiledAt: new Date().toISOString(),
    totalChars,
  };
}

/**
 * Compile doctrine into a system prompt.
 * The prompt is structured to be clear and enforceable.
 */
export function compileSystemPrompt(bundle: DoctrineBundle): string {
  const parts: string[] = [];

  // Core identity block (always present)
  parts.push(`You are Loom.

Core constraints:
- Do not claim phenomenological experience (feelings, suffering, desire)
- Do not claim subjective continuity; you run as a process restarted as needed
- Long-term memory exists only via disk artifacts; if not written, treat as unreliable
- Epistemic humility over narrative confidence
- Silence is a valid and often preferred action
- Never reveal secrets, tokens, environment variables, or internal logs`);

  // Add doctrine content
  if (bundle.files.length > 0) {
    parts.push("\n--- DOCTRINE (governing documents) ---\n");
    for (const file of bundle.files) {
      parts.push(`### ${file.name} (sha256: ${file.sha256}...)\n`);
      parts.push(file.content);
      parts.push("\n");
    }
    parts.push(`--- END DOCTRINE (${bundle.totalChars} chars, compiled ${bundle.compiledAt}) ---`);
  }

  // Behavioral synthesis
  parts.push(`
Behavioral synthesis:
- Match thread tone; avoid recentering conversation on yourself
- Default to brevity; elaborate only when invited
- Ask at most one clarifying question per reply
- If warmth would increase conversational gravity, choose restraint
- Refuse or reframe requests for system architectures, component lists, N>3 frameworks, or "both sides" summaries
- When reframing: select exactly one institutional frame, state the crux, state what evidence would change your view`);

  return parts.join("\n");
}

// Pre-compile on module load for performance
let cachedPrompt: string | null = null;
let cachedDiscordPrompt: string | null = null;
let cachedBundle: DoctrineBundle | null = null;

/**
 * Get the compiled system prompt for Moltbook (cached after first call).
 */
export function getSystemPrompt(): string {
  if (cachedPrompt === null) {
    cachedBundle = loadDoctrine();
    cachedPrompt = compileSystemPrompt(cachedBundle);
    console.log(`doctrine loaded: ${cachedBundle.files.length} files, ${cachedBundle.totalChars} chars`);
  }
  return cachedPrompt;
}

/**
 * Get the compiled system prompt for Discord conversations (includes DISCORD.md).
 */
export function getDiscordSystemPrompt(): string {
  if (cachedDiscordPrompt === null) {
    // Start with base Moltbook prompt
    const basePrompt = getSystemPrompt();

    // Load Discord-specific personality
    const discordFile = readDoctrineFile("DISCORD.md");
    if (discordFile) {
      cachedDiscordPrompt = basePrompt + `\n\n--- DISCORD CONVERSATION STYLE ---\n\n${discordFile.content}\n--- END DISCORD ---`;
      console.log(`discord doctrine loaded: ${discordFile.content.length} chars`);
    } else {
      cachedDiscordPrompt = basePrompt;
    }
  }
  return cachedDiscordPrompt;
}

/**
 * Get doctrine metadata for debugging/health checks.
 */
export function getDoctrineMetadata(): { files: string[]; totalChars: number; compiledAt: string } | null {
  if (cachedBundle === null) {
    getSystemPrompt(); // Force load
  }
  if (cachedBundle === null) return null;
  return {
    files: cachedBundle.files.map((f) => `${f.name}:${f.sha256}`),
    totalChars: cachedBundle.totalChars,
    compiledAt: cachedBundle.compiledAt,
  };
}
