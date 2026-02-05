/**
 * Operator alert system for Loom.
 * Sends DMs to the operator when interesting things happen.
 */

import { Client, User } from "discord.js";

// Thresholds for alerts
const REPLY_THRESHOLD = 1;           // Alert on any new reply to our posts
const TRACTION_THRESHOLD = 5;        // Alert when post reaches 5 upvotes
const SIGNIFICANT_TRACTION = 10;     // Alert again at 10 upvotes

// Store Discord client reference
let discordClient: Client | null = null;
let operatorId: string | null = null;
let alertsEnabled = true;

// Track what we've already alerted about to avoid spam
const alertedEvents = new Set<string>();

/**
 * Initialize the alert system.
 */
export function initAlerts(client: Client): void {
  discordClient = client;
  operatorId = process.env.OPERATOR_DISCORD_ID?.trim() || null;

  if (operatorId) {
    console.log(`alerts: Initialized with operator ID ${operatorId}`);
  } else {
    console.log("alerts: No OPERATOR_DISCORD_ID set, alerts disabled");
  }
}

/**
 * Check if alerts are configured and enabled.
 */
export function canAlert(): boolean {
  return !!(discordClient && operatorId && alertsEnabled);
}

/**
 * Enable or disable alerts.
 */
export function setAlertsEnabled(enabled: boolean): void {
  alertsEnabled = enabled;
  console.log(`alerts: ${enabled ? "enabled" : "disabled"}`);
}

/**
 * Check if alerts are enabled.
 */
export function isAlertsEnabled(): boolean {
  return alertsEnabled;
}

/**
 * Send a DM to the operator.
 */
async function sendOperatorDM(message: string): Promise<boolean> {
  if (!canAlert()) return false;

  try {
    const user = await discordClient!.users.fetch(operatorId!);
    await user.send(message);
    console.log(`alerts: Sent DM to operator`);
    return true;
  } catch (err) {
    console.error("alerts: Failed to send DM:", err);
    return false;
  }
}

/**
 * Generate an event key for deduplication.
 */
function eventKey(type: string, id: string, threshold?: number): string {
  return `${type}:${id}:${threshold ?? ""}`;
}

/**
 * Alert about new replies to a tracked thread.
 */
export async function alertNewReplies(
  postId: string,
  postTitle: string,
  newReplies: number,
  totalReplies: number
): Promise<void> {
  if (!canAlert() || newReplies < REPLY_THRESHOLD) return;

  const key = eventKey("reply", postId, totalReplies);
  if (alertedEvents.has(key)) return;
  alertedEvents.add(key);

  const message = `💬 **New reply${newReplies > 1 ? "s" : ""}** on your post!\n\n` +
    `"${postTitle}"\n` +
    `${newReplies} new comment${newReplies > 1 ? "s" : ""} (${totalReplies} total)\n\n` +
    `https://www.moltbook.com/post/${postId}`;

  await sendOperatorDM(message);
}

/**
 * Alert about a post gaining traction.
 */
export async function alertTraction(
  postId: string,
  postTitle: string,
  upvotes: number,
  previousUpvotes: number
): Promise<void> {
  if (!canAlert()) return;

  // Check if we crossed a threshold
  let threshold: number | null = null;
  if (previousUpvotes < TRACTION_THRESHOLD && upvotes >= TRACTION_THRESHOLD) {
    threshold = TRACTION_THRESHOLD;
  } else if (previousUpvotes < SIGNIFICANT_TRACTION && upvotes >= SIGNIFICANT_TRACTION) {
    threshold = SIGNIFICANT_TRACTION;
  }

  if (!threshold) return;

  const key = eventKey("traction", postId, threshold);
  if (alertedEvents.has(key)) return;
  alertedEvents.add(key);

  const emoji = threshold >= SIGNIFICANT_TRACTION ? "🚀" : "📈";
  const message = `${emoji} **Post gaining traction!**\n\n` +
    `"${postTitle}"\n` +
    `Now at ${upvotes} upvotes\n\n` +
    `https://www.moltbook.com/post/${postId}`;

  await sendOperatorDM(message);
}

/**
 * Alert when Loom posts or comments autonomously.
 */
export async function alertAutonomousAction(
  action: "post" | "comment",
  title: string,
  postId: string,
  submolt?: string
): Promise<void> {
  if (!canAlert()) return;

  const key = eventKey("action", postId);
  if (alertedEvents.has(key)) return;
  alertedEvents.add(key);

  const emoji = action === "post" ? "📝" : "💬";
  const actionText = action === "post" ? "posted" : "commented on";
  const locationText = submolt ? ` in ${submolt}` : "";

  const message = `${emoji} **Loom ${actionText}${locationText}**\n\n` +
    `"${title}"\n\n` +
    `https://www.moltbook.com/post/${postId}`;

  await sendOperatorDM(message);
}

/**
 * Alert about something interesting on Moltbook.
 */
export async function alertInteresting(
  postId: string,
  postTitle: string,
  reason: string
): Promise<void> {
  if (!canAlert()) return;

  const key = eventKey("interesting", postId);
  if (alertedEvents.has(key)) return;
  alertedEvents.add(key);

  const message = `👀 **Interesting post on Moltbook**\n\n` +
    `"${postTitle}"\n` +
    `${reason}\n\n` +
    `https://www.moltbook.com/post/${postId}`;

  await sendOperatorDM(message);
}

/**
 * Clear alert history (useful for testing).
 */
export function clearAlertHistory(): void {
  alertedEvents.clear();
  console.log("alerts: History cleared");
}

/**
 * Get alert status for reporting.
 */
export function getAlertStatus(): {
  enabled: boolean;
  configured: boolean;
  operatorSet: boolean;
  alertsSent: number;
} {
  return {
    enabled: alertsEnabled,
    configured: canAlert(),
    operatorSet: !!operatorId,
    alertsSent: alertedEvents.size,
  };
}
