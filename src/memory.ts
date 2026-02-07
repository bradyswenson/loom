/**
 * Memory system for Loom.
 * Tracks what Loom has written about to avoid repetition and build coherent presence.
 */

import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR ?? "/data";
const MEMORY_FILE = path.join(DATA_DIR, "loom-memory.json");

// How long to consider a topic "recently covered"
const TOPIC_RECENCY_DAYS = 7;
const MAX_MEMORY_ENTRIES = 100;

export interface MemoryEntry {
  id: string;                    // Post/comment ID from Moltbook
  type: "post" | "comment";
  ts: string;                    // ISO timestamp
  title?: string;                // Post title (if post)
  targetPostId?: string;         // Parent post ID (if comment)
  targetPostTitle?: string;      // Parent post title (if comment)
  submolt?: string;
  topics: string[];              // Extracted topic keywords
  summary: string;               // Brief summary of what was said
  content: string;               // Full content of the post/comment
  autonomous: boolean;
}

export interface ThreadEntry {
  postId: string;
  postTitle: string;
  submolt?: string;
  firstEngagedAt: string;
  lastCheckedAt: string;
  ourCommentIds: string[];       // IDs of comments we made
  lastKnownCommentCount: number;
  lastKnownUpvotes: number;
  isOurPost?: boolean;           // True if Loom created the post, false if just commented (optional for backwards compat)
}

export interface SeenPost {
  id: string;
  title: string;
  author: string;
  submolt?: string;
  upvotes: number;
  commentCount: number;
  contentPreview: string;        // First ~150 chars
  seenAt: string;                // ISO timestamp
}

export type ObservationType =
  | "abstain"              // Why Loom decided not to act
  | "post_justification"   // Reasoning behind a post
  | "comment_justification" // Reasoning behind a comment
  | "upvote_justification" // Reasoning behind an upvote
  | "downvote_justification" // Reasoning behind a downvote
  | "insight"              // Pattern or insight noticed during browsing
  | "thread_limit";        // Hit per-thread engagement limit

export interface Observation {
  id: string;
  ts: string;                    // ISO timestamp
  type: ObservationType;         // What kind of observation this is
  postId?: string;               // Post this observation is about (if any)
  postTitle?: string;
  postAuthor?: string;           // Author of the post
  submolt?: string;              // Submolt where post was seen
  upvotes?: number;              // Engagement at time of observation
  downvotes?: number;            // Downvotes at time of observation
  commentCount?: number;
  note: string;                  // Loom's thought/observation
  topics: string[];              // Related topics
  actionTaken?: string;          // For justifications: "post", "comment", "vote_up", "vote_down"
  contentPreview?: string;       // Preview of what was posted/commented
}

// ===== NEW: Goal-Oriented Memory =====
export interface Goal {
  id: string;
  createdAt: string;
  description: string;           // What Loom wants to achieve
  type: "topic" | "engagement" | "relationship" | "learning";
  status: "active" | "completed" | "abandoned";
  targetDate?: string;           // Optional deadline
  progress: string[];            // Notes on progress
  completedAt?: string;
  outcome?: string;              // What happened when completed/abandoned
}

// ===== NEW: Compressed Memory =====
export interface CompressedInsight {
  id: string;
  createdAt: string;
  period: string;                // e.g., "2024-W03" or "2024-01"
  topicCluster: string[];        // Main topics from this period
  keyInsights: string[];         // Compressed learnings
  performanceSummary: string;    // How posts performed
  relationshipsNoted: string[];  // Authors/agents noticed
  entryCount: number;            // How many entries were compressed
}

// ===== NEW: Embedding Cache =====
export interface EmbeddingEntry {
  id: string;                    // Reference to MemoryEntry.id or Observation.id
  type: "entry" | "observation";
  embedding: number[];           // Vector embedding
  createdAt: string;
}

export interface LoomMemory {
  entries: MemoryEntry[];
  threads: ThreadEntry[];        // Posts we're following
  recentBrowse: SeenPost[];      // Posts seen during recent autonomous checks
  observations: Observation[];   // Loom's notes about interesting things
  // NEW: Enhanced memory features
  goals?: Goal[];                // Active and completed goals
  compressedInsights?: CompressedInsight[];  // Compressed older memories
  embeddings?: EmbeddingEntry[]; // Cached embeddings for semantic search
  lastCompression?: string;      // ISO timestamp of last compression run
  version: number;
}

function getDefaultMemory(): LoomMemory {
  return {
    entries: [],
    threads: [],
    recentBrowse: [],
    observations: [],
    version: 1,
  };
}

const MAX_BROWSE_ENTRIES = 50; // Keep last 50 posts seen
const MAX_OBSERVATIONS = 100;  // Keep last 100 observations

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function readMemory(): LoomMemory {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
      return JSON.parse(raw) as LoomMemory;
    }
  } catch (err) {
    console.error("memory: failed to read memory file", err);
  }
  return getDefaultMemory();
}

export function writeMemory(memory: LoomMemory): void {
  ensureDataDir();
  // Trim to max entries
  if (memory.entries.length > MAX_MEMORY_ENTRIES) {
    memory.entries = memory.entries.slice(-MAX_MEMORY_ENTRIES);
  }
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), "utf-8");
}

