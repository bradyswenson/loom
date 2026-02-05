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
const COOLDOWNS = {
  post: {
    minIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
    maxPerDay: 2,
  },
  comment: {
    minIntervalMs: 10 * 60 * 1000, // 10 minutes
    maxPerDay: 12,
  },
};

// --- Types ---

export interface LoomState {
  lastPostAt: string | null;
  lastCommentAt: string | null;
  postsToday: number;
  commentsToday: number;
  dayStart: string; // ISO date string for tracking daily limits
  negativeFeedbackCount: number;
  lastNegativeFeedbackAt: string | null;
  stopUntil: string | null; // If set, Loom should not post until this time
}

export interface PublishReceipt {
  ts: string;
  action: "post" | "comment" | "abstain";
  surface?: "moltbook";
  postId?: string;
  commentId?: string;
  targetPostId?: string;
  submolt?: string;
  title?: string;
  contentPreview?: string;
  reason?: string; // For abstain
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
