/**
 * Configurable LLM wrapper for Loom.
 * Supports OpenAI and Anthropic via LLM_PROVIDER env var.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "./doctrine.js";

export type LLMProvider = "openai" | "anthropic";

const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

/**
 * Resolve which provider to use from env.
 */
function getProvider(): LLMProvider {
  const env = process.env.LLM_PROVIDER?.toLowerCase().trim();
  if (env === "anthropic" || env === "claude") return "anthropic";
  return "openai"; // Default
}

/**
 * Get the model name from env or use default for the provider.
 */
function getModel(provider: LLMProvider): string {
  const envModel = process.env.LLM_MODEL?.trim();
  if (envModel) return envModel;
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL;
}

export interface GenerateOptions {
  userMessage: string;
  conversationContext?: string; // Recent messages for context
  maxTokens?: number;
}

export interface GenerateResult {
  text: string;
  provider: LLMProvider;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Generate a response using the configured LLM provider.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const provider = getProvider();
  const model = getModel(provider);
  const systemPrompt = getSystemPrompt();
  const maxTokens = options.maxTokens ?? 1024;

  // Build user message with optional context
  let userContent = options.userMessage;
  if (options.conversationContext) {
    userContent = `Recent context:\n${options.conversationContext}\n\nCurrent message: ${options.userMessage}`;
  }

  if (provider === "anthropic") {
    return generateAnthropic(systemPrompt, userContent, model, maxTokens);
  } else {
    return generateOpenAI(systemPrompt, userContent, model, maxTokens);
  }
}

async function generateOpenAI(
  systemPrompt: string,
  userContent: string,
  model: string,
  maxTokens: number
): Promise<GenerateResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set");
  }

  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    max_completion_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });

  const text = response.choices[0]?.message?.content ?? "";
  return {
    text: text.trim(),
    provider: "openai",
    model,
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
  };
}

async function generateAnthropic(
  systemPrompt: string,
  userContent: string,
  model: string,
  maxTokens: number
): Promise<GenerateResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text : "";

  return {
    text: text.trim(),
    provider: "anthropic",
    model,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
  };
}

/**
 * Get current LLM configuration for debugging/health checks.
 */
export function getLLMConfig(): { provider: LLMProvider; model: string } {
  const provider = getProvider();
  return { provider, model: getModel(provider) };
}