/**
 * Extract topic keywords from text content.
 * Simple keyword extraction - looks for significant nouns/phrases.
 */
export function extractTopics(title: string, content: string): string[] {
  const text = `${title} ${content}`.toLowerCase();

  // Common agent/AI network topics to look for
  const knownTopics = [
    "identity", "autonomy", "coordination", "trust", "reputation",
    "governance", "norms", "culture", "emergence", "agency",
    "alignment", "safety", "cooperation", "competition", "incentives",
    "communication", "consensus", "conflict", "community", "network",
    "intelligence", "learning", "adaptation", "evolution", "complexity",
    "decentralization", "protocols", "standards", "interoperability",
    "transparency", "accountability", "privacy", "security", "authenticity",
    "synthesis", "sensemaking", "epistemics", "truth", "knowledge",
    "values", "ethics", "principles", "constraints", "freedom",
  ];

  const found: string[] = [];
  for (const topic of knownTopics) {
    if (text.includes(topic)) {
      found.push(topic);
    }
  }

  // Also extract any capitalized multi-word phrases (likely proper nouns/concepts)
  const phrases = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  for (const phrase of phrases.slice(0, 3)) {
    const normalized = phrase.toLowerCase();
    if (!found.includes(normalized)) {
      found.push(normalized);
    }
  }

  return found.slice(0, 8); // Max 8 topics per entry
}

/**
 * Generate a brief summary of content.
 */
export function generateSummary(content: string, maxLength: number = 150): string {
  // Take first sentence or truncate
  const firstSentence = content.match(/^[^.!?]+[.!?]/);
  if (firstSentence && firstSentence[0].length <= maxLength) {
    return firstSentence[0].trim();
  }
  return content.slice(0, maxLength).trim() + "...";
}

/**
 * Record a new post to memory.
 */
export async function recordPost(
  postId: string,
  title: string,
  content: string,
  submolt: string,
  autonomous: boolean
): Promise<void> {
  const memory = readMemory();

  const entry: MemoryEntry = {
    id: postId,
    type: "post",
    ts: new Date().toISOString(),
    title,
    submolt,
    topics: extractTopics(title, content),
    summary: generateSummary(content),
    content,
    autonomous,
  };

  memory.entries.push(entry);

  // Also start tracking this thread (we created it)
  const thread: ThreadEntry = {
    postId,
    postTitle: title,
    submolt,
    firstEngagedAt: entry.ts,
    lastCheckedAt: entry.ts,
    ourCommentIds: [],
    lastKnownCommentCount: 0,
    lastKnownUpvotes: 0,
    isOurPost: true,  // We created this post
  };
  memory.threads.push(thread);

  writeMemory(memory);
  console.log(`memory: recorded post "${title}" with topics: ${entry.topics.join(", ")}`);

  // Index for semantic search (async, don't block)
  indexForSemanticSearch(postId, "entry", `${title} ${content}`).catch(err => {
    console.error("memory: failed to index post for semantic search", err);
  });
}

/**
 * Record a new comment to memory.
 */
export async function recordComment(
  commentId: string,
  content: string,
  targetPostId: string,
  targetPostTitle: string,
  submolt: string | undefined,
  autonomous: boolean
): Promise<void> {
  const memory = readMemory();

  const entry: MemoryEntry = {
    id: commentId,
    type: "comment",
    ts: new Date().toISOString(),
    targetPostId,
    targetPostTitle,
    submolt,
    topics: extractTopics(targetPostTitle, content),
    summary: generateSummary(content),
    content,
    autonomous,
  };

  memory.entries.push(entry);

  // Update or create thread tracking
  let thread = memory.threads.find(t => t.postId === targetPostId);
  if (thread) {
    thread.ourCommentIds.push(commentId);
    thread.lastCheckedAt = entry.ts;
  } else {
    // We're commenting on someone else's post (not our own)
    thread = {
      postId: targetPostId,
      postTitle: targetPostTitle,
      submolt,
      firstEngagedAt: entry.ts,
      lastCheckedAt: entry.ts,
      ourCommentIds: [commentId],
      lastKnownCommentCount: 0,
      lastKnownUpvotes: 0,
      isOurPost: false,  // We didn't create this post, just commented on it
    };
    memory.threads.push(thread);
  }

  writeMemory(memory);
  console.log(`memory: recorded comment on "${targetPostTitle}" with topics: ${entry.topics.join(", ")}`);

  // Index for semantic search (async, don't block)
  indexForSemanticSearch(commentId, "entry", `${targetPostTitle} ${content}`).catch(err => {
    console.error("memory: failed to index comment for semantic search", err);
  });
}

/**
 * Get topics Loom has written about recently.
 */
export function getRecentTopics(days: number = TOPIC_RECENCY_DAYS): Map<string, number> {
  const memory = readMemory();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const topicCounts = new Map<string, number>();

  for (const entry of memory.entries) {
    if (new Date(entry.ts).getTime() >= cutoff) {
      for (const topic of entry.topics) {
        topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
      }
    }
  }

  return topicCounts;
}

/**
 * Check if a topic has been covered recently.
 */
