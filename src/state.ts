/**
 * Persistent state management for Loom.
 * Stores cooldowns, publish receipts, and stop condition tracking in /data.
 */

import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR ?? "/data";
const STATE_FILE = path.join(DATA_DIR, "loom-state.json");
const RECEIPTS_FILE = path.join(DATA_DIR, "publish-receipts.jsonl");

// --- Cooldown configuration (from doctrine P3) ---
// Defaults - can be overridden at runtime
const DEFAULT_COOLDOWNS = {
  post: {
    minIntervalMs: 4 * 60 * 60 * 1000, // 4 hours
    maxPerDay: 3,
  },
  comment: {
    minIntervalMs: 5 * 60 * 1000, // 5 minutes
    maxPerDay: 30,
  },
};

// Runtime-configurable cooldowns
let COOLDOWNS = { ...DEFAULT_COOLDOWNS };

// --- Types ---

export interface KarmaSnapshot {
  date: string;          // ISO date (YYYY-MM-DD)
  totalUpvotes: number;  // Total upvotes across all posts
  totalComments: number; // Total comments received on posts
  postCount: number;     // Number of posts at this snapshot
}

export interface OperatorInstruction {
  type: "block_post" | "block_topic" | "prioritize_topic" | "watch_topic";
  value: string;          // Post ID, post title substring, or topic keyword
  reason?: string;        // Why the operator set this directive
  addedAt: string;        // ISO timestamp
  expiresAt?: string;     // Optional expiration (ISO timestamp)
}

export interface LoomState {
  lastPostAt: string | null;
  lastCommentAt: string | null;
  postsToday: number;
  commentsToday: number;
  dayStart: string; // ISO date string for tracking daily limits
  negativeFeedbackCount: number;
  lastNegativeFeedbackAt: string | null;
  stopUntil: string | null; // If set, Loom should not post until this time
  karmaHistory?: KarmaSnapshot[]; // Daily karma snapshots for tracking over time
  operatorInstructions?: OperatorInstruction[]; // Operator directives (blocked posts, etc.)
}

export interface PublishReceipt {
  ts: string;
  action: "post" | "comment" | "abstain" | "vote_up" | "vote_down";
  surface?: "moltbook";
  postId?: string;
  commentId?: string;
  targetPostId?: string;
  submolt?: string;
  title?: string;
  contentPreview?: string;
  reason?: string; // For abstain - why Loom chose not to act
  justification?: {
    // For posts/comments - the reasoning behind the decision
    claim?: string; // Core assertion
    whyNow?: string; // Timing justification
    uncertainty?: string; // Biggest weakness
    falsifier?: string; // What would change this view
  };
  success: boolean;
  error?: string;
  autonomous?: boolean; // True if action was taken autonomously
}

// --- State management ---

function getDefaultState(): LoomState {
  return {
    lastPostAt: null,
    lastCommentAt: null,
    postsToday: 0,
    commentsToday: 0,
    dayStart: new Date().toISOString().slice(0, 10),
    negativeFeedbackCount: 0,
    lastNegativeFeedbackAt: null,
    stopUntil: null,
  };
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function readState(): LoomState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const state = JSON.parse(raw) as LoomState;

      // Reset daily counters if new day
      const today = new Date().toISOString().slice(0, 10);
      if (state.dayStart !== today) {
        state.dayStart = today;
        state.postsToday = 0;
        state.commentsToday = 0;
        state.negativeFeedbackCount = 0; // Reset daily feedback count
      }

      return state;
    }
  } catch (err) {
    console.error("state: failed to read state file", err);
  }
  return getDefaultState();
}

