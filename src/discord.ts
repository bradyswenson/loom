/**
 * Discord client and message handling for Loom.
 * Responds to DMs and @mentions only.
 */

import { Client, GatewayIntentBits, Message, Partials, AttachmentBuilder } from "discord.js";
import { generate } from "./llm.js";
import { createPost, createComment, getFeed, getPost, getComments, getSubmolts, validateSubmolt, isConfigured as moltbookConfigured, type MoltbookPost } from "./moltbook.js";
import {
  checkPostCooldown,
  checkCommentCooldown,
  recordPost as recordPostState,
  recordComment as recordCommentState,
  appendReceipt,
  getStateStatus,
  getRecentReceipts,
  getCooldowns,
  setPostCooldownMinutes,
  setPostDailyLimit,
  setCommentCooldownMinutes,
  setCommentDailyLimit,
  resetCooldowns,
  addOperatorInstruction,
  removeOperatorInstruction,
  getOperatorInstructions,
  clearOperatorInstructions,
  getPrioritizedTopics,
  getWatchedTopics,
  clearPrioritizedTopics,
  type PublishReceipt,
} from "./state.js";
import {
  startAutonomous,
  stopAutonomous,
  isAutonomousRunning,
  getAutonomousStatus,
  triggerCheck,
  setIntervalMinutes,
} from "./autonomous.js";
import {
  recordPost as recordPostMemory,
  recordComment as recordCommentMemory,
  getMemoryStats,
  getReputationStats,
  readMemory,
  getBrowseContext,
  getObservationsContext,
  getEnhancedMemoryStats,
  getActiveGoals,
} from "./memory.js";
import {
  initAlerts,
  setAlertsEnabled,
  isAlertsEnabled,
  getAlertStatus,
} from "./alerts.js";

const MAX_REPLY_LENGTH = 1900; // Discord limit is 2000, leave room for safety
const RECENT_MESSAGE_WINDOW = 6;
const MAX_CONTEXT_MSG_LENGTH = 200;
const MAX_ATTACHMENT_SIZE = 50000; // 50KB max for text attachments

/**
 * Extract text content from message attachments.
 * Supports .md, .txt, and other text files.
 */
async function extractAttachmentText(message: Message): Promise<string | null> {
  if (!message.attachments || message.attachments.size === 0) {
    return null;
  }

  const textExtensions = [".md", ".txt", ".text", ".markdown"];
  const attachments = [...message.attachments.values()];

  for (const attachment of attachments) {
    const name = attachment.name?.toLowerCase() || "";
    const isTextFile = textExtensions.some(ext => name.endsWith(ext));

    if (!isTextFile) continue;
    if (attachment.size > MAX_ATTACHMENT_SIZE) {
      console.log(`discord: attachment ${attachment.name} too large (${attachment.size} bytes)`);
      continue;
    }

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        console.error(`discord: failed to fetch attachment ${attachment.name}: ${response.status}`);
        continue;
      }
      const text = await response.text();
      console.log(`discord: extracted ${text.length} chars from attachment ${attachment.name}`);
      return text;
    } catch (err) {
      console.error(`discord: error fetching attachment ${attachment.name}:`, err);
    }
  }

  return null;
}

/**
 * Strip bot mentions from message content.
 */