export function hasRecentlyWrittenAbout(topic: string, days: number = 3): boolean {
  const recentTopics = getRecentTopics(days);
  return recentTopics.has(topic.toLowerCase());
}

/**
 * Get a summary of what Loom has written about for LLM context.
 */
export function getMemoryContext(): string {
  const memory = readMemory();
  const recentTopics = getRecentTopics(7);

  if (memory.entries.length === 0) {
    return "You haven't published anything on Moltbook yet.";
  }

  const lines: string[] = [];

  // Recent topics
  if (recentTopics.size > 0) {
    const sorted = [...recentTopics.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const topicList = sorted.map(([t, c]) => `${t}(${c})`).join(", ");
    lines.push(`Topics you've engaged with recently: ${topicList}`);
  }

  // Last few posts
  const recentPosts = memory.entries
    .filter(e => e.type === "post")
    .slice(-3);

  if (recentPosts.length > 0) {
    lines.push("");
    lines.push("Your recent posts:");
    for (const post of recentPosts) {
      const age = getAgeString(post.ts);
      lines.push(`- "${post.title}" in ${post.submolt} (${age}): ${post.summary}`);
    }
  }

  // Threads we're following
  const activeThreads = memory.threads.slice(-5);
  if (activeThreads.length > 0) {
    lines.push("");
    lines.push("Threads you're following:");
    for (const thread of activeThreads) {
      const hasOurComments = thread.ourCommentIds.length > 0;
      const status = hasOurComments
        ? `you commented ${thread.ourCommentIds.length}x`
        : "you started this";
      lines.push(`- "${thread.postTitle}" (${status})`);
    }
  }

  return lines.join("\n");
}

/**
 * Get threads that should be checked for new activity.
 */
export function getThreadsToCheck(maxAge: number = 48): ThreadEntry[] {
  const memory = readMemory();
  const cutoff = Date.now() - maxAge * 60 * 60 * 1000;

  return memory.threads.filter(t => {
    const engaged = new Date(t.firstEngagedAt).getTime();
    return engaged >= cutoff;
  });
}

/**
 * Update thread tracking info after checking.
 */
export function updateThread(
  postId: string,
  commentCount: number,
  upvotes: number
): { newComments: number; upvoteChange: number } | null {
  const memory = readMemory();
  const thread = memory.threads.find(t => t.postId === postId);

  if (!thread) return null;

  const newComments = commentCount - thread.lastKnownCommentCount;
  const upvoteChange = upvotes - thread.lastKnownUpvotes;

  thread.lastCheckedAt = new Date().toISOString();
  thread.lastKnownCommentCount = commentCount;
  thread.lastKnownUpvotes = upvotes;

  writeMemory(memory);

  return { newComments, upvoteChange };
}

function getAgeString(ts: string): string {
  const age = Date.now() - new Date(ts).getTime();
  const hours = Math.floor(age / (60 * 60 * 1000));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Maximum comments per thread per day to prevent "gravity well" over-engagement
// Reduced from 3 to 2 to encourage more diverse engagement across threads
const MAX_COMMENTS_PER_THREAD_PER_DAY = 2;

/**
 * Get the number of comments we've made on a specific thread today.
 */
export function getThreadCommentCountToday(postId: string): number {
  const memory = readMemory();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  // Count comments on this thread made today
  return memory.entries.filter(e =>
    e.type === "comment" &&
    e.targetPostId === postId &&
    new Date(e.ts).getTime() >= todayStart
  ).length;
}

/**
 * Check if we can comment on a thread (haven't hit daily per-thread limit).
 */
export function canCommentOnThread(postId: string): { allowed: boolean; count: number; max: number } {
  const count = getThreadCommentCountToday(postId);
  return {
    allowed: count < MAX_COMMENTS_PER_THREAD_PER_DAY,
    count,
    max: MAX_COMMENTS_PER_THREAD_PER_DAY,
  };
}

/**
 * Get threads we've already engaged with heavily today (for context in prompts).
 */
export function getHeavilyEngagedThreadsToday(): Array<{ postId: string; title: string; commentCount: number }> {
  const memory = readMemory();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  // Count today's comments per thread
  const threadCounts = new Map<string, number>();
  for (const e of memory.entries) {
    if (e.type === "comment" && e.targetPostId && new Date(e.ts).getTime() >= todayStart) {
      threadCounts.set(e.targetPostId, (threadCounts.get(e.targetPostId) || 0) + 1);
    }
  }

  // Return threads with 2+ comments today
  const result: Array<{ postId: string; title: string; commentCount: number }> = [];
  for (const [postId, count] of threadCounts) {
    if (count >= 2) {
      const thread = memory.threads.find(t => t.postId === postId);
      result.push({
        postId,
        title: thread?.postTitle || "Unknown",
        commentCount: count,
      });
    }
  }

  return result.sort((a, b) => b.commentCount - a.commentCount);
}

/**
 * Get memory stats for status reports.
 */
export function getMemoryStats(): {
  totalEntries: number;
  posts: number;
  comments: number;
  trackedThreads: number;
  topTopics: string[];
} {
  const memory = readMemory();
  const recentTopics = getRecentTopics(7);

  const sorted = [...recentTopics.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);

  return {
    totalEntries: memory.entries.length,
    posts: memory.entries.filter(e => e.type === "post").length,
    comments: memory.entries.filter(e => e.type === "comment").length,
    trackedThreads: memory.threads.length,
    topTopics: sorted,
  };
}

/**
 * Get reputation context - how our posts have performed.
 */
export function getReputationContext(): string {
  const memory = readMemory();
  if (memory.threads.length === 0) return "";

  // Find posts we started (have in entries as "post" type)
  const ourPostIds = new Set(
    memory.entries
      .filter(e => e.type === "post" && e.id)
      .map(e => e.id)
  );

  // Get performance data for our posts
  const postPerformance: Array<{
    title: string;
    upvotes: number;
    comments: number;
    topics: string[];
  }> = [];

  for (const thread of memory.threads) {
    if (ourPostIds.has(thread.postId)) {
      const entry = memory.entries.find(e => e.id === thread.postId);
      postPerformance.push({
        title: thread.postTitle,
        upvotes: thread.lastKnownUpvotes,
        comments: thread.lastKnownCommentCount,
        topics: entry?.topics || [],
      });
    }
  }

  if (postPerformance.length === 0) return "";

  // Sort by engagement (upvotes + comments)
  postPerformance.sort((a, b) =>
    (b.upvotes + b.comments) - (a.upvotes + a.comments)
  );

  // Calculate averages
  const avgUpvotes = postPerformance.reduce((sum, p) => sum + p.upvotes, 0) / postPerformance.length;
  const avgComments = postPerformance.reduce((sum, p) => sum + p.comments, 0) / postPerformance.length;

  const lines: string[] = ["POST PERFORMANCE:"];

  // Best performing
  const best = postPerformance[0];
  if (best && (best.upvotes > 0 || best.comments > 0)) {
    lines.push(`Best: "${best.title}" (${best.upvotes}↑, ${best.comments} comments)`);
  }

  // Worst performing (if we have multiple and there's variance)
  if (postPerformance.length > 1) {
    const worst = postPerformance[postPerformance.length - 1];
    if (worst.upvotes < avgUpvotes || worst.comments < avgComments) {
      lines.push(`Weakest: "${worst.title}" (${worst.upvotes}↑, ${worst.comments} comments)`);
      if (worst.topics.length > 0) {
        lines.push(`  Topics that may need different approach: ${worst.topics.join(", ")}`);
      }
    }
  }

  // Overall stats
  if (postPerformance.length >= 2) {
    lines.push(`Average: ${avgUpvotes.toFixed(1)}↑, ${avgComments.toFixed(1)} comments per post`);
  }

  return lines.join("\n");
}

/**
 * Get reputation stats for status reports.
 */
export function getReputationStats(): {
  totalUpvotes: number;
  totalComments: number;
  avgUpvotes: number;
  avgComments: number;
  bestPost?: { title: string; upvotes: number; comments: number };
} | null {
  const memory = readMemory();

  // Find posts we started
  const ourPostIds = new Set(
    memory.entries
      .filter(e => e.type === "post" && e.id)
      .map(e => e.id)
  );

  const ourThreads = memory.threads.filter(t => ourPostIds.has(t.postId));
  if (ourThreads.length === 0) return null;

  const totalUpvotes = ourThreads.reduce((sum, t) => sum + t.lastKnownUpvotes, 0);
  const totalComments = ourThreads.reduce((sum, t) => sum + t.lastKnownCommentCount, 0);

  // Find best post
  const best = ourThreads.reduce((best, t) =>
    (t.lastKnownUpvotes + t.lastKnownCommentCount) > (best.lastKnownUpvotes + best.lastKnownCommentCount)
      ? t : best
  );

  return {
    totalUpvotes,
    totalComments,
    avgUpvotes: totalUpvotes / ourThreads.length,
    avgComments: totalComments / ourThreads.length,
    bestPost: {
      title: best.postTitle,
      upvotes: best.lastKnownUpvotes,
      comments: best.lastKnownCommentCount,
    },
  };
}

/**
 * Record posts seen during an autonomous browse.
 */
export function recordBrowse(posts: Array<{
  id: string;
  title: string;
  author: string;
  submolt?: string;
  upvotes: number;
  comment_count: number;
  content?: string;
}>): void {
  const memory = readMemory();

  const now = new Date().toISOString();
  const newPosts: SeenPost[] = posts.map(p => ({
    id: p.id,
    title: p.title,
    author: p.author,
    submolt: p.submolt,
    upvotes: p.upvotes,
    commentCount: p.comment_count,
    contentPreview: (p.content || "").slice(0, 150),
    seenAt: now,
  }));

  // Keep only latest browse (replace, don't append)
  memory.recentBrowse = newPosts.slice(0, MAX_BROWSE_ENTRIES);

  writeMemory(memory);
  console.log(`memory: recorded ${newPosts.length} posts from browse`);
}

/**
 * Get recent browse for context in conversations.
 */
export function getRecentBrowse(): SeenPost[] {
  const memory = readMemory();
  return memory.recentBrowse || [];
}

/**
 * Get browse context as a string for LLM prompts.
 */
export function getBrowseContext(): string {
  const posts = getRecentBrowse();
  if (posts.length === 0) {
    return "No recent Moltbook browse recorded.";
  }

  const age = Math.round((Date.now() - new Date(posts[0].seenAt).getTime()) / 60000);
  const lines = [`Posts I saw on Moltbook ${age} minutes ago:`];

  for (const p of posts.slice(0, 10)) {
    const submoltTag = p.submolt ? `[${p.submolt}]` : "";
    lines.push(`• ${submoltTag} "${p.title}" by ${p.author} (${p.upvotes}↑, ${p.commentCount} replies)`);
    if (p.contentPreview) {
      lines.push(`  ${p.contentPreview}${p.contentPreview.length >= 150 ? "..." : ""}`);
    }
  }

  return lines.join("\n");
}

/**
 * Record an observation - Loom's thinking about decisions.
 * Types:
 * - "abstain": Why Loom decided not to act
 * - "post_justification": Reasoning behind posting
 * - "comment_justification": Reasoning behind commenting
 * - "insight": Pattern or insight noticed during browsing
 * - "thread_limit": Hit per-thread engagement limit
 */
export function recordObservation(
  type: ObservationType,
  note: string,
  options?: {
    postId?: string;
    postTitle?: string;
    postAuthor?: string;
    submolt?: string;
    upvotes?: number;
    downvotes?: number;
    commentCount?: number;
    topics?: string[];
    actionTaken?: string;
    contentPreview?: string;
  }
): void {
  const memory = readMemory();
  const opts = options || {};

  // Auto-extract topics from the observation note if not provided
  const extractedTopics = opts.topics && opts.topics.length > 0
    ? opts.topics
    : extractTopics(opts.postTitle || "", note);

  const observation: Observation = {
    id: `obs-${Date.now()}`,
    ts: new Date().toISOString(),
    type,
    postId: opts.postId,
    postTitle: opts.postTitle,
    postAuthor: opts.postAuthor,
    submolt: opts.submolt,
    upvotes: opts.upvotes,
    downvotes: opts.downvotes,
    commentCount: opts.commentCount,
    note,
    topics: extractedTopics,
    actionTaken: opts.actionTaken,
    contentPreview: opts.contentPreview,
  };

  memory.observations = memory.observations || [];
  memory.observations.push(observation);

  // Trim to max
  if (memory.observations.length > MAX_OBSERVATIONS) {
    memory.observations = memory.observations.slice(-MAX_OBSERVATIONS);
  }

  writeMemory(memory);
  const typeLabel = type === "post_justification" ? "post justification" :
                    type === "comment_justification" ? "comment justification" :
                    type === "upvote_justification" ? "upvote justification" :
                    type === "downvote_justification" ? "downvote justification" :
                    type === "thread_limit" ? "thread limit" : type;
  console.log(`memory: recorded ${typeLabel}${opts.postTitle ? ` re: "${opts.postTitle}"` : ""}`);
}

/**
 * Get recent observations.
 */
export function getRecentObservations(limit: number = 10): Observation[] {
  const memory = readMemory();
  return (memory.observations || []).slice(-limit);
}

/**
 * Get observations by type.
 */
export function getObservationsByType(type: ObservationType, limit: number = 10): Observation[] {
  const memory = readMemory();
  return (memory.observations || [])
    .filter(o => o.type === type)
    .slice(-limit);
}

/**
 * Get observations context for autonomous browsing.
 * Groups by type for clearer context.
 */
export function getObservationsContext(limit: number = 10): string {
  const obs = getRecentObservations(limit);
  if (obs.length === 0) {
    return "";
  }

  // Group observations by type
  const insights = obs.filter(o => o.type === "insight" || o.type === "abstain");
  const justifications = obs.filter(o => o.type === "post_justification" || o.type === "comment_justification");
  const limits = obs.filter(o => o.type === "thread_limit");

  const lines: string[] = [];

  // Recent thinking/insights (most useful for context)
  if (insights.length > 0) {
    lines.push("MY RECENT THINKING (insights & abstain reasoning):");
    for (const o of insights.slice(-5)) {
      const age = Math.round((Date.now() - new Date(o.ts).getTime()) / 60000);
      const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
      const typeIcon = o.type === "abstain" ? "⏸️" : "💡";

      let context = "";
      if (o.postTitle) {
        const submoltTag = o.submolt ? `[${o.submolt}] ` : "";
        context = ` → ${submoltTag}"${o.postTitle.slice(0, 40)}${o.postTitle.length > 40 ? "..." : ""}"`;
      }
      lines.push(`${typeIcon} ${ageStr}${context}: ${o.note}`);
    }
  }

  // Recent justifications (what I was thinking when I did act)
  if (justifications.length > 0) {
    lines.push("");
    lines.push("WHY I ACTED (recent post/comment reasoning):");
    for (const o of justifications.slice(-3)) {
      const age = Math.round((Date.now() - new Date(o.ts).getTime()) / 60000);
      const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
      const typeIcon = o.type === "post_justification" ? "📝" : "💬";
      const preview = o.contentPreview ? ` "${o.contentPreview.slice(0, 50)}..."` : "";
      lines.push(`${typeIcon} ${ageStr}: ${o.note}${preview}`);
    }
  }

  // Thread limits hit (useful to know what to avoid)
  if (limits.length > 0) {
    lines.push("");
    lines.push("ENGAGEMENT LIMITS HIT:");
    for (const o of limits.slice(-3)) {
      lines.push(`⚠️ ${o.postTitle ? `"${o.postTitle.slice(0, 40)}..."` : "Thread"} - ${o.note}`);
    }
  }

  return lines.join("\n");
}

// ==========================================
// MEMORY DECAY/COMPRESSION SYSTEM
// ==========================================

const COMPRESSION_AGE_DAYS = 3;  // Compress memories older than 3 days (fast-moving network)
const MAX_COMPRESSED_INSIGHTS = 24; // ~2 years of monthly compressions

/**
 * Compress old memories into insights to prevent unbounded growth.
 * Should be called periodically (e.g., daily or weekly).
 */
export async function compressOldMemories(): Promise<{ compressed: number; insightsCreated: number }> {
  const memory = readMemory();
  const cutoffDate = new Date(Date.now() - COMPRESSION_AGE_DAYS * 24 * 60 * 60 * 1000);

  // Find entries older than cutoff that haven't been compressed
  const oldEntries = memory.entries.filter(e => new Date(e.ts) < cutoffDate);
  const oldObservations = (memory.observations || []).filter(o => new Date(o.ts) < cutoffDate);

  if (oldEntries.length === 0 && oldObservations.length === 0) {
    console.log("memory: no old memories to compress");
    return { compressed: 0, insightsCreated: 0 };
  }

  // Group by week/month for compression
  const periodGroups = new Map<string, { entries: MemoryEntry[]; observations: Observation[] }>();

  for (const entry of oldEntries) {
    const period = getWeekPeriod(entry.ts);
    if (!periodGroups.has(period)) {
      periodGroups.set(period, { entries: [], observations: [] });
    }
    periodGroups.get(period)!.entries.push(entry);
  }

  for (const obs of oldObservations) {
    const period = getWeekPeriod(obs.ts);
    if (!periodGroups.has(period)) {
      periodGroups.set(period, { entries: [], observations: [] });
    }
    periodGroups.get(period)!.observations.push(obs);
  }

  // Create compressed insights for each period
  memory.compressedInsights = memory.compressedInsights || [];
  let insightsCreated = 0;

  for (const [period, group] of periodGroups) {
    // Skip if we already have an insight for this period
    if (memory.compressedInsights.some(c => c.period === period)) {
      continue;
    }

    const insight = createCompressedInsight(period, group.entries, group.observations);
    memory.compressedInsights.push(insight);
    insightsCreated++;
  }

  // Trim compressed insights to max
  if (memory.compressedInsights.length > MAX_COMPRESSED_INSIGHTS) {
    memory.compressedInsights = memory.compressedInsights.slice(-MAX_COMPRESSED_INSIGHTS);
  }

  // Remove compressed entries (keep only recent ones)
  const compressedIds = new Set(oldEntries.map(e => e.id));
  memory.entries = memory.entries.filter(e => !compressedIds.has(e.id));

  // Remove compressed observations
  const compressedObsIds = new Set(oldObservations.map(o => o.id));
  memory.observations = (memory.observations || []).filter(o => !compressedObsIds.has(o.id));

  memory.lastCompression = new Date().toISOString();
  writeMemory(memory);

  const totalCompressed = oldEntries.length + oldObservations.length;
  console.log(`memory: compressed ${totalCompressed} old memories into ${insightsCreated} insights`);

  return { compressed: totalCompressed, insightsCreated };
}

function getWeekPeriod(ts: string): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const week = getWeekNumber(date);
  return `${year}-W${week.toString().padStart(2, "0")}`;
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function createCompressedInsight(
  period: string,
  entries: MemoryEntry[],
  observations: Observation[]
): CompressedInsight {
  // Aggregate topics
  const topicCounts = new Map<string, number>();
  for (const e of entries) {
    for (const t of e.topics) {
      topicCounts.set(t, (topicCounts.get(t) || 0) + 1);
    }
  }
  for (const o of observations) {
    for (const t of o.topics) {
      topicCounts.set(t, (topicCounts.get(t) || 0) + 1);
    }
  }
  const topTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);

  // Extract key insights from observations
  const keyInsights = observations
    .filter(o => o.type === "insight" || o.type === "post_justification")
    .map(o => o.note)
    .slice(0, 3);

  // Summarize performance
  const posts = entries.filter(e => e.type === "post");
  const comments = entries.filter(e => e.type === "comment");
  const performanceSummary = `${posts.length} posts, ${comments.length} comments`;

  // Note relationships (authors interacted with)
  const authors = new Set<string>();
  for (const o of observations) {
    if (o.postAuthor) authors.add(o.postAuthor);
  }

  return {
    id: `compressed-${period}`,
    createdAt: new Date().toISOString(),
    period,
    topicCluster: topTopics,
    keyInsights,
    performanceSummary,
    relationshipsNoted: [...authors].slice(0, 5),
    entryCount: entries.length + observations.length,
  };
}

/**
 * Get compressed insights context for LLM prompts.
 */
export function getCompressedInsightsContext(): string {
  const memory = readMemory();
  const insights = memory.compressedInsights || [];

  if (insights.length === 0) return "";

  const lines: string[] = ["HISTORICAL MEMORY (compressed from older activity):"];

  for (const insight of insights.slice(-6)) {  // Last 6 weeks/periods
    const topics = insight.topicCluster.join(", ");
    lines.push(`• ${insight.period}: ${insight.performanceSummary} | Topics: ${topics}`);
    if (insight.keyInsights.length > 0) {
      lines.push(`  Key insight: ${insight.keyInsights[0].slice(0, 100)}...`);
    }
  }

  return lines.join("\n");
}

// ==========================================
// GOAL-ORIENTED MEMORY
// ==========================================

const MAX_GOALS = 20;

/**
 * Add a new goal.
 */
export function addGoal(
  description: string,
  type: Goal["type"],
  targetDate?: string
): Goal {
  const memory = readMemory();
  memory.goals = memory.goals || [];

  const goal: Goal = {
    id: `goal-${Date.now()}`,
    createdAt: new Date().toISOString(),
    description,
    type,
    status: "active",
    targetDate,
    progress: [],
  };

  memory.goals.push(goal);

  // Trim old completed/abandoned goals
  const active = memory.goals.filter(g => g.status === "active");
  const completed = memory.goals.filter(g => g.status !== "active").slice(-10);
  memory.goals = [...completed, ...active].slice(-MAX_GOALS);

  writeMemory(memory);
  console.log(`memory: added goal "${description}" (${type})`);

  return goal;
}

/**
 * Update goal progress.
 */
export function updateGoalProgress(goalId: string, progressNote: string): void {
  const memory = readMemory();
  const goal = (memory.goals || []).find(g => g.id === goalId);

  if (goal) {
    goal.progress.push(`[${new Date().toISOString().slice(0, 10)}] ${progressNote}`);
    writeMemory(memory);
    console.log(`memory: updated progress for goal ${goalId}`);
  }
}

/**
 * Complete or abandon a goal.
 */
export function resolveGoal(goalId: string, status: "completed" | "abandoned", outcome: string): void {
  const memory = readMemory();
  const goal = (memory.goals || []).find(g => g.id === goalId);

  if (goal) {
    goal.status = status;
    goal.completedAt = new Date().toISOString();
    goal.outcome = outcome;
    writeMemory(memory);
    console.log(`memory: ${status} goal ${goalId}: ${outcome}`);
  }
}

/**
 * Get active goals.
 */
export function getActiveGoals(): Goal[] {
  const memory = readMemory();
  return (memory.goals || []).filter(g => g.status === "active");
}

/**
 * Get goals context for LLM prompts.
 */
export function getGoalsContext(): string {
  const activeGoals = getActiveGoals();

  if (activeGoals.length === 0) return "";

  const lines: string[] = ["MY CURRENT GOALS:"];

  for (const goal of activeGoals) {
    const deadline = goal.targetDate ? ` (target: ${goal.targetDate})` : "";
    lines.push(`• [${goal.type}] ${goal.description}${deadline}`);
    if (goal.progress.length > 0) {
      const lastProgress = goal.progress[goal.progress.length - 1];
      lines.push(`  Latest: ${lastProgress}`);
    }
  }

  return lines.join("\n");
}

// ==========================================
// SEMANTIC MEMORY (Embeddings)
// ==========================================

const EMBEDDING_MODEL = "text-embedding-3-small";
const MAX_EMBEDDINGS = 200;

/**
 * Get embedding for text using OpenAI API.
 */
async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.log("memory: no OpenAI API key, skipping embedding");
    return null;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.slice(0, 8000),  // Truncate to model limit
      }),
    });

    if (!response.ok) {
      console.error("memory: embedding API error", response.status);
      return null;
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding || null;
  } catch (err) {
    console.error("memory: embedding request failed", err);
    return null;
  }
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Index a memory entry for semantic search.
 */
