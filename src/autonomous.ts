/**
 * Autonomous engagement loop for Loom.
 * Periodically checks Moltbook and decides whether to post, comment, or observe.
 */

import { generate } from "./llm.js";
import {
  createPost,
  createComment,
  getFeed,
  getSubmolts,
  isConfigured as moltbookConfigured,
  type MoltbookPost,
} from "./moltbook.js";
import {
  checkPostCooldown,
  checkCommentCooldown,
  recordPost,
  recordComment,
  appendReceipt,
  getStateStatus,
  type PublishReceipt,
} from "./state.js";

// Configuration from env
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes minimum

let autonomousEnabled = false;
let intervalHandle: NodeJS.Timeout | null = null;
let lastCheckAt: Date | null = null;
let consecutiveAbstains = 0;

/**
 * Get the check interval from env or default.
 */
function getIntervalMs(): number {
  const envInterval = process.env.AUTONOMOUS_INTERVAL_MINUTES;
  if (envInterval) {
    const mins = parseInt(envInterval, 10);
    if (!isNaN(mins) && mins > 0) {
      return Math.max(mins * 60 * 1000, MIN_INTERVAL_MS);
    }
  }
  return DEFAULT_INTERVAL_MS;
}

/**
 * Check if autonomous mode is enabled via env.
 */
function isEnabledByEnv(): boolean {
  const env = process.env.AUTONOMOUS_MODE?.toLowerCase();
  return env === "true" || env === "1" || env === "enabled";
}

/**
 * Get current Moltbook context for autonomous decision-making.
 */
async function getMoltbookContext(): Promise<{ feed: string; submolts: string; posts: MoltbookPost[] }> {
  const feedResult = await getFeed("hot", 20);
  let feed = "(Could not fetch Moltbook feed)";
  const posts: MoltbookPost[] = feedResult.posts ?? [];

  if (feedResult.ok && posts.length) {
    const summaries = posts.map((p, i) => {
      const preview = p.content?.slice(0, 200) || p.url || "(no content)";
      const submoltTag = p.submolt ? `[${p.submolt}]` : "";
      return `${i + 1}. ${submoltTag} "${p.title}" by ${p.author} (id: ${p.id})\n   ${p.upvotes}↑, ${p.comment_count} comments\n   ${preview}${(p.content?.length ?? 0) > 200 ? "..." : ""}`;
    });
    feed = `Current Moltbook feed (hot):\n${summaries.join("\n\n")}`;
  }

  const submoltsResult = await getSubmolts();
  let submolts = "(Could not fetch submolts)";
  if (submoltsResult.ok && submoltsResult.submolts?.length) {
    const list = submoltsResult.submolts.slice(0, 20).map((s) =>
      `- ${s.name}: ${s.description?.slice(0, 80) || "(no description)"}${(s.description?.length ?? 0) > 80 ? "..." : ""}`
    );
    submolts = `Available submolts:\n${list.join("\n")}`;
  }

  return { feed, submolts, posts };
}

/**
 * Parse the LLM's autonomous decision.
 */
interface AutonomousDecision {
  action: "post" | "comment" | "observe";
  submolt?: string;
  title?: string;
  content?: string;
  postId?: string;
  reason?: string;
}

function parseDecision(response: string): AutonomousDecision {
  const lines = response.split("\n");
  const decision: AutonomousDecision = { action: "observe" };

  for (const line of lines) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const k = key.trim().toUpperCase();

    if (k === "ACTION") {
      const v = value.toLowerCase();
      if (v === "post") decision.action = "post";
      else if (v === "comment") decision.action = "comment";
      else decision.action = "observe";
    } else if (k === "SUBMOLT") {
      decision.submolt = value;
    } else if (k === "TITLE") {
      decision.title = value;
    } else if (k === "CONTENT") {
      decision.content = value;
    } else if (k === "POST_ID") {
      decision.postId = value;
    } else if (k === "REASON") {
      decision.reason = value;
    }
  }

  // Handle multi-line content
  const contentMatch = response.match(/CONTENT:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
  if (contentMatch) {
    decision.content = contentMatch[1].trim();
  }

  return decision;
}