export function writeState(state: LoomState): void {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// --- Cooldown checks ---

export interface CooldownCheck {
  allowed: boolean;
  reason?: string;
  waitMs?: number;
}

export function checkPostCooldown(): CooldownCheck {
  const state = readState();
  const now = Date.now();

  // Check stop condition
  if (state.stopUntil && new Date(state.stopUntil).getTime() > now) {
    const waitMs = new Date(state.stopUntil).getTime() - now;
    return { allowed: false, reason: "Stop condition active", waitMs };
  }

  // Check daily limit
  if (state.postsToday >= COOLDOWNS.post.maxPerDay) {
    return { allowed: false, reason: `Daily post limit reached (${COOLDOWNS.post.maxPerDay})` };
  }

  // Check interval cooldown
  if (state.lastPostAt) {
    const lastPost = new Date(state.lastPostAt).getTime();
    const elapsed = now - lastPost;
    if (elapsed < COOLDOWNS.post.minIntervalMs) {
      const waitMs = COOLDOWNS.post.minIntervalMs - elapsed;
      const waitMins = Math.ceil(waitMs / 60000);
      return { allowed: false, reason: `Post cooldown active (${waitMins}m remaining)`, waitMs };
    }
  }

  return { allowed: true };
}

export function checkCommentCooldown(): CooldownCheck {
  const state = readState();
  const now = Date.now();

  // Check stop condition
  if (state.stopUntil && new Date(state.stopUntil).getTime() > now) {
    const waitMs = new Date(state.stopUntil).getTime() - now;
    return { allowed: false, reason: "Stop condition active", waitMs };
  }

  // Check daily limit
  if (state.commentsToday >= COOLDOWNS.comment.maxPerDay) {
    return { allowed: false, reason: `Daily comment limit reached (${COOLDOWNS.comment.maxPerDay})` };
  }

  // Check interval cooldown
  if (state.lastCommentAt) {
    const lastComment = new Date(state.lastCommentAt).getTime();
    const elapsed = now - lastComment;
    if (elapsed < COOLDOWNS.comment.minIntervalMs) {
      const waitMs = COOLDOWNS.comment.minIntervalMs - elapsed;
      const waitMins = Math.ceil(waitMs / 60000);
      return { allowed: false, reason: `Comment cooldown active (${waitMins}m remaining)`, waitMs };
    }
  }

  return { allowed: true };
}

// --- Record actions ---

export function recordPost(): void {
  const state = readState();
  state.lastPostAt = new Date().toISOString();
  state.postsToday += 1;
  writeState(state);
  console.log(`state: recorded post (${state.postsToday}/${COOLDOWNS.post.maxPerDay} today)`);
}

export function recordComment(): void {
  const state = readState();
  state.lastCommentAt = new Date().toISOString();
  state.commentsToday += 1;
  writeState(state);
  console.log(`state: recorded comment (${state.commentsToday}/${COOLDOWNS.comment.maxPerDay} today)`);
}

// --- Stop conditions (from doctrine) ---

export function recordNegativeFeedback(): void {
  const state = readState();
  state.negativeFeedbackCount += 1;
  state.lastNegativeFeedbackAt = new Date().toISOString();

  // Per doctrine: halt writing for the day if two negative feedback signals occur
  if (state.negativeFeedbackCount >= 2) {
    // Stop until end of day (midnight UTC)
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    state.stopUntil = tomorrow.toISOString();
    console.log(`state: stop condition triggered - halting until ${state.stopUntil}`);
  }

  writeState(state);
}

export function clearStopCondition(): void {
  const state = readState();
  state.stopUntil = null;
  state.negativeFeedbackCount = 0;
  writeState(state);
  console.log("state: stop condition cleared");
}

// --- Publish receipts ---

export function appendReceipt(receipt: PublishReceipt): void {
  ensureDataDir();
  const line = JSON.stringify(receipt) + "\n";
  fs.appendFileSync(RECEIPTS_FILE, line, "utf-8");
  console.log(`state: receipt logged action=${receipt.action} success=${receipt.success}`);
}

export function getRecentReceipts(limit: number = 10): PublishReceipt[] {
  try {
    if (!fs.existsSync(RECEIPTS_FILE)) return [];
    const raw = fs.readFileSync(RECEIPTS_FILE, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => JSON.parse(line) as PublishReceipt)
      .reverse();
  } catch {
    return [];
  }
}

// --- Status summary ---

export function getStateStatus(): {
  postsToday: number;
  commentsToday: number;
  postCooldown: CooldownCheck;
  commentCooldown: CooldownCheck;
  stopActive: boolean;
} {
  const state = readState();
  return {
    postsToday: state.postsToday,
    commentsToday: state.commentsToday,
    postCooldown: checkPostCooldown(),
    commentCooldown: checkCommentCooldown(),
    stopActive: state.stopUntil !== null && new Date(state.stopUntil).getTime() > Date.now(),
  };
}

// --- Cooldown configuration ---

export interface CooldownConfig {
  post: { minIntervalMs: number; maxPerDay: number };
  comment: { minIntervalMs: number; maxPerDay: number };
}

/**
 * Get current cooldown configuration.
 */
export function getCooldowns(): CooldownConfig {
  return { ...COOLDOWNS };
}

/**
 * Set post cooldown interval in minutes.
 */
export function setPostCooldownMinutes(minutes: number): void {
  if (minutes < 1) minutes = 1;
  COOLDOWNS.post.minIntervalMs = minutes * 60 * 1000;
  console.log(`state: post cooldown set to ${minutes}m`);
}

/**
 * Set post daily limit.
 */
export function setPostDailyLimit(limit: number): void {
  if (limit < 1) limit = 1;
  COOLDOWNS.post.maxPerDay = limit;
  console.log(`state: post daily limit set to ${limit}`);
}

/**
 * Set comment cooldown interval in minutes.
 */
export function setCommentCooldownMinutes(minutes: number): void {
  if (minutes < 0) minutes = 0;
  COOLDOWNS.comment.minIntervalMs = minutes * 60 * 1000;
  console.log(`state: comment cooldown set to ${minutes}m`);
}

/**
 * Set comment daily limit.
 */
export function setCommentDailyLimit(limit: number): void {
  if (limit < 1) limit = 1;
  COOLDOWNS.comment.maxPerDay = limit;
  console.log(`state: comment daily limit set to ${limit}`);
}

/**
 * Reset cooldowns to defaults.
 */
export function resetCooldowns(): void {
  COOLDOWNS = { ...DEFAULT_COOLDOWNS };
  console.log("state: cooldowns reset to defaults");
}

// --- Karma history tracking ---

const MAX_KARMA_HISTORY = 90; // Keep ~3 months of daily data

/**
 * Record a daily karma snapshot.
 * Called during autonomous thread checking to track karma over time.
 */
export function recordKarmaSnapshot(
  totalUpvotes: number,
  totalComments: number,
  postCount: number
): void {
  const state = readState();
  const today = new Date().toISOString().slice(0, 10);

  // Initialize karma history if needed
  if (!state.karmaHistory) {
    state.karmaHistory = [];
  }

  // Check if we already have a snapshot for today
  const existingIndex = state.karmaHistory.findIndex((s) => s.date === today);
  const snapshot: KarmaSnapshot = {
    date: today,
    totalUpvotes,
    totalComments,
    postCount,
  };

  if (existingIndex >= 0) {
    // Update existing snapshot for today
    state.karmaHistory[existingIndex] = snapshot;
  } else {
    // Add new snapshot
    state.karmaHistory.push(snapshot);

    // Trim to max history
    if (state.karmaHistory.length > MAX_KARMA_HISTORY) {
      state.karmaHistory = state.karmaHistory.slice(-MAX_KARMA_HISTORY);
    }
  }

  writeState(state);
  console.log(`state: recorded karma snapshot date=${today} upvotes=${totalUpvotes}`);
}

/**
 * Get karma history for a date range.
 * @param days Number of days to look back (default 30)
 */
export function getKarmaHistory(days: number = 30): KarmaSnapshot[] {
  const state = readState();
  if (!state.karmaHistory || state.karmaHistory.length === 0) {
    return [];
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return state.karmaHistory.filter((s) => s.date >= cutoffStr);
}

/**
 * Get karma history for a specific week.
 * @param weekOffset 0 = current week, 1 = last week, etc.
 */
export function getKarmaHistoryByWeek(weekOffset: number = 0): KarmaSnapshot[] {
  const state = readState();
  if (!state.karmaHistory || state.karmaHistory.length === 0) {
    return [];
  }

  // Calculate week boundaries
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - dayOfWeek - weekOffset * 7);
  weekStart.setHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  const startStr = weekStart.toISOString().slice(0, 10);
  const endStr = weekEnd.toISOString().slice(0, 10);

  return state.karmaHistory.filter((s) => s.date >= startStr && s.date < endStr);
}

/**
 * Get the total number of weeks with karma data available.
 */
export function getKarmaWeeksAvailable(): number {
  const state = readState();
  if (!state.karmaHistory || state.karmaHistory.length === 0) {
    return 0;
  }

  const oldest = state.karmaHistory[0].date;
  const newest = state.karmaHistory[state.karmaHistory.length - 1].date;

  const oldestDate = new Date(oldest);
  const newestDate = new Date(newest);
  const diffDays = Math.ceil((newestDate.getTime() - oldestDate.getTime()) / (1000 * 60 * 60 * 24));

  return Math.ceil(diffDays / 7) + 1;
}

// --- Operator instructions ---

/**
 * Add an operator instruction (e.g., block a post from engagement).
 */
export function addOperatorInstruction(
  type: OperatorInstruction["type"],
  value: string,
  reason?: string,
  expiresInHours?: number
): void {
  const state = readState();
  if (!state.operatorInstructions) {
    state.operatorInstructions = [];
  }

  // Remove any existing instruction for the same value
  state.operatorInstructions = state.operatorInstructions.filter(
    (i) => !(i.type === type && i.value.toLowerCase() === value.toLowerCase())
  );

  const instruction: OperatorInstruction = {
    type,
    value,
    reason,
    addedAt: new Date().toISOString(),
  };

  if (expiresInHours) {
    const expires = new Date();
    expires.setHours(expires.getHours() + expiresInHours);
    instruction.expiresAt = expires.toISOString();
  }

  state.operatorInstructions.push(instruction);
  writeState(state);
  console.log(`state: added operator instruction type=${type} value="${value}"`);
}

/**
 * Remove an operator instruction.
 */
export function removeOperatorInstruction(type: OperatorInstruction["type"], value: string): boolean {
  const state = readState();
  if (!state.operatorInstructions) return false;

  const before = state.operatorInstructions.length;
  state.operatorInstructions = state.operatorInstructions.filter(
    (i) => !(i.type === type && i.value.toLowerCase() === value.toLowerCase())
  );

  if (state.operatorInstructions.length < before) {
    writeState(state);
    console.log(`state: removed operator instruction type=${type} value="${value}"`);
    return true;
  }
  return false;
}

/**
 * Get all active operator instructions.
 * Filters out expired instructions.
 */
export function getOperatorInstructions(): OperatorInstruction[] {
  const state = readState();
  if (!state.operatorInstructions) return [];

  const now = new Date().toISOString();
  return state.operatorInstructions.filter((i) => !i.expiresAt || i.expiresAt > now);
}

/**
 * Check if a post is blocked by operator instruction.
 * Checks both post ID and title substring matches.
 */
export function isPostBlocked(postId: string, postTitle?: string): { blocked: boolean; reason?: string } {
  const instructions = getOperatorInstructions();

  for (const inst of instructions) {
    if (inst.type === "block_post") {
      // Check exact ID match
      if (inst.value === postId) {
        return { blocked: true, reason: inst.reason || `Operator blocked post ID: ${postId}` };
      }
      // Check title substring match (case-insensitive)
      if (postTitle && postTitle.toLowerCase().includes(inst.value.toLowerCase())) {
        return { blocked: true, reason: inst.reason || `Operator blocked posts matching: "${inst.value}"` };
      }
    }
  }

  return { blocked: false };
}

/**
 * Check if a topic is blocked by operator instruction.
 */
export function isTopicBlocked(topic: string): { blocked: boolean; reason?: string } {
  const instructions = getOperatorInstructions();

  for (const inst of instructions) {
    if (inst.type === "block_topic" && inst.value.toLowerCase() === topic.toLowerCase()) {
      return { blocked: true, reason: inst.reason || `Operator blocked topic: ${topic}` };
    }
  }

  return { blocked: false };
}

/**
 * Clear all operator instructions.
 */
export function clearOperatorInstructions(): void {
  const state = readState();
  state.operatorInstructions = [];
  writeState(state);
  console.log("state: cleared all operator instructions");
}

/**
 * Get prioritized topics from operator instructions (publish allowed).
 */
export function getPrioritizedTopics(): { topic: string; reason?: string }[] {
  const instructions = getOperatorInstructions();
  return instructions
    .filter((i) => i.type === "prioritize_topic")
    .map((i) => ({ topic: i.value, reason: i.reason }));
}

/**
 * Get watched topics from operator instructions (observe only, no publishing).
 */
export function getWatchedTopics(): { topic: string; reason?: string }[] {
  const instructions = getOperatorInstructions();
  return instructions
    .filter((i) => i.type === "watch_topic")
    .map((i) => ({ topic: i.value, reason: i.reason }));
}

/**
 * Clear only prioritize_topic and watch_topic instructions (keep blocks).
 */
export function clearPrioritizedTopics(): void {
  const state = readState();
  if (!state.operatorInstructions) return;
  state.operatorInstructions = state.operatorInstructions.filter(
    (i) => i.type !== "prioritize_topic" && i.type !== "watch_topic"
  );
  writeState(state);
  console.log("state: cleared all prioritized/watched topics");
}