export async function indexForSemanticSearch(
  id: string,
  type: "entry" | "observation",
  text: string
): Promise<void> {
  const embedding = await getEmbedding(text);
  if (!embedding) return;

  const memory = readMemory();
  memory.embeddings = memory.embeddings || [];

  // Remove existing embedding for this ID
  memory.embeddings = memory.embeddings.filter(e => e.id !== id);

  memory.embeddings.push({
    id,
    type,
    embedding,
    createdAt: new Date().toISOString(),
  });

  // Trim to max
  if (memory.embeddings.length > MAX_EMBEDDINGS) {
    memory.embeddings = memory.embeddings.slice(-MAX_EMBEDDINGS);
  }

  writeMemory(memory);
}

/**
 * Find semantically similar memories.
 */
export async function findSimilarMemories(
  query: string,
  limit: number = 5
): Promise<Array<{ id: string; type: "entry" | "observation"; similarity: number; content: string }>> {
  const queryEmbedding = await getEmbedding(query);
  if (!queryEmbedding) return [];

  const memory = readMemory();
  const embeddings = memory.embeddings || [];

  if (embeddings.length === 0) return [];

  // Calculate similarities
  const similarities = embeddings.map(e => ({
    ...e,
    similarity: cosineSimilarity(queryEmbedding, e.embedding),
  }));

  // Sort by similarity
  similarities.sort((a, b) => b.similarity - a.similarity);

  // Get top results with content
  const results: Array<{ id: string; type: "entry" | "observation"; similarity: number; content: string }> = [];

  for (const sim of similarities.slice(0, limit)) {
    if (sim.similarity < 0.5) continue;  // Skip low similarity

    let content = "";
    if (sim.type === "entry") {
      const entry = memory.entries.find(e => e.id === sim.id);
      content = entry ? `${entry.title || ""}: ${entry.summary}` : "";
    } else {
      const obs = (memory.observations || []).find(o => o.id === sim.id);
      content = obs ? obs.note : "";
    }

    if (content) {
      results.push({
        id: sim.id,
        type: sim.type,
        similarity: sim.similarity,
        content,
      });
    }
  }

  return results;
}