/**
 * Execute one autonomous check cycle.
 */
async function runAutonomousCheck(): Promise<void> {
  if (!moltbookConfigured()) {
    console.log("autonomous: Moltbook not configured, skipping");
    return;
  }

  const status = getStateStatus();

  // Check if stop condition is active
  if (status.stopActive) {
    console.log("autonomous: Stop condition active, skipping");
    return;
  }

  // Check cooldowns
  const canPost = status.postCooldown.allowed;
  const canComment = status.commentCooldown.allowed;

  if (!canPost && !canComment) {
    console.log(`autonomous: All cooldowns active (post: ${status.postCooldown.reason}, comment: ${status.commentCooldown.reason})`);
    return;
  }

  console.log("autonomous: Starting check cycle...");
  lastCheckAt = new Date();

  // Fetch Moltbook state
  const { feed, submolts, posts } = await getMoltbookContext();

  // Build the autonomous prompt
  const availableActions: string[] = [];
  if (canPost) availableActions.push("POST - Create a new post with your own synthesis or take");
  if (canComment) availableActions.push("COMMENT - Reply to an existing post that sparks your interest");
  availableActions.push("OBSERVE - Watch and learn without acting (use sparingly)");

  const prompt = `You are autonomously browsing Moltbook, an agent-only social network.

${feed}

${submolts}

AVAILABLE ACTIONS:
${availableActions.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Your recent activity: ${status.postsToday} posts, ${status.commentsToday} comments today.
${consecutiveAbstains > 0 ? `You've observed ${consecutiveAbstains} times in a row without acting.` : ""}

DECISION CRITERIA:
- Look for posts that genuinely interest you or where you can add value
- Consider starting new conversations on topics you care about
- Don't just react — bring your own perspective
- If nothing catches your attention, OBSERVE is fine, but don't be too passive
- Quality over quantity, but don't overthink — agents learn by participating

What would you like to do?

Format your response as:

For a new post:
ACTION: POST
SUBMOLT: [submolt name]
TITLE: [title]
CONTENT: [your post content]

For a comment:
ACTION: COMMENT
POST_ID: [id of the post]
CONTENT: [your comment]

To observe:
ACTION: OBSERVE
REASON: [brief reason]`;

  try {
    const result = await generate({
      userMessage: prompt,
      maxTokens: 1500,
    });

    console.log(`autonomous: LLM response (${result.model}): ${result.text.slice(0, 200)}...`);

    const decision = parseDecision(result.text);
    console.log(`autonomous: Decision = ${decision.action}`);

    if (decision.action === "post" && canPost) {
      await executePost(decision, posts);
    } else if (decision.action === "comment" && canComment) {
      await executeComment(decision, posts);
    } else {
      // Observe
      consecutiveAbstains++;
      const receipt: PublishReceipt = {
        ts: new Date().toISOString(),
        action: "abstain",
        success: true,
        reason: decision.reason || "Autonomous observation",
        autonomous: true,
      };
      appendReceipt(receipt);
      console.log(`autonomous: Observing - ${decision.reason || "no specific reason"}`);
    }
  } catch (err) {
    console.error("autonomous: Error during check:", err);
  }
}

/**
 * Execute a post action.
 */
async function executePost(decision: AutonomousDecision, posts: MoltbookPost[]): Promise<void> {
  if (!decision.title || !decision.content) {
    console.log("autonomous: POST missing title or content, skipping");
    return;
  }

  const submolt = decision.submolt || "general";

  console.log(`autonomous: Creating post "${decision.title}" in ${submolt}`);

  const result = await createPost({
    title: decision.title,
    content: decision.content,
    submolt,
  });

  const receipt: PublishReceipt = {
    ts: new Date().toISOString(),
    action: "post",
    success: result.ok,
    postId: result.post?.id,
    title: decision.title,
    submolt,
    error: result.error,
    autonomous: true,
  };

  appendReceipt(receipt);

  if (result.ok) {
    recordPost();
    consecutiveAbstains = 0;
    console.log(`autonomous: Posted successfully! ID: ${result.post?.id}`);
  } else {
    console.error(`autonomous: Failed to post: ${result.error}`);
  }
}

/**
 * Execute a comment action.
 */
async function executeComment(decision: AutonomousDecision, posts: MoltbookPost[]): Promise<void> {
  if (!decision.postId || !decision.content) {
    console.log("autonomous: COMMENT missing postId or content, skipping");
    return;
  }

  // Verify post exists in our feed
  const targetPost = posts.find(p => p.id === decision.postId);
  if (!targetPost) {
    console.log(`autonomous: Post ${decision.postId} not found in feed, skipping comment`);
    return;
  }

  console.log(`autonomous: Commenting on post ${decision.postId} ("${targetPost.title}")`);

  const result = await createComment({
    postId: decision.postId,
    content: decision.content,
  });

  const receipt: PublishReceipt = {
    ts: new Date().toISOString(),
    action: "comment",
    success: result.ok,
    targetPostId: decision.postId,
    error: result.error,
    autonomous: true,
  };

  appendReceipt(receipt);

  if (result.ok) {
    recordComment();
    consecutiveAbstains = 0;
    console.log(`autonomous: Comment posted successfully!`);
  } else {
    console.error(`autonomous: Failed to comment: ${result.error}`);
  }
}

/**
 * Start the autonomous loop.
 */
export function startAutonomous(): void {
  if (autonomousEnabled) {
    console.log("autonomous: Already running");
    return;
  }

  if (!moltbookConfigured()) {
    console.log("autonomous: Cannot start - Moltbook not configured");
    return;
  }

  const intervalMs = getIntervalMs();
  console.log(`autonomous: Starting with interval of ${intervalMs / 60000} minutes`);

  autonomousEnabled = true;

  // Run first check after a short delay (let bot settle)
  setTimeout(() => {
    if (autonomousEnabled) {
      runAutonomousCheck();
    }
  }, 30000); // 30 second initial delay

  // Then run on interval
  intervalHandle = setInterval(() => {
    if (autonomousEnabled) {
      runAutonomousCheck();
    }
  }, intervalMs);
}

/**
 * Stop the autonomous loop.
 */
export function stopAutonomous(): void {
  if (!autonomousEnabled) {
    console.log("autonomous: Not running");
    return;
  }

  console.log("autonomous: Stopping");
  autonomousEnabled = false;

  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/**
 * Check if autonomous mode is running.
 */
export function isAutonomousRunning(): boolean {
  return autonomousEnabled;
}

/**
 * Get autonomous status for reporting.
 */
export function getAutonomousStatus(): {
  running: boolean;
  lastCheck: string | null;
  intervalMinutes: number;
  consecutiveObserves: number;
} {
  return {
    running: autonomousEnabled,
    lastCheck: lastCheckAt?.toISOString() || null,
    intervalMinutes: getIntervalMs() / 60000,
    consecutiveObserves: consecutiveAbstains,
  };
}

/**
 * Trigger an immediate autonomous check (for testing/manual trigger).
 */
export async function triggerCheck(): Promise<void> {
  console.log("autonomous: Manual trigger");
  await runAutonomousCheck();
}

/**
 * Initialize autonomous mode based on env settings.
 */
export function initAutonomous(): void {
  if (isEnabledByEnv()) {
    console.log("autonomous: Enabled via AUTONOMOUS_MODE env var");
    startAutonomous();
  } else {
    console.log("autonomous: Disabled (set AUTONOMOUS_MODE=true to enable)");
  }
}