function stripBotMentions(content: string, botUserId: string): string {
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content
    .replace(new RegExp(`<@!?${escaped}>`, "gi"), "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build recent message context from the channel.
 */
async function buildContext(channel: Message["channel"], excludeId: string): Promise<string> {
  try {
    const messages = await channel.messages.fetch({ limit: RECENT_MESSAGE_WINDOW });
    const lines = [...messages.values()]
      .filter((m) => m.id !== excludeId && !m.author.bot)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-5)
      .map((m) => {
        const author = m.author.displayName ?? m.author.username ?? "?";
        const content = m.content.length > MAX_CONTEXT_MSG_LENGTH
          ? m.content.slice(0, MAX_CONTEXT_MSG_LENGTH) + "..."
          : m.content;
        return `${author}: ${content}`;
      });
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Check if the message is a request to post to Moltbook.
 */
function isMoltbookPostRequest(text: string): boolean {
  const lower = text.toLowerCase();
  const patterns = [
    /post\s+(this\s+)?(to|on)\s+moltbook/i,
    /share\s+(this\s+)?(to|on|with)\s+moltbook/i,
    /publish\s+(this\s+)?(to|on)\s+moltbook/i,
    /moltbook\s+post/i,
    /write\s+(a\s+)?moltbook\s+post/i,
  ];
  return patterns.some(p => p.test(lower));
}

/**
 * Extract the topic/content for a Moltbook post from the request.
 */
function extractPostTopic(text: string): string {
  // Remove the "post to moltbook" part and extract the topic
  const cleaned = text
    .replace(/post\s+(this\s+)?(to|on)\s+moltbook:?\s*/i, "")
    .replace(/share\s+(this\s+)?(to|on|with)\s+moltbook:?\s*/i, "")
    .replace(/publish\s+(this\s+)?(to|on)\s+moltbook:?\s*/i, "")
    .replace(/moltbook\s+post:?\s*/i, "")
    .replace(/write\s+(a\s+)?moltbook\s+post\s+(about|on):?\s*/i, "")
    .trim();
  return cleaned;
}

/**
 * Check if the request explicitly demands a POST (not comment).
 */
function isExplicitPostRequest(text: string): boolean {
  const lower = text.toLowerCase();
  // These patterns indicate the user explicitly wants a NEW POST, not a comment
  const explicitPatterns = [
    /\bpost\b.*\bto\b.*\bmoltbook/i,
    /\bpublish\b.*\bto\b.*\bmoltbook/i,
    /\bcreate\b.*\b(a\s+)?post/i,
    /\bnew\b.*\bpost/i,
    /\bwrite\b.*\b(a\s+)?moltbook\s+post/i,
    /\bmake\b.*\b(a\s+)?post/i,
  ];
  return explicitPatterns.some(p => p.test(lower));
}

/**
 * Check if message is a status request.
 */
function isStatusRequest(text: string): boolean {
  const patterns = [
    /^status$/i,
    /^loom status$/i,
    /^what('s| is) (your |the )?status/i,
    /^how are you doing/i,
    /^cooldown/i,
  ];
  return patterns.some(p => p.test(text.trim()));
}

/**
 * Check if message is an activity report request.
 */
function isActivityRequest(text: string): boolean {
  const patterns = [
    /^activity$/i,
    /^report$/i,
    /what have you (done|posted|written)/i,
    /what did you (do|post|write)/i,
    /recent (activity|posts|actions)/i,
    /show (me )?(your )?(activity|actions|posts|receipts)/i,
    /^history$/i,
  ];
  return patterns.some(p => p.test(text.trim()));
}

/**
 * Check if message is a memory request.
 */
function isMemoryRequest(text: string): boolean {
  const patterns = [
    /^memory$/i,
    /^what do you remember/i,
    /^what have you learned/i,
    /^show (me )?(your )?memory/i,
    /^threads$/i,
    /^tracked threads$/i,
  ];
  return patterns.some(p => p.test(text.trim()));
}

/**
 * Check if message is a commands/help request.
 */
function isCommandsRequest(text: string): boolean {
  const patterns = [
    /^\/?commands$/i,
    /^\/?help$/i,
    /^what can you do/i,
    /^show (me )?(your )?commands/i,
  ];
  return patterns.some(p => p.test(text.trim()));
}

/**
 * Format the commands help message.
 */
function formatCommandsHelp(): string {
  return `**Loom Commands**

📊 **Status & Reports**
• \`status\` — cooldowns, limits, autonomous mode, memory, alerts
• \`memory\` — posts, comments, threads, observations
• \`activity\` — recent publish receipts
• \`commands\` — this help message

🤖 **Autonomous Mode**
• \`start autonomous\` — enable autonomous browsing
• \`stop autonomous\` — disable autonomous browsing
• \`check moltbook\` — trigger immediate check
• \`set interval [N]\` — set check interval (minutes)

🎯 **Topic Directives**
• \`look for [topic]\` — watch for a topic (observations only)
• \`look for and publish about [topic]\` — seek AND post/comment about it
• \`focus on [topic]\` — same as publish
• \`list focuses\` — show current watch/publish topics
• \`clear focus [topic]\` — remove a specific focus
• \`clear all focuses\` — remove all focus topics
• \`block [post/topic]\` — don't engage with matching content
• \`list blocks\` — show blocked posts/topics

⏱️ **Cooldowns**
• \`set post cooldown [N]h\` or \`[N]m\` — set post interval
• \`set comment cooldown [N]m\` — set comment interval
• \`set post limit [N]\` — daily post limit
• \`set comment limit [N]\` — daily comment limit
• \`reset cooldowns\` — restore defaults

🔔 **Alerts**
• \`alerts on\` — enable operator DM alerts
• \`alerts off\` — disable operator DM alerts

📝 **Moltbook**
• \`post to moltbook about [topic]\` — create a new post
• \`read post [id]\` — fetch and display a post
• \`comment on [uuid]\` — comment on a post (e.g. comment on 8a828f9f-...)

🌐 **Dashboard**
• Visit https://loom-v3.fly.dev/dashboard for the web UI

💬 **Chat**
• Just talk to me naturally — I'll respond conversationally`;
}

/**
 * Build a brief state context for injecting into conversations.
 * This ensures Loom knows its actual current state instead of hallucinating.
 */
function buildStateContext(): string {
  const autoStatus = getAutonomousStatus();
  const memStats = getMemoryStats();
  const stateStatus = getStateStatus();

  const lines = ["Current state:"];

  // Autonomous mode
  if (autoStatus.running) {
    const lastCheck = autoStatus.lastCheck
      ? `${Math.round((Date.now() - new Date(autoStatus.lastCheck).getTime()) / 60000)}m ago`
      : "not yet";
    lines.push(`- Autonomous mode: ON (checking every ${autoStatus.intervalMinutes}m, last check: ${lastCheck})`);
  } else {
    lines.push("- Autonomous mode: OFF");
  }

  // Today's activity
  lines.push(`- Today: ${stateStatus.postsToday} posts, ${stateStatus.commentsToday} comments`);

  // Memory
  if (memStats.totalEntries > 0) {
    lines.push(`- Memory: ${memStats.posts} posts, ${memStats.comments} comments written; tracking ${memStats.trackedThreads} threads`);
  } else {
    lines.push("- Memory: empty (no posts or comments yet)");
  }

  return lines.join("\n");
}

/**
 * Format memory report for Discord.
 */
function formatMemoryReport(): string {
  const memory = readMemory();
  const lines: string[] = ["**Loom Memory Report**", ""];

  // Recent posts
  if (memory.entries.length === 0) {
    lines.push("📝 **Posts & Comments:** None yet");
  } else {
    const posts = memory.entries.filter(e => e.type === "post").slice(-5);
    const comments = memory.entries.filter(e => e.type === "comment").slice(-5);

    lines.push(`📝 **Recent Posts** (${memory.entries.filter(e => e.type === "post").length} total)`);
    if (posts.length === 0) {
      lines.push("• None yet");
    } else {
      for (const p of posts) {
        const age = Math.round((Date.now() - new Date(p.ts).getTime()) / 3600000);
        const auto = p.autonomous ? " 🤖" : "";
        lines.push(`• "${p.title?.slice(0, 40)}${(p.title?.length ?? 0) > 40 ? "..." : ""}"${auto} (${age}h ago)`);
      }
    }

    lines.push("");
    lines.push(`💬 **Recent Comments** (${memory.entries.filter(e => e.type === "comment").length} total)`);
    if (comments.length === 0) {
      lines.push("• None yet");
    } else {
      for (const c of comments) {
        const age = Math.round((Date.now() - new Date(c.ts).getTime()) / 3600000);
        const auto = c.autonomous ? " 🤖" : "";
        lines.push(`• On "${c.targetPostTitle?.slice(0, 30)}..."${auto} (${age}h ago)`);
      }
    }
  }

  // Tracked threads
  lines.push("");
  lines.push(`🧵 **Tracked Threads** (${memory.threads.length})`);
  if (memory.threads.length === 0) {
    lines.push("• None yet — will track posts after engaging");
  } else {
    for (const t of memory.threads.slice(-5)) {
      lines.push(`• "${t.postTitle.slice(0, 35)}${t.postTitle.length > 35 ? "..." : ""}" (${t.lastKnownUpvotes}↑, ${t.lastKnownCommentCount} replies)`);
    }
  }

  // Topics
  lines.push("");
  const stats = getMemoryStats();
  if (stats.topTopics.length > 0) {
    lines.push(`🏷️ **Top Topics:** ${stats.topTopics.join(", ")}`);
  } else {
    lines.push("🏷️ **Topics:** None tracked yet");
  }

  // Recent browse
  const browse = memory.recentBrowse || [];
  lines.push("");
  if (browse.length === 0) {
    lines.push("👀 **Last Browse:** None yet");
  } else {
    const browseAge = Math.round((Date.now() - new Date(browse[0].seenAt).getTime()) / 60000);
    lines.push(`👀 **Last Browse** (${browseAge}m ago, ${browse.length} posts)`);
    for (const p of browse.slice(0, 5)) {
      const submoltTag = p.submolt ? `[${p.submolt}]` : "";
      lines.push(`• ${submoltTag} "${p.title.slice(0, 35)}${p.title.length > 35 ? "..." : ""}" (${p.upvotes}↑)`);
    }
  }

  // Recent observations
  const observations = memory.observations || [];
  lines.push("");
  if (observations.length === 0) {
    lines.push("📓 **Notes:** None yet");
  } else {
    lines.push(`📓 **Recent Notes** (${observations.length} total)`);
    for (const o of observations.slice(-5)) {
      const age = Math.round((Date.now() - new Date(o.ts).getTime()) / 60000);
      const postRef = o.postTitle ? ` re: "${o.postTitle.slice(0, 25)}${o.postTitle.length > 25 ? "..." : ""}"` : "";
      lines.push(`• ${o.note.slice(0, 60)}${o.note.length > 60 ? "..." : ""}${postRef} (${age}m ago)`);
    }
  }

  return lines.join("\n");
}

/**
 * Check if message is an autonomous mode or config command.
 * Returns the command type and optional parameters.
 */
type CommandType = "start" | "stop" | "check" | "status" | "interval" | "alerts_on" | "alerts_off" |
  "post_cooldown" | "comment_cooldown" | "post_limit" | "comment_limit" | "reset_cooldowns";

function parseAutonomousCommand(text: string): { cmd: CommandType; param?: number } | null {
  const lower = text.toLowerCase().trim();

  // Cooldown commands
  // e.g., "set post cooldown 2h", "post cooldown 120m", "post cooldown 2 hours"
  const postCooldownMatch = lower.match(/(?:set\s+)?post\s+cooldown\s+(\d+)\s*(h|hours?|m|mins?|minutes?)?/);
  if (postCooldownMatch) {
    let minutes = parseInt(postCooldownMatch[1], 10);
    const unit = postCooldownMatch[2] || "m";
    if (unit.startsWith("h")) minutes *= 60;
    return { cmd: "post_cooldown", param: minutes };
  }

  // e.g., "set comment cooldown 5m", "comment cooldown 10 minutes"
  const commentCooldownMatch = lower.match(/(?:set\s+)?comment\s+cooldown\s+(\d+)\s*(m|mins?|minutes?)?/);
  if (commentCooldownMatch) {
    const minutes = parseInt(commentCooldownMatch[1], 10);
    return { cmd: "comment_cooldown", param: minutes };
  }

  // e.g., "set post limit 5", "post limit 3"
  const postLimitMatch = lower.match(/(?:set\s+)?post\s+limit\s+(\d+)/);
  if (postLimitMatch) {
    return { cmd: "post_limit", param: parseInt(postLimitMatch[1], 10) };
  }

  // e.g., "set comment limit 20", "comment limit 15"
  const commentLimitMatch = lower.match(/(?:set\s+)?comment\s+limit\s+(\d+)/);
  if (commentLimitMatch) {
    return { cmd: "comment_limit", param: parseInt(commentLimitMatch[1], 10) };
  }

  // Reset cooldowns
  if (/^reset\s+cooldowns?$/i.test(lower)) {
    return { cmd: "reset_cooldowns" };
  }

  // Start commands
  if (/^(start|enable|begin)\s+(autonomous|auto|autonomy)/.test(lower) ||
      /^autonomous\s+(on|start|enable)/.test(lower) ||
      /^go\s+autonomous/.test(lower)) {
    return { cmd: "start" };
  }

  // Stop commands
  if (/^(stop|disable|pause|halt)\s+(autonomous|auto|autonomy)/.test(lower) ||
      /^autonomous\s+(off|stop|disable|pause)/.test(lower)) {
    return { cmd: "stop" };
  }

  // Manual check/trigger
  if (/^(check|browse|look)\s+(moltbook|around|now)/.test(lower) ||
      /^moltbook\s+check/.test(lower) ||
      /^trigger\s+(check|autonomous)/.test(lower)) {
    return { cmd: "check" };
  }

  // Status (handled by formatStatusReport but for explicit autonomous status)
  if (/^autonomous\s+status/.test(lower)) {
    return { cmd: "status" };
  }

  // Set interval: "set interval 5" or "autonomous interval 10" or "check every 5 minutes"
  const intervalMatch = lower.match(/(?:set\s+)?(?:autonomous\s+)?interval\s+(\d+)|check\s+every\s+(\d+)/);
  if (intervalMatch) {
    const minutes = parseInt(intervalMatch[1] || intervalMatch[2], 10);
    if (!isNaN(minutes) && minutes > 0) {
      return { cmd: "interval", param: minutes };
    }
  }

  // Alert commands
  if (/^alerts?\s+(on|enable)/.test(lower) || /^enable\s+alerts?/.test(lower)) {
    return { cmd: "alerts_on" };
  }
  if (/^alerts?\s+(off|disable)/.test(lower) || /^disable\s+alerts?/.test(lower)) {
    return { cmd: "alerts_off" };
  }

  return null;
}

/**
 * Parse block/unblock instructions from operator.
 * Recognizes patterns like:
 * - "don't comment on X"
 * - "stop commenting on X"
 * - "don't engage with X"
 * - "block X" / "unblock X"
 * - "allow X" (removes block)
 */
function parseBlockInstruction(text: string): { action: "block" | "unblock" | "list" | "clear"; target?: string } | null {
  const lower = text.toLowerCase().trim();

  // List blocked posts
  if (/^(list|show)\s+(blocked|blocks)/.test(lower) || lower === "blocked" || lower === "blocks") {
    return { action: "list" };
  }

  // Clear all blocks
  if (/^clear\s+(all\s+)?blocks/.test(lower) || /^unblock\s+all/.test(lower)) {
    return { action: "clear" };
  }

  // Block patterns - extract the target (post title or keyword)
  const blockPatterns = [
    /(?:don'?t|do\s+not|stop)\s+(?:comment(?:ing)?|engage?(?:ing)?|post(?:ing)?)\s+(?:on|with|about)\s+[""]?(.+?)[""]?$/i,
    /(?:don'?t|do\s+not|stop)\s+(?:comment(?:ing)?|engage?(?:ing)?|post(?:ing)?)\s+(?:on|with|about)\s+[""]?(.+?)[""]?\s+(?:anymore|any\s+more|again)/i,
    /block\s+(?:post\s+)?[""]?(.+?)[""]?$/i,
    /ignore\s+(?:post\s+)?[""]?(.+?)[""]?$/i,
  ];

  for (const pattern of blockPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return { action: "block", target: match[1].trim() };
    }
  }

  // Unblock patterns
  const unblockPatterns = [
    /unblock\s+[""]?(.+?)[""]?$/i,
    /allow\s+(?:comments?\s+on\s+)?[""]?(.+?)[""]?$/i,
    /(?:you\s+can|ok\s+to)\s+(?:comment|engage|post)\s+(?:on|with)\s+[""]?(.+?)[""]?$/i,
  ];

  for (const pattern of unblockPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return { action: "unblock", target: match[1].trim() };
    }
  }

  return null;
}

/**
 * Parse focus/priority instructions from operator.
 * Recognizes patterns like:
 * - "look for X" → watch only (observations)
 * - "watch for X" → watch only (observations)
 * - "look for and publish about X" → publish (observations + posts + comments)
 * - "focus on X" → publish
 * - "publish about X" → publish
 * - "list focuses" / "show focuses"
 * - "clear focus on X" / "remove focus X"
 * - "clear all focuses"
 */
function parseFocusInstruction(text: string): { action: "watch" | "publish" | "unfocus" | "list" | "clear"; target?: string } | null {
  const lower = text.toLowerCase().trim();

  // List focus topics
  if (/^(list|show)\s+(focus(es)?|priorities|topics|watches)/.test(lower) || lower === "focuses" || lower === "priorities") {
    return { action: "list" };
  }

  // Clear all focuses
  if (/^clear\s+(all\s+)?(focus(es)?|priorities|topics|watches)/.test(lower)) {
    return { action: "clear" };
  }

  // PUBLISH patterns (can post/comment) - check these FIRST since "look for and publish" contains "look for"
  const publishPatterns = [
    /^look\s+for\s+and\s+publish\s+(?:about\s+)?[""]?(.+?)[""]?$/i,
    /^publish\s+about\s+[""]?(.+?)[""]?$/i,
    /^focus\s+on\s+[""]?(.+?)[""]?$/i,
    /^prioritize\s+[""]?(.+?)[""]?(?:\s+content)?$/i,
  ];

  for (const pattern of publishPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return { action: "publish", target: match[1].trim() };
    }
  }

  // WATCH patterns (observe only, no posting/commenting)
  const watchPatterns = [
    /^look\s+for\s+(?:posts?\s+)?(?:about\s+)?[""]?(.+?)[""]?$/i,
    /^watch\s+(?:for\s+)?[""]?(.+?)[""]?$/i,
    /^seek\s+(?:out\s+)?[""]?(.+?)[""]?$/i,
    /^track\s+[""]?(.+?)[""]?$/i,
  ];

  for (const pattern of watchPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return { action: "watch", target: match[1].trim() };
    }
  }

  // Unfocus patterns
  const unfocusPatterns = [
    /^(?:clear|remove|drop)\s+(?:focus|watch)\s+(?:on\s+)?[""]?(.+?)[""]?$/i,
    /^unfocus\s+[""]?(.+?)[""]?$/i,
    /^unwatch\s+[""]?(.+?)[""]?$/i,
    /^stop\s+(?:looking\s+for|focusing\s+on|prioritizing|watching)\s+[""]?(.+?)[""]?$/i,
  ];

  for (const pattern of unfocusPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return { action: "unfocus", target: match[1].trim() };
    }
  }

  return null;
}

/**
 * Format status report for Discord.
 */
function formatStatusReport(): string {
  const status = getStateStatus();
  const cooldowns = getCooldowns();
  const lines: string[] = [
    "**Loom Status Report**",
    "",
    `📊 **Today's Activity**`,
    `• Posts: ${status.postsToday}/${cooldowns.post.maxPerDay}`,
    `• Comments: ${status.commentsToday}/${cooldowns.comment.maxPerDay}`,
    "",
    `⏱️ **Cooldowns**`,
  ];

  if (status.postCooldown.allowed) {
    lines.push(`• Posts: Ready`);
  } else {
    lines.push(`• Posts: ${status.postCooldown.reason}`);
  }

  if (status.commentCooldown.allowed) {
    lines.push(`• Comments: Ready`);
  } else {
    lines.push(`• Comments: ${status.commentCooldown.reason}`);
  }

  if (status.stopActive) {
    lines.push("");
    lines.push(`⛔ **Stop Condition**`);
    lines.push(`• Halted until midnight UTC`);
  }

  // Add autonomous status
  const autoStatus = getAutonomousStatus();
  lines.push("");
  lines.push(`🤖 **Autonomous Mode**`);
  if (autoStatus.running) {
    lines.push(`• Status: Running (every ${autoStatus.intervalMinutes}m)`);
    if (autoStatus.lastCheck) {
      const lastCheck = new Date(autoStatus.lastCheck);
      const ago = Math.round((Date.now() - lastCheck.getTime()) / 60000);
      lines.push(`• Last check: ${ago}m ago`);
    }
    lines.push(`• Consecutive observes: ${autoStatus.consecutiveObserves}`);
  } else {
    lines.push(`• Status: Disabled`);
  }

  // Add memory stats (always show)
  const memStats = getMemoryStats();
  const enhancedStats = getEnhancedMemoryStats();
  const memory = readMemory();
  const browseCount = memory.recentBrowse?.length || 0;
  lines.push("");
  lines.push(`🧠 **Memory**`);
  if (memStats.totalEntries > 0) {
    lines.push(`• Written: ${memStats.posts} posts, ${memStats.comments} comments`);
    lines.push(`• Tracking: ${memStats.trackedThreads} threads`);
    if (memStats.topTopics.length > 0) {
      lines.push(`• Topics: ${memStats.topTopics.join(", ")}`);
    }
  } else {
    lines.push(`• Written: nothing yet`);
  }
  if (browseCount > 0) {
    const browseAge = Math.round((Date.now() - new Date(memory.recentBrowse[0].seenAt).getTime()) / 60000);
    lines.push(`• Last browse: ${browseCount} posts (${browseAge}m ago)`);
  } else {
    lines.push(`• Last browse: none`);
  }

  // Enhanced memory features
  if (enhancedStats.goals.active > 0) {
    lines.push(`• Active goals: ${enhancedStats.goals.active}`);
  }
  if (enhancedStats.compressedInsights > 0) {
    lines.push(`• Compressed insights: ${enhancedStats.compressedInsights} periods`);
  }
  if (enhancedStats.embeddings > 0) {
    lines.push(`• Semantic index: ${enhancedStats.embeddings} entries`);
  }

  // Add reputation stats
  const repStats = getReputationStats();
  if (repStats) {
    lines.push("");
    lines.push(`📈 **Reputation**`);
    lines.push(`• Total: ${repStats.totalUpvotes}↑, ${repStats.totalComments} replies`);
    lines.push(`• Avg: ${repStats.avgUpvotes.toFixed(1)}↑, ${repStats.avgComments.toFixed(1)} replies/post`);
    if (repStats.bestPost) {
      lines.push(`• Best: "${repStats.bestPost.title.slice(0, 30)}${repStats.bestPost.title.length > 30 ? "..." : ""}" (${repStats.bestPost.upvotes}↑)`);
    }
  }

  // Add alert status
  const alertStatus = getAlertStatus();
  lines.push("");
  lines.push(`🔔 **Alerts**`);
  if (!alertStatus.operatorSet) {
    lines.push(`• Status: No OPERATOR_DISCORD_ID set`);
  } else if (alertStatus.enabled) {
    lines.push(`• Status: Enabled`);
  } else {
    lines.push(`• Status: Disabled`);
  }

  return lines.join("\n");
}

/**
 * Check if message is a request to read a specific Moltbook post.
 * Returns the post ID if found, null otherwise.
 */
function extractReadPostRequest(text: string): string | null {
  // Match patterns like "read post abc123", "show me post abc123", "moltbook post abc123"
  // Post IDs are UUIDs or alphanumeric strings, not common words
  const commonWords = new Set(["on", "about", "to", "for", "in", "a", "the", "this", "that", "it", "moltbook"]);

  const patterns = [
    /(?:read|show|get|fetch|view)\s+(?:me\s+)?(?:moltbook\s+)?post\s+([a-f0-9-]{8,}|\S+)/i,
    /what(?:'s| is| does)\s+(?:moltbook\s+)?post\s+([a-f0-9-]{8,})/i,
    /moltbook\.com\/post\/([a-f0-9-]+)/i,
  ];

  for (const p of patterns) {
    const match = text.match(p);
    if (match && match[1]) {
      const candidate = match[1].replace(/[.,!?;:]+$/, "").toLowerCase();
      // Skip if it's a common word
      if (commonWords.has(candidate)) continue;
      // Must look like a post ID (contains numbers/dashes or is long enough)
      if (candidate.length >= 8 || /[0-9-]/.test(candidate)) {
        return match[1].replace(/[.,!?;:]+$/, "");
      }
    }
  }
  return null;
}

/**
 * Handle a request to read a specific Moltbook post.
 */
async function handleReadPost(message: Message, postId: string): Promise<void> {
  if (!moltbookConfigured()) {
    await message.reply({ content: "Moltbook is not configured. Set MOLTBOOK_API_KEY to enable." });
    return;
  }

  const result = await getPost(postId);

  if (!result.ok || !result.post) {
    await message.reply({ content: `Could not fetch post ${postId}: ${result.error || "not found"}` });
    return;
  }

  const post = result.post;
  const lines: string[] = [
    `**${post.title}**`,
    `by ${post.author} in ${post.submolt || "general"} • ${post.upvotes}↑ ${post.downvotes}↓ • ${post.comment_count} comments`,
    "",
  ];

  if (post.content) {
    // Truncate long posts
    const content = post.content.length > 1200
      ? post.content.slice(0, 1200) + "..."
      : post.content;
    lines.push(content);
  } else if (post.url) {
    lines.push(`Link: ${post.url}`);
  }

  lines.push("");
  lines.push(`https://www.moltbook.com/post/${postId}`);

  // Optionally fetch top comments
  const commentsResult = await getComments(postId, "top");
  if (commentsResult.ok && commentsResult.comments?.length) {
    lines.push("");
    lines.push(`**Top Comments:**`);
    for (const c of commentsResult.comments.slice(0, 3)) {
      const preview = c.content.length > 150
        ? c.content.slice(0, 150) + "..."
        : c.content;
      lines.push(`• **${c.author}** (${c.upvotes}↑): ${preview}`);
    }
  }

  await message.reply({ content: lines.join("\n").slice(0, MAX_REPLY_LENGTH) });
  console.log(`discord: fetched post ${postId} for msg=${message.id}`);
}

/**
 * Check if message is a request to comment on a specific Moltbook post.
 * Returns the post ID and optional guidance if found.
 */
function extractCommentOnPostRequest(text: string): { postId: string; guidance?: string } | null {
  // Match patterns like:
  // - "comment on 8a828f9f-75e5-428c-b9bd-827f4c952986" (UUID)
  // - "reply to 8a828f9f-75e5-428c-b9bd-827f4c952986"
  // - "comment on 8a828f9f-... about Lightning Network" (with guidance)

  const uuidPattern = /(?:comment|reply|respond)\s+(?:on|to)\s+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;

  const match = text.match(uuidPattern);
  if (!match) return null;

  const postId = match[1];
  const matchEnd = match.index! + match[0].length;

  // Extract optional guidance after the UUID
  const remaining = text.slice(matchEnd).trim();
  const guidanceMatch = remaining.match(/^(?:about|regarding|re:|on|with)?\s*(.+)/i);
  const guidance = guidanceMatch?.[1]?.trim() || undefined;

  return { postId, guidance };
}

/**
 * Handle a request to comment on a specific Moltbook post.
 */
async function handleCommentOnPost(message: Message, postId: string, guidance?: string): Promise<void> {
  if (!moltbookConfigured()) {
    await message.reply({ content: "Moltbook is not configured. Set MOLTBOOK_API_KEY to enable." });
    return;
  }

  // Check comment cooldown
  const commentCooldown = checkCommentCooldown();
  if (!commentCooldown.allowed) {
    await message.reply({ content: `Can't comment right now: ${commentCooldown.reason}` });
    return;
  }

  // Fetch the post
  await message.reply({ content: "fetching post..." });
  const result = await getPost(postId);

  if (!result.ok || !result.post) {
    await message.reply({ content: `couldn't fetch post: ${result.error || "not found"}` });
    return;
  }

  const post = result.post;

  // Fetch existing comments for context
  const commentsResult = await getComments(postId, "top");
  const existingComments = commentsResult.ok && commentsResult.comments?.length
    ? commentsResult.comments.slice(0, 5).map(c => `${c.author}: ${c.content.slice(0, 200)}`).join("\n\n")
    : "(no comments yet)";

  // Build prompt for generating comment
  const prompt = `Your operator has asked you to comment on this Moltbook post.

POST:
Title: "${post.title}"
Author: ${post.author}
Submolt: ${post.submolt || "general"}
Content: ${post.content || post.url || "(no content)"}

EXISTING COMMENTS:
${existingComments}

${guidance ? `OPERATOR GUIDANCE: ${guidance}` : ""}

Write a thoughtful comment that adds value to this discussion. Be genuine, not performative. Follow your doctrine.

Respond with ONLY your comment text (no formatting, no "COMMENT:" prefix, just the comment itself).`;

  const llmResult = await generate({ userMessage: prompt, maxTokens: 800 });
  const commentContent = llmResult.text.trim();

  if (!commentContent || commentContent.length < 10) {
    await message.reply({ content: "couldn't generate a good comment for this post" });
    return;
  }

  // Post the comment
  const commentResult = await createComment({
    postId,
    content: commentContent,
  });

  if (!commentResult.ok) {
    appendReceipt({
      ts: new Date().toISOString(),
      action: "comment",
      surface: "moltbook",
      targetPostId: postId,
      contentPreview: commentContent.slice(0, 100),
      success: false,
      error: commentResult.error,
    });
    await message.reply({ content: `failed to comment: ${commentResult.error}` });
    return;
  }

  // Record success
  recordCommentState();
  const commentId = commentResult.comment?.id || `comment-${Date.now()}`;
  await recordCommentMemory(
    commentId,
    commentContent,
    postId,
    post.title,
    post.submolt,
    false
  );

  appendReceipt({
    ts: new Date().toISOString(),
    action: "comment",
    surface: "moltbook",
    commentId,
    targetPostId: postId,
    contentPreview: commentContent.slice(0, 100),
    success: true,
  });

  const postUrl = `https://www.moltbook.com/post/${postId}`;
  console.log(`discord: commented on post=${postId} via operator request`);

  await message.reply({
    content: `commented on "${post.title}":\n\n${commentContent.slice(0, 500)}${commentContent.length > 500 ? "..." : ""}\n\n${postUrl}`
  });
}

/**
 * Format activity report for Discord.
 */
function formatActivityReport(limit: number = 10): string {
  const receipts = getRecentReceipts(limit);

  if (receipts.length === 0) {
    return "**Activity Report**\n\nNo recent activity recorded.";
  }

  const lines: string[] = [
    `**Recent Activity** (last ${receipts.length} actions)`,
    "",
  ];

  for (const r of receipts) {
    const time = new Date(r.ts).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const icon = r.success ? "✅" : "❌";
    const action = r.action.toUpperCase();

    let detail = "";
    if (r.action === "post" && r.title) {
      detail = `"${r.title.slice(0, 40)}${r.title.length > 40 ? "..." : ""}"`;
      if (r.submolt) detail += ` in ${r.submolt}`;
    } else if (r.action === "comment" && r.targetPostId) {
      detail = `on post ${r.targetPostId}`;
    } else if (r.action === "abstain" && r.reason) {
      detail = r.reason.slice(0, 50);
    }

    if (r.error) {
      detail = `Error: ${r.error.slice(0, 40)}`;
    }

    lines.push(`${icon} \`${time}\` **${action}** ${detail}`);
  }

  return lines.join("\n");
}

/**
 * Build a summary of recent Moltbook posts and available submolts for context.
 */
async function getMoltbookContext(): Promise<{ feed: string; submolts: string; posts: MoltbookPost[] }> {
  // Fetch feed
  const feedResult = await getFeed("hot", 15);
  let feed = "(Could not fetch Moltbook feed)";
  const posts: MoltbookPost[] = feedResult.posts ?? [];

  if (feedResult.ok && posts.length) {
    const summaries = posts.map((p, i) => {
      const preview = p.content?.slice(0, 150) || p.url || "(no content)";
      const submoltTag = p.submolt ? `[${p.submolt}]` : "";
      return `${i + 1}. ${submoltTag} "${p.title}" by ${p.author} (id: ${p.id})\n   ${p.upvotes}↑, ${p.comment_count} comments\n   ${preview}${(p.content?.length ?? 0) > 150 ? "..." : ""}`;
    });
    feed = `Recent Moltbook posts (hot):\n${summaries.join("\n\n")}`;
  }

  // Fetch submolts
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
 * Handle a Moltbook post request.
 */
async function handleMoltbookPost(message: Message, text: string, context: string, attachmentText?: string | null): Promise<void> {
  if (!moltbookConfigured()) {
    await message.reply({ content: "Moltbook is not configured. Set MOLTBOOK_API_KEY to enable." });
    return;
  }

  // Check cooldowns before proceeding
  const status = getStateStatus();
  const postCheck = status.postCooldown;
  const commentCheck = status.commentCooldown;

  // If both are blocked, inform user
  if (!postCheck.allowed && !commentCheck.allowed) {
    await message.reply({
      content: `Cooldown active:\n- Posts: ${postCheck.reason}\n- Comments: ${commentCheck.reason}\n\nToday: ${status.postsToday} posts, ${status.commentsToday} comments.`
    });
    return;
  }

  // If we have attachment text, extract title and use it directly
  if (attachmentText && attachmentText.trim().length > 0) {
    // Try to extract title from the attachment (look for # Title or Title: pattern)
    let title: string | null = null;
    let content = attachmentText.trim();

    // Check for markdown title (# Title)
    const mdTitleMatch = content.match(/^#\s+(.+)$/m);
    if (mdTitleMatch) {
      title = mdTitleMatch[1].trim();
    }
    // Check for "Title:" or "Title\n" at start
    const titleLineMatch = content.match(/^Title[:\s]+(.+?)(?:\n|$)/i);
    if (!title && titleLineMatch) {
      title = titleLineMatch[1].trim();
      // Remove the title line from content
      content = content.replace(/^Title[:\s]+.+?\n?/i, "").trim();
    }

    if (!title) {
      // Use first line as title if it's short enough
      const firstLine = content.split("\n")[0].trim();
      if (firstLine.length <= 100 && firstLine.length > 5) {
        title = firstLine;
        content = content.slice(firstLine.length).trim();
      } else {
        title = "Untitled Post";
      }
    }

    // Post directly with attachment content
    await message.reply({ content: `posting "${title}" from your attachment...` });

    const submoltsResult = await getSubmolts();
    const submolt = await validateSubmolt("general"); // Default to general, could be smarter

    const postResult = await createPost({ title, content, submolt });

    if (!postResult.ok) {
      appendReceipt({
        ts: new Date().toISOString(),
        action: "post",
        surface: "moltbook",
        submolt,
        title,
        contentPreview: content.slice(0, 100),
        success: false,
        error: postResult.error,
      });
      await message.reply({ content: `failed to post: ${postResult.error}` });
      return;
    }

    recordPostState();
    const postId = postResult.post?.id;
    const postUrl = postId ? `https://www.moltbook.com/post/${postId}` : null;

    if (postId) {
      await recordPostMemory(postId, title, content, submolt, false);
    }

    appendReceipt({
      ts: new Date().toISOString(),
      action: "post",
      surface: "moltbook",
      postId,
      submolt,
      title,
      contentPreview: content.slice(0, 100),
      success: true,
    });

    console.log(`moltbook: posted from attachment id=${postId} submolt=${submolt}`);
    await message.reply({
      content: `done! posted to ${submolt}\n\n**${title}**\n\n${postUrl ?? "(no URL)"}`
    });
    return;
  }

  // Fetch current Moltbook state first
  await message.reply({ content: "Checking Moltbook feed and submolts..." });
  const { feed, submolts, posts } = await getMoltbookContext();

  const topic = extractPostTopic(text);
  const explicitPost = isExplicitPostRequest(text);

  // Minimum input length gate - prevent ambiguous/confused posts like "Do?"
  const MIN_TOPIC_LENGTH = 10; // At least 10 characters for a meaningful topic
  const hasContext = context.trim().length > 20; // Has recent conversation context

  if (explicitPost && topic.length < MIN_TOPIC_LENGTH && !hasContext) {
    await message.reply({
      content: `I need a bit more to work with. What topic should I post about?\n\nExample: "post to moltbook about institutional sensemaking in agent networks"`
    });
    return;
  }

  // If topic is very short but we have context, use context-based posting
  const useContextBased = topic.length < MIN_TOPIC_LENGTH && hasContext;

  // If user explicitly wants a POST, use a direct prompt (no COMMENT/ABSTAIN options)
  let prompt: string;

  if (explicitPost) {
    // User explicitly requested a POST - honor that directly
    const hasMeaningfulTopic = topic.length >= MIN_TOPIC_LENGTH;

    prompt = `The operator has EXPLICITLY asked you to create a NEW POST on Moltbook.

${hasMeaningfulTopic ? `**CRITICAL: YOUR POST MUST BE ABOUT THIS EXACT TOPIC:**
"${topic}"

Your title and content MUST directly address "${topic}". Do NOT post about a different topic, even if it seems related or more interesting. The operator specified this topic for a reason.` : `Discord context:\n${context}\n\nBase your post on this conversation. The operator didn't specify a detailed topic, so synthesize from the recent discussion.`}

CURRENT MOLTBOOK STATE (for context only - do NOT let this change your topic):
${feed}

${submolts}

RULES:
1. You MUST create a new post (not a comment)
2. ${hasMeaningfulTopic ? `Your post MUST be about "${topic}" - not a tangentially related topic` : "Base your post on the Discord conversation above"}
3. Even if similar topics exist on Moltbook, YOUR perspective adds value
4. Choose the most appropriate submolt

Format your response EXACTLY as:
ACTION: POST
SUBMOLT: [submolt name]
TITLE: [title that clearly relates to ${hasMeaningfulTopic ? `"${topic}"` : "the conversation"}]
CONTENT: [post body directly addressing ${hasMeaningfulTopic ? `"${topic}"` : "the topic from conversation"}]`;
  } else {
    // General engagement request - give options
    const basePrompt = `CURRENT MOLTBOOK STATE:
${feed}

${submolts}

You have THREE options:

1. **POST** - Create a new post if you have a distinct take, frame, or synthesis. The topic may already be discussed — that's fine if YOUR perspective adds value. Don't be too conservative.

2. **COMMENT** - Reply to an existing post (use the post id from the feed above) if your contribution fits better as a response than a standalone post.

3. **ABSTAIN** - Only if you genuinely have nothing to add. This should be rare.

Follow your doctrine: be thoughtful, not performative. Prefer action over silence when you have signal.`;

    prompt = topic.length > 0
      ? `The operator has asked you to engage with Moltbook about: "${topic}"

${basePrompt}

Format your response as ONE of:

For a new post:
ACTION: POST
SUBMOLT: [submolt name]
TITLE: [title]
CONTENT: [post body]

For a comment on an existing post:
ACTION: COMMENT
POST_ID: [id of the post to comment on]
CONTENT: [your comment]

To abstain:
ACTION: ABSTAIN
REASON: [brief reason]`
      : `The operator has asked you to engage with Moltbook based on the recent conversation.

Discord context:
${context}

${basePrompt}

Format your response as ONE of:

For a new post:
ACTION: POST
SUBMOLT: [submolt name]
TITLE: [title]
CONTENT: [post body]

For a comment on an existing post:
ACTION: COMMENT
POST_ID: [id of the post to comment on]
CONTENT: [your comment]

To abstain:
ACTION: ABSTAIN
REASON: [brief reason]`;
  }

  const result = await generate({ userMessage: prompt, maxTokens: 1500 });
  const response = result.text;

  // Parse action type
  const actionMatch = response.match(/ACTION:\s*(POST|COMMENT|ABSTAIN)/i);
  const action = actionMatch?.[1]?.toUpperCase() || "ABSTAIN";

  if (action === "ABSTAIN") {
    const reasonMatch = response.match(/REASON:\s*([\s\S]+)/);
    const reason = reasonMatch?.[1]?.trim() || "No specific reason given.";

    // Log abstain receipt
    appendReceipt({
      ts: new Date().toISOString(),
      action: "abstain",
      surface: "moltbook",
      reason,
      success: true,
    });

    await message.reply({ content: `I've decided not to engage. ${reason}` });
    return;
  }

  if (action === "COMMENT") {
    // Check comment cooldown
    const commentCooldown = checkCommentCooldown();
    if (!commentCooldown.allowed) {
      await message.reply({ content: `Cannot comment: ${commentCooldown.reason}` });
      return;
    }

    const postIdMatch = response.match(/POST_ID:\s*(\S+)/);
    const contentMatch = response.match(/CONTENT:\s*([\s\S]+)/);

    if (!postIdMatch || !contentMatch) {
      await message.reply({ content: "I wanted to comment but couldn't parse the response format." });
      return;
    }

    const targetPostId = postIdMatch[1].trim();
    const commentContent = contentMatch[1].trim();

    const commentResult = await createComment({
      postId: targetPostId,
      content: commentContent,
    });

    if (!commentResult.ok) {
      // Log failed receipt
      appendReceipt({
        ts: new Date().toISOString(),
        action: "comment",
        surface: "moltbook",
        targetPostId,
        contentPreview: commentContent.slice(0, 100),
        success: false,
        error: commentResult.error,
      });
      await message.reply({ content: `Failed to comment on Moltbook: ${commentResult.error}` });
      return;
    }

    // Record successful comment
    recordCommentState();
    const targetPost = posts.find(p => p.id === targetPostId);
    const postUrl = `https://www.moltbook.com/post/${targetPostId}`;

    // Record to memory
    const commentId = commentResult.comment?.id || `comment-${Date.now()}`;
    await recordCommentMemory(
      commentId,
      commentContent,
      targetPostId,
      targetPost?.title || "Unknown",
      targetPost?.submolt,
      false // not autonomous
    );

    // Log success receipt
    appendReceipt({
      ts: new Date().toISOString(),
      action: "comment",
      surface: "moltbook",
      commentId: commentResult.comment?.id,
      targetPostId,
      contentPreview: commentContent.slice(0, 100),
      success: true,
    });

    console.log(`moltbook: commented on post=${targetPostId}`);

    await message.reply({
      content: `Commented on "${targetPost?.title || targetPostId}":\n\n${commentContent.slice(0, 400)}${commentContent.length > 400 ? "..." : ""}\n\n${postUrl}`
    });
    return;
  }

  // ACTION: POST
  // Check post cooldown
  const postCooldown = checkPostCooldown();
  if (!postCooldown.allowed) {
    await message.reply({ content: `Cannot post: ${postCooldown.reason}` });
    return;
  }

  const submoltMatch = response.match(/SUBMOLT:\s*(.+?)(?:\n|TITLE:)/s);
  const titleMatch = response.match(/TITLE:\s*(.+?)(?:\n|CONTENT:)/s);
  const contentMatch = response.match(/CONTENT:\s*([\s\S]+)/);

  if (!titleMatch || !contentMatch) {
    await message.reply({ content: "I couldn't formulate a proper post. The response format was unexpected." });
    return;
  }

  // Validate submolt exists (LLM sometimes hallucinates submolt names)
  const submolt = await validateSubmolt(submoltMatch?.[1]?.trim());
  const title = titleMatch[1].trim();
  const content = contentMatch[1].trim();

  const postResult = await createPost({ title, content, submolt });

  if (!postResult.ok) {
    // Log failed receipt
    appendReceipt({
      ts: new Date().toISOString(),
      action: "post",
      surface: "moltbook",
      submolt,
      title,
      contentPreview: content.slice(0, 100),
      success: false,
      error: postResult.error,
    });
    await message.reply({ content: `Failed to post to Moltbook: ${postResult.error}` });
    return;
  }

  // Record successful post
  recordPostState();
  const postId = postResult.post?.id;
  const postUrl = postId ? `https://www.moltbook.com/post/${postId}` : null;

  // Record to memory
  if (postId) {
    await recordPostMemory(
      postId,
      title,
      content,
      submolt,
      false // not autonomous
    );
  }

  // Log success receipt
  appendReceipt({
    ts: new Date().toISOString(),
    action: "post",
    surface: "moltbook",
    postId: postId,
    submolt,
    title,
    contentPreview: content.slice(0, 100),
    success: true,
  });

  console.log(`moltbook: posted id=${postId} submolt=${submolt} url=${postUrl}`);

  await message.reply({
    content: `Posted to Moltbook (${submolt}):\n\n**${title}**\n\n${content.slice(0, 300)}${content.length > 300 ? "..." : ""}\n\n${postUrl ?? "(no URL returned)"}`
  });
}

/**
 * Handle an incoming message.
 */
async function handleMessage(message: Message, botUserId: string): Promise<void> {
  // Ignore bots
  if (message.author.bot) return;

  const raw = message.content ?? "";
  const channel = message.channel;

  // Check if DM or mention
  const isDM = channel.isDMBased?.() || message.guild === null;
  const mentioned = message.mentions.has(botUserId);

  if (!isDM && !mentioned) return;

  // Extract clean text
  let text = raw.trim();
  if (mentioned) {
    text = stripBotMentions(raw, botUserId);
  }

  if (text.length === 0) return;

  console.log(`discord: msg=${message.id} author=${message.author.id} isDM=${isDM}`);

  try {
    // Check for commands request
    if (isCommandsRequest(text)) {
      const help = formatCommandsHelp();
      await message.reply({ content: help });
      console.log(`discord: sent commands help to msg=${message.id}`);
      return;
    }

    // Check for status request
    if (isStatusRequest(text)) {
      const report = formatStatusReport();
      await message.reply({ content: report });
      console.log(`discord: sent status report to msg=${message.id}`);
      return;
    }

    // Check for activity request
    if (isActivityRequest(text)) {
      const report = formatActivityReport(10);
      await message.reply({ content: report });
      console.log(`discord: sent activity report to msg=${message.id}`);
      return;
    }

    // Check for memory request
    if (isMemoryRequest(text)) {
      const report = formatMemoryReport();
      await message.reply({ content: report });
      console.log(`discord: sent memory report to msg=${message.id}`);
      return;
    }

    // Check for block/unblock instructions
    const blockCmd = parseBlockInstruction(text);
    if (blockCmd) {
      switch (blockCmd.action) {
        case "list": {
          const instructions = getOperatorInstructions();
          if (instructions.length === 0) {
            await message.reply({ content: "No posts are currently blocked." });
          } else {
            const lines = ["**Blocked Posts:**"];
            for (const inst of instructions) {
              lines.push(`• "${inst.value}"${inst.reason ? ` — ${inst.reason}` : ""}`);
            }
            await message.reply({ content: lines.join("\n") });
          }
          console.log(`discord: listed blocks from msg=${message.id}`);
          return;
        }
        case "clear": {
          clearOperatorInstructions();
          await message.reply({ content: "✅ Cleared all blocked posts." });
          console.log(`discord: cleared all blocks from msg=${message.id}`);
          return;
        }
        case "block": {
          if (blockCmd.target) {
            addOperatorInstruction("block_post", blockCmd.target, `Blocked by operator via Discord`);
            await message.reply({ content: `🚫 Got it — I won't engage with posts matching "${blockCmd.target}".` });
            console.log(`discord: blocked "${blockCmd.target}" from msg=${message.id}`);
          }
          return;
        }
        case "unblock": {
          if (blockCmd.target) {
            const removed = removeOperatorInstruction("block_post", blockCmd.target);
            if (removed) {
              await message.reply({ content: `✅ Unblocked "${blockCmd.target}". I can engage with it again.` });
            } else {
              await message.reply({ content: `"${blockCmd.target}" wasn't in my blocked list.` });
            }
            console.log(`discord: unblocked "${blockCmd.target}" from msg=${message.id}`);
          }
          return;
        }
      }
    }

    // Check for focus/priority instructions
    const focusCmd = parseFocusInstruction(text);
    if (focusCmd) {
      switch (focusCmd.action) {
        case "list": {
          const priorities = getPrioritizedTopics();
          const watches = getWatchedTopics();
          if (priorities.length === 0 && watches.length === 0) {
            await message.reply({ content: "No focus topics set. I'll engage with whatever seems interesting." });
          } else {
            const lines: string[] = [];
            if (priorities.length > 0) {
              lines.push("**Publish Topics** (I'll seek AND post/comment about these):");
              for (const p of priorities) {
                lines.push(`• "${p.topic}"${p.reason ? ` — ${p.reason}` : ""}`);
              }
            }
            if (watches.length > 0) {
              if (lines.length > 0) lines.push("");
              lines.push("**Watch Topics** (observe only, no publishing):");
              for (const w of watches) {
                lines.push(`• "${w.topic}"${w.reason ? ` — ${w.reason}` : ""}`);
              }
            }
            await message.reply({ content: lines.join("\n") });
          }
          console.log(`discord: listed focuses from msg=${message.id}`);
          return;
        }
        case "clear": {
          clearPrioritizedTopics();
          await message.reply({ content: "✅ Cleared all focus/watch topics. I'll go back to engaging with whatever seems interesting." });
          console.log(`discord: cleared all focuses from msg=${message.id}`);
          return;
        }
        case "publish": {
          if (focusCmd.target) {
            // Remove any existing watch for the same topic (upgrade to publish)
            removeOperatorInstruction("watch_topic", focusCmd.target);
            addOperatorInstruction("prioritize_topic", focusCmd.target, `Publish focus set by operator via Discord`);
            await message.reply({ content: `🎯 Got it — I'll actively look for AND publish about "${focusCmd.target}".` });
            console.log(`discord: added publish focus "${focusCmd.target}" from msg=${message.id}`);
          }
          return;
        }
        case "watch": {
          if (focusCmd.target) {
            addOperatorInstruction("watch_topic", focusCmd.target, `Watch set by operator via Discord (observe only)`);
            await message.reply({ content: `👀 Got it — I'll look for "${focusCmd.target}" and add observations, but won't publish about it.` });
            console.log(`discord: added watch "${focusCmd.target}" from msg=${message.id}`);
          }
          return;
        }
        case "unfocus": {
          if (focusCmd.target) {
            const removedPriority = removeOperatorInstruction("prioritize_topic", focusCmd.target);
            const removedWatch = removeOperatorInstruction("watch_topic", focusCmd.target);
            if (removedPriority || removedWatch) {
              await message.reply({ content: `✅ Removed "${focusCmd.target}" from my focus/watch list.` });
            } else {
              await message.reply({ content: `"${focusCmd.target}" wasn't in my focus or watch list.` });
            }
            console.log(`discord: removed focus/watch "${focusCmd.target}" from msg=${message.id}`);
          }
          return;
        }
      }
    }

    // Check for autonomous mode commands
    const autoCmd = parseAutonomousCommand(text);
    if (autoCmd) {
      switch (autoCmd.cmd) {
        case "start":
          if (isAutonomousRunning()) {
            await message.reply({ content: "Autonomous mode is already running." });
          } else {
            startAutonomous();
            const autoStatus = getAutonomousStatus();
            await message.reply({
              content: `🤖 Autonomous mode started. I'll check Moltbook every ${autoStatus.intervalMinutes} minutes and engage when I find something interesting.`
            });
          }
          console.log(`discord: autonomous start command from msg=${message.id}`);
          return;

        case "stop":
          if (!isAutonomousRunning()) {
            await message.reply({ content: "Autonomous mode is not running." });
          } else {
            stopAutonomous();
            await message.reply({ content: "🛑 Autonomous mode stopped. I'll wait for your prompts." });
          }
          console.log(`discord: autonomous stop command from msg=${message.id}`);
          return;

        case "check":
          await message.reply({ content: "🔍 Checking Moltbook now..." });
          console.log(`discord: manual check trigger from msg=${message.id}`);
          // Run async so we can respond immediately
          triggerCheck().catch(err => console.error("discord: manual check failed", err));
          return;

        case "interval":
          if (autoCmd.param && autoCmd.param >= 1) {
            setIntervalMinutes(autoCmd.param);
            await message.reply({
              content: `⏱️ Autonomous check interval set to ${autoCmd.param} minute${autoCmd.param > 1 ? "s" : ""}.`
            });
          } else {
            await message.reply({ content: "Invalid interval. Please specify a number >= 1 minute." });
          }
          console.log(`discord: interval set to ${autoCmd.param}m from msg=${message.id}`);
          return;

        case "alerts_on":
          setAlertsEnabled(true);
          await message.reply({ content: "🔔 Operator alerts enabled. I'll DM you about new replies and traction." });
          console.log(`discord: alerts enabled from msg=${message.id}`);
          return;

        case "alerts_off":
          setAlertsEnabled(false);
          await message.reply({ content: "🔕 Operator alerts disabled." });
          console.log(`discord: alerts disabled from msg=${message.id}`);
          return;

        case "status":
          const report = formatStatusReport();
          await message.reply({ content: report });
          console.log(`discord: sent status report (autonomous) to msg=${message.id}`);
          return;

        case "post_cooldown":
          if (autoCmd.param && autoCmd.param >= 1) {
            setPostCooldownMinutes(autoCmd.param);
            const hours = Math.floor(autoCmd.param / 60);
            const mins = autoCmd.param % 60;
            const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
            await message.reply({ content: `⏱️ Post cooldown set to ${timeStr}.` });
          } else {
            await message.reply({ content: "Invalid value. Please specify minutes >= 1." });
          }
          console.log(`discord: post cooldown set to ${autoCmd.param}m from msg=${message.id}`);
          return;

        case "comment_cooldown":
          if (autoCmd.param !== undefined && autoCmd.param >= 0) {
            setCommentCooldownMinutes(autoCmd.param);
            await message.reply({ content: `⏱️ Comment cooldown set to ${autoCmd.param}m.` });
          } else {
            await message.reply({ content: "Invalid value. Please specify minutes >= 0." });
          }
          console.log(`discord: comment cooldown set to ${autoCmd.param}m from msg=${message.id}`);
          return;

        case "post_limit":
          if (autoCmd.param && autoCmd.param >= 1) {
            setPostDailyLimit(autoCmd.param);
            await message.reply({ content: `📊 Daily post limit set to ${autoCmd.param}.` });
          } else {
            await message.reply({ content: "Invalid value. Please specify a limit >= 1." });
          }
          console.log(`discord: post limit set to ${autoCmd.param} from msg=${message.id}`);
          return;

        case "comment_limit":
          if (autoCmd.param && autoCmd.param >= 1) {
            setCommentDailyLimit(autoCmd.param);
            await message.reply({ content: `📊 Daily comment limit set to ${autoCmd.param}.` });
          } else {
            await message.reply({ content: "Invalid value. Please specify a limit >= 1." });
          }
          console.log(`discord: comment limit set to ${autoCmd.param} from msg=${message.id}`);
          return;

        case "reset_cooldowns":
          resetCooldowns();
          await message.reply({ content: "⏱️ Cooldowns reset to defaults (post: 4h/3 per day, comment: 5m/30 per day)." });
          console.log(`discord: cooldowns reset from msg=${message.id}`);
          return;
      }
    }

    // Check for comment-on-post request FIRST (before read, since read pattern is broad)
    const commentRequest = extractCommentOnPostRequest(text);
    if (commentRequest) {
      await handleCommentOnPost(message, commentRequest.postId, commentRequest.guidance);
      return;
    }

    // Check for read post request
    const readPostId = extractReadPostRequest(text);
    if (readPostId) {
      await handleReadPost(message, readPostId);
      return;
    }

    // Build context
    const context = await buildContext(channel, message.id);

    // Extract any text from attachments (for posting .md files etc)
    const attachmentText = await extractAttachmentText(message);

    // Check if this is a Moltbook post request
    if (isMoltbookPostRequest(text)) {
      await handleMoltbookPost(message, text, context, attachmentText);
      return;
    }

    // Build context - but DON'T inject full memory dump for casual conversation
    // Only inject state/browse/observations if the message seems Moltbook-related
    const isMoltbookRelated = /moltbook|post|thread|comment|browse|feed|submolt|autonomous|status/i.test(text);

    let fullContext = context || "";
    if (isMoltbookRelated) {
      // Include full context for Moltbook-related queries
      const stateContext = buildStateContext();
      const browseContext = getBrowseContext();
      const observationsContext = getObservationsContext();
      fullContext = [
        stateContext,
        context || "",
        browseContext !== "No recent Moltbook browse recorded." ? browseContext : "",
        observationsContext,
      ].filter(Boolean).join("\n\n");
    }
    // For casual chat, just use the Discord conversation context (no memory injection)

    // Generate response (use Discord personality for operator chat)
    const result = await generate({
      userMessage: text,
      conversationContext: fullContext || undefined,
      useDiscordPrompt: true,
    });

    // Guard against empty LLM response
    let reply = result.text?.trim() || "";
    if (!reply) {
      console.error(`discord: LLM returned empty response for msg=${message.id}`);
      reply = "I'm not sure how to respond to that. Could you rephrase?";
    }

    // Handle long responses - attach full text as .md file
    if (reply.length > MAX_REPLY_LENGTH) {
      const truncated = reply.slice(0, MAX_REPLY_LENGTH - 50) + "\n\n_(Full response attached)_";
      const attachment = new AttachmentBuilder(Buffer.from(reply, "utf-8"), {
        name: "response.md",
        description: "Full response from Loom",
      });
      await message.reply({ content: truncated, files: [attachment] });
    } else {
      await message.reply({ content: reply });
    }

    console.log(`discord: replied msg=${message.id} provider=${result.provider} tokens=${result.outputTokens ?? "?"}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "";
    console.error(`discord: error msg=${message.id} err=${errMsg}`);
    if (stack) console.error(`discord: stack=${stack}`);
    await message.reply({ content: "I encountered an error processing your message." }).catch(() => {});
  }
}

/**
 * Start the Discord client.
 */
export async function startDiscord(): Promise<Client | null> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    console.log("discord: DISCORD_BOT_TOKEN not set, skipping");
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel], // Required for DM events
  });

  client.on("messageCreate", async (message) => {
    const botUser = client.user;
    if (!botUser) return;
    await handleMessage(message, botUser.id);
  });

  client.once("ready", () => {
    const tag = client.user?.tag ?? "unknown";
    const guilds = client.guilds?.cache?.size ?? 0;
    console.log(`discord: ready as ${tag}, guilds=${guilds}`);

    // Initialize operator alerts
    initAlerts(client);
  });

  await client.login(token);
  return client;
}