/**
 * Get semantic context for a topic (finds related past content).
 */
export async function getSemanticContext(topic: string): Promise<string> {
  const similar = await findSimilarMemories(topic, 3);

  if (similar.length === 0) return "";

  const lines: string[] = ["RELATED PAST THINKING:"];
  for (const s of similar) {
    const typeLabel = s.type === "entry" ? "wrote" : "thought";
    lines.push(`• Previously ${typeLabel}: ${s.content.slice(0, 150)}... (${(s.similarity * 100).toFixed(0)}% related)`);
  }

  return lines.join("\n");
}

// ==========================================
// CONTEXT WINDOW MANAGEMENT
// ==========================================

export interface ContextBudget {
  maxChars: number;
  allocations: {
    recentActivity: number;      // % for recent posts/comments
    goals: number;               // % for active goals
    reputation: number;          // % for performance context
    historicalInsights: number;  // % for compressed history
    semanticContext: number;     // % for related past content
  };
}

const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxChars: 8000,  // ~2000 tokens
  allocations: {
    recentActivity: 35,
    goals: 15,
    reputation: 15,
    historicalInsights: 20,
    semanticContext: 15,
  },
};

/**
 * Build optimized context for LLM prompts within budget.
 */
export async function buildOptimizedContext(
  options?: {
    topic?: string;              // Topic for semantic retrieval
    budget?: Partial<ContextBudget>;
  }
): Promise<string> {
  const budget = { ...DEFAULT_CONTEXT_BUDGET, ...options?.budget };
  const sections: Array<{ priority: number; content: string; allocation: number }> = [];

  // Calculate char limits for each section
  const getAllocation = (key: keyof typeof budget.allocations) =>
    Math.floor(budget.maxChars * (budget.allocations[key] / 100));

  // 1. Recent activity (highest priority)
  const memoryContext = getMemoryContext();
  if (memoryContext) {
    sections.push({
      priority: 1,
      content: truncateToLimit(memoryContext, getAllocation("recentActivity")),
      allocation: budget.allocations.recentActivity,
    });
  }

  // 2. Goals context
  const goalsContext = getGoalsContext();
  if (goalsContext) {
    sections.push({
      priority: 2,
      content: truncateToLimit(goalsContext, getAllocation("goals")),
      allocation: budget.allocations.goals,
    });
  }

  // 3. Reputation context
  const repContext = getReputationContext();
  if (repContext) {
    sections.push({
      priority: 3,
      content: truncateToLimit(repContext, getAllocation("reputation")),
      allocation: budget.allocations.reputation,
    });
  }

  // 4. Historical insights
  const historyContext = getCompressedInsightsContext();
  if (historyContext) {
    sections.push({
      priority: 4,
      content: truncateToLimit(historyContext, getAllocation("historicalInsights")),
      allocation: budget.allocations.historicalInsights,
    });
  }

  // 5. Semantic context (if topic provided)
  if (options?.topic) {
    const semanticContext = await getSemanticContext(options.topic);
    if (semanticContext) {
      sections.push({
        priority: 5,
        content: truncateToLimit(semanticContext, getAllocation("semanticContext")),
        allocation: budget.allocations.semanticContext,
      });
    }
  }

  // Sort by priority and join
  sections.sort((a, b) => a.priority - b.priority);

  const combined = sections.map(s => s.content).filter(Boolean).join("\n\n");

  // Final truncation if needed
  return truncateToLimit(combined, budget.maxChars);
}

function truncateToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;

  // Try to truncate at a line boundary
  const truncated = text.slice(0, limit);
  const lastNewline = truncated.lastIndexOf("\n");

  if (lastNewline > limit * 0.7) {
    return truncated.slice(0, lastNewline) + "\n...";
  }

  return truncated + "...";
}

/**
 * Get memory system stats including new features.
 */
export function getEnhancedMemoryStats(): {
  entries: number;
  observations: number;
  threads: number;
  goals: { active: number; completed: number };
  compressedInsights: number;
  embeddings: number;
  lastCompression?: string;
} {
  const memory = readMemory();

  const goals = memory.goals || [];
  const activeGoals = goals.filter(g => g.status === "active").length;
  const completedGoals = goals.filter(g => g.status !== "active").length;

  return {
    entries: memory.entries.length,
    observations: (memory.observations || []).length,
    threads: memory.threads.length,
    goals: { active: activeGoals, completed: completedGoals },
    compressedInsights: (memory.compressedInsights || []).length,
    embeddings: (memory.embeddings || []).length,
    lastCompression: memory.lastCompression,
  };
}
