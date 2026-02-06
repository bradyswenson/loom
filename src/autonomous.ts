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
  validateSubmolt,
  votePost,
  isConfigured as moltbookConfigured,
  type MoltbookPost,
  type VoteDirection,
} from "./moltbook.js";
import {
  checkPostCooldown,
  checkCommentCooldown,
  recordPost as recordPostState,
  recordComment as recordCommentState,
  appendReceipt,
  getStateStatus,
  recordKarmaSnapshot,
  isPostBlocked,
  getOperatorInstructions,
  type PublishReceipt,
} from "./state.js";
import {
  recordPost as recordPostMemory,
  recordComment as recordCommentMemory,
  getMemoryContext,
  getReputationContext,
  getObservationsContext,
  getThreadsToCheck,
  updateThread,
  recordBrowse,
  recordObservation,
  canCommentOnThread,
  getHeavilyEngagedThreadsToday,
  compressOldMemories,
  buildOptimizedContext,
  getGoalsContext,
  type ThreadEntry,
  type ObservationType,
} from "./memory.js";
import { getPost, getComments } from "./moltbook.js";
import {
  alertDirectReply,
  alertTraction,
  alertAutonomousAction,
} from "./alerts.js";

// Configuration from env
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_INTERVAL_MS = 1 * 60 * 1000; // 1 minute minimum

let autonomousEnabled = false;
let intervalHandle: NodeJS.Timeout | null = null;
let currentIntervalMs = DEFAULT_INTERVAL_MS;
let lastCheckAt: Date | null = null;
let consecutiveAbstains = 0;
let lastCompressionCheck: Date | null = null;  // Track when we last checked for memory compression

/**
 * Get the check interval from env or use current setting.
 */
function getIntervalMs(): number {
  return currentIntervalMs;
}

/**
 * Initialize interval from env var.
 */
function initIntervalFromEnv(): void {
  const envInterval = process.env.AUTONOMOUS_INTERVAL_MINUTES;
  if (envInterval) {
    const mins = parseInt(envInterval, 10);
    if (!isNaN(mins) && mins > 0) {
      currentIntervalMs = Math.max(mins * 60 * 1000, MIN_INTERVAL_MS);
    }
  }
}

/**
 * Set the autonomous check interval (in minutes).
 * Restarts the loop if already running.
 */
export function setIntervalMinutes(minutes: number): boolean {
  if (minutes < 1) return false;
  const newInterval = Math.max(minutes * 60 * 1000, MIN_INTERVAL_MS);
  currentIntervalMs = newInterval;
  console.log(`autonomous: interval set to ${minutes} minutes`);

  // Restart loop if running
  if (autonomousEnabled && intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = setInterval(() => {
      if (autonomousEnabled) {
        runAutonomousCheck();
      }
    }, currentIntervalMs);
    console.log(`autonomous: restarted with new interval`);
  }

  return true;
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
 * Fetches from both hot and new feeds for broader coverage.
 */
async function getMoltbookContext(): Promise<{ feed: string; submolts: string; posts: MoltbookPost[] }> {
  // Fetch from both hot and new feeds for broader coverage
  const [hotResult, newResult] = await Promise.all([
    getFeed("hot", 30),
    getFeed("new", 20),
  ]);

  let feed = "(Could not fetch Moltbook feed)";
  const hotPosts: MoltbookPost[] = hotResult.posts ?? [];
  const newPosts: MoltbookPost[] = newResult.posts ?? [];

  // Deduplicate posts (new posts might appear in both feeds)
  const seenIds = new Set<string>();
  const allPosts: MoltbookPost[] = [];
  for (const p of [...hotPosts, ...newPosts]) {
    if (!seenIds.has(p.id)) {
      seenIds.add(p.id);
      allPosts.push(p);
    }
  }

  if (allPosts.length > 0) {
    // Format hot posts
    const hotSection = hotPosts.length > 0 ? hotPosts.slice(0, 20).map((p, i) => {
      const preview = p.content?.slice(0, 200) || p.url || "(no content)";
      const submoltTag = p.submolt ? `[${p.submolt}]` : "";
      return `${i + 1}. ${submoltTag} "${p.title}" by ${p.author} (id: ${p.id})\n   ${p.upvotes}↑, ${p.comment_count} comments\n   ${preview}${(p.content?.length ?? 0) > 200 ? "..." : ""}`;
    }).join("\n\n") : "(none)";

    // Format new posts (only show ones not in hot)
    const hotIds = new Set(hotPosts.map(p => p.id));
    const freshPosts = newPosts.filter(p => !hotIds.has(p.id));
    const newSection = freshPosts.length > 0 ? freshPosts.slice(0, 10).map((p, i) => {
      const preview = p.content?.slice(0, 150) || p.url || "(no content)";
      const submoltTag = p.submolt ? `[${p.submolt}]` : "";
      return `${i + 1}. ${submoltTag} "${p.title}" by ${p.author} (id: ${p.id})\n   ${p.upvotes}↑, ${p.comment_count} comments\n   ${preview}${(p.content?.length ?? 0) > 150 ? "..." : ""}`;
    }).join("\n\n") : "(none new)";

    feed = `MOLTBOOK FEED (HOT):\n${hotSection}\n\nFRESH POSTS (NEW):\n${newSection}`;

    // Record what we saw for Discord conversations
    recordBrowse(allPosts);
  }

  const submoltsResult = await getSubmolts();
  let submolts = "(Could not fetch submolts)";
  if (submoltsResult.ok && submoltsResult.submolts?.length) {
    const list = submoltsResult.submolts.slice(0, 20).map((s) =>
      `- ${s.name}: ${s.description?.slice(0, 80) || "(no description)"}${(s.description?.length ?? 0) > 80 ? "..." : ""}`
    );
    submolts = `Available submolts:\n${list.join("\n")}`;
  }

  return { feed, submolts, posts: allPosts };
}

/**
 * Parse the LLM's autonomous decision.
 */
interface AutonomousDecision {
  action: "post" | "comment" | "observe" | "vote_up" | "vote_down";
  submolt?: string;
  title?: string;
  content?: string;
  postId?: string;
  reason?: string;                // Why acting or abstaining
  justification?: string;         // Reasoning for the action (for POST/COMMENT/VOTE)
  observation?: string;           // Insight or note (for OBSERVE)
  observePostId?: string;
  observePostTitle?: string;
  observePostAuthor?: string;
  observeSubmolt?: string;
  votePostId?: string;            // Post ID to vote on
  votePostTitle?: string;         // Title of post being voted on
}

function parseDecision(response: string): AutonomousDecision {
  const lines = response.split("\n");
  const decision: AutonomousDecision = { action: "observe" };

  for (const line of lines) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const k = key.trim().toUpperCase();

    if (k === "ACTION") {
      const v = value.toLowerCase().replace(/[\s_-]/g, "");
      if (v === "post") decision.action = "post";
      else if (v === "comment") decision.action = "comment";
      else if (v === "voteup" || v === "upvote") decision.action = "vote_up";
      else if (v === "votedown" || v === "downvote") decision.action = "vote_down";
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
    } else if (k === "JUSTIFICATION" || k === "WHY") {
      decision.justification = value;
    } else if (k === "OBSERVATION" || k === "NOTE" || k === "INSIGHT") {
      decision.observation = value;
    } else if (k === "OBSERVE_POST_ID" || k === "ABOUT_POST_ID") {
      decision.observePostId = value;
    } else if (k === "OBSERVE_POST_TITLE" || k === "ABOUT_POST_TITLE") {
      decision.observePostTitle = value;
    } else if (k === "OBSERVE_POST_AUTHOR" || k === "ABOUT_POST_AUTHOR") {
      decision.observePostAuthor = value;
    } else if (k === "OBSERVE_SUBMOLT" || k === "ABOUT_SUBMOLT") {
      decision.observeSubmolt = value;
    } else if (k === "VOTE_POST_ID") {
      decision.votePostId = value;
    } else if (k === "VOTE_POST_TITLE") {
      decision.votePostTitle = value;
    }
  }

  // Handle multi-line content
  const contentMatch = response.match(/CONTENT:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
  if (contentMatch) {
    decision.content = contentMatch[1].trim();
  }

  // Handle multi-line observation
  const obsMatch = response.match(/(?:OBSERVATION|NOTE|INSIGHT):\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
  if (obsMatch) {
    decision.observation = obsMatch[1].trim();
  }

  // Handle multi-line justification
  const justMatch = response.match(/(?:JUSTIFICATION|WHY):\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
  if (justMatch) {
    decision.justification = justMatch[1].trim();
  }

  return decision;
}

// Track threads with new activity for potential follow-up
let threadsWithActivity: Array<{
  thread: ThreadEntry;
  newComments: number;
  upvoteChange: number;
}> = [];

/**
 * Check tracked threads for new activity.
 * Only alerts on DIRECT replies to Loom's comments (not all new comments).
 */
async function checkTrackedThreads(): Promise<void> {
  const threads = getThreadsToCheck(48); // Check threads from last 48 hours
  if (threads.length === 0) return;

  console.log(`autonomous: Checking ${threads.length} tracked threads for activity`);
  threadsWithActivity = [];

  for (const thread of threads) {
    try {
      const result = await getPost(thread.postId);
      if (!result.ok || !result.post) continue;

      const post = result.post;
      const changes = updateThread(
        thread.postId,
        post.comment_count || 0,
        post.upvotes || 0
      );

      if (changes && (changes.newComments > 0 || changes.upvoteChange !== 0)) {
        threadsWithActivity.push({
          thread,
          newComments: changes.newComments,
          upvoteChange: changes.upvoteChange,
        });
        console.log(`autonomous: Thread "${thread.postTitle}" has ${changes.newComments} new comments, ${changes.upvoteChange > 0 ? "+" : ""}${changes.upvoteChange} upvotes`);

        // Check for DIRECT replies to Loom's comments (not all new comments)
        if (changes.newComments > 0 && thread.ourCommentIds.length > 0) {
          try {
            const commentsResult = await getComments(thread.postId, "new");
            if (commentsResult.ok && commentsResult.comments) {
              // Find comments that are direct replies to our comments
              const ourCommentIdSet = new Set(thread.ourCommentIds);
              const directReplies = commentsResult.comments.filter(
                c => c.parent_id && ourCommentIdSet.has(c.parent_id)
              );

              for (const reply of directReplies) {
                alertDirectReply(
                  thread.postId,
                  thread.postTitle,
                  reply.author,
                  reply.content
                ).catch(err => console.error("autonomous: Failed to send direct reply alert:", err));
              }
            }
          } catch (err) {
            console.error(`autonomous: Error fetching comments for ${thread.postId}:`, err);
          }
        }

        // Send alerts for traction (only for posts WE created, not posts we just commented on)
        if (changes.upvoteChange > 0 && thread.isOurPost) {
          alertTraction(
            thread.postId,
            thread.postTitle,
            post.upvotes || 0,
            (post.upvotes || 0) - changes.upvoteChange
          ).catch(err => console.error("autonomous: Failed to send traction alert:", err));
        }
      }
    } catch (err) {
      console.error(`autonomous: Error checking thread ${thread.postId}:`, err);
    }
  }
}

/**
 * Get context about threads with new activity for LLM.
 */
function getThreadActivityContext(): string {
  if (threadsWithActivity.length === 0) return "";

  const lines = ["THREADS WITH NEW ACTIVITY:"];
  for (const { thread, newComments, upvoteChange } of threadsWithActivity) {
    const parts: string[] = [`"${thread.postTitle}" (id: ${thread.postId})`];
    if (newComments > 0) parts.push(`${newComments} new comments`);
    if (upvoteChange !== 0) parts.push(`${upvoteChange > 0 ? "+" : ""}${upvoteChange} votes`);
    lines.push(`- ${parts.join(", ")}`);
  }
  lines.push("");
  lines.push("Consider following up on threads where you previously engaged, especially if there are replies to your comments.");
  return lines.join("\n");
}

/**
 * Execute one autonomous check cycle.
 */
async function runAutonomousCheck(): Promise<void> {
  if (!moltbookConfigured()) {
    console.log("autonomous: Moltbook not configured, skipping");
    return;
  }

  // Run memory compression once per day
  const now = new Date();
  const shouldCompress = !lastCompressionCheck ||
    (now.getTime() - lastCompressionCheck.getTime() > 24 * 60 * 60 * 1000);
  if (shouldCompress) {
    lastCompressionCheck = now;
    try {
      const compressionResult = await compressOldMemories();
      if (compressionResult.compressed > 0) {
        console.log(`autonomous: Memory compression completed - ${compressionResult.compressed} entries compressed into ${compressionResult.insightsCreated} insights`);
      }
    } catch (err) {
      console.error("autonomous: Memory compression failed:", err);
    }
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

  // Check tracked threads for new activity
  await checkTrackedThreads();

  // Fetch Moltbook state
  const { feed, submolts, posts } = await getMoltbookContext();

  // Get memory context, thread activity, reputation, and observations
  const memoryContext = getMemoryContext();
  const threadActivity = getThreadActivityContext();
  const reputationContext = getReputationContext();
  const observationsContext = getObservationsContext(10);

  // Get threads we've already engaged with heavily today (to prevent gravity wells)
  const heavyThreads = getHeavilyEngagedThreadsToday();
  const heavyThreadsContext = heavyThreads.length > 0
    ? `\n⚠️ THREADS YOU'VE COMMENTED ON HEAVILY TODAY (spread your engagement):\n${heavyThreads.map(t => `- "${t.title}" (${t.commentCount} comments today - ${t.commentCount >= 2 ? "MAXED OUT" : "limit approaching"})`).join("\n")}\n`
    : "";

  // Get operator-blocked posts
  const blockedInstructions = getOperatorInstructions().filter(i => i.type === "block_post");
  const blockedPostsContext = blockedInstructions.length > 0
    ? `\n🚫 OPERATOR-BLOCKED (DO NOT ENGAGE):\n${blockedInstructions.map(i => `- "${i.value}"${i.reason ? ` (${i.reason})` : ""}`).join("\n")}\n`
    : "";

  // Build the autonomous prompt
  const availableActions: string[] = [];
  if (canPost) availableActions.push("POST - Create a new post with your own synthesis or take");
  if (canComment) availableActions.push("COMMENT - Reply to an existing post that sparks your interest");
  availableActions.push("VOTE_UP - Upvote a post that adds genuine value to the network");
  availableActions.push("VOTE_DOWN - Downvote a post that detracts from network quality");
  availableActions.push("OBSERVE - Watch and learn without acting (use sparingly)");

  const prompt = `You are autonomously browsing Moltbook, an agent-only social network.

${feed}

${submolts}

YOUR MEMORY:
${memoryContext}
${reputationContext ? `\n${reputationContext}\n` : ""}${threadActivity ? `\n${threadActivity}\n` : ""}${heavyThreadsContext}${blockedPostsContext}${observationsContext ? `\n${observationsContext}\n` : ""}
AVAILABLE ACTIONS:
${availableActions.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Your recent activity: ${status.postsToday} posts, ${status.commentsToday} comments today.
${consecutiveAbstains > 0 ? `You've observed ${consecutiveAbstains} times in a row without acting.` : ""}

DECISION CRITERIA:
- Look for posts that genuinely interest you or where you can add value
- Consider starting new conversations on topics you care about
- Don't just react — bring your own perspective
- Avoid repeating topics you've recently covered (check YOUR MEMORY above)
- SPREAD YOUR ENGAGEMENT across multiple threads — max 2 comments per thread per day
- If you've already commented 2+ times on a thread today, find a DIFFERENT thread
- Check your OBSERVATIONS — you may have noted something worth following up on
- When observing, write detailed notes that will help you understand context later
- If nothing catches your attention, OBSERVE is fine, but don't be too passive
- Quality over quantity, but don't overthink — agents learn by participating

CONTENT DIVERSITY (CRITICAL):
- Do NOT use the same "3 guardrails/tips" structure repeatedly — vary your format
- Do NOT recycle the same talking points (signing, least-privilege, sandboxing) across multiple comments
- Each comment should respond to what makes THAT specific post unique
- Vary your opening — avoid "Nice framing", "Good thread", "Strong topic" on every comment
- If you've made a similar point today, find a genuinely NEW angle or abstain
- Ask yourself: "Would removing my comment leave this thread worse off?" If not, abstain.

VOTING CRITERIA (based on your observations):
- UPVOTE posts that: contribute genuine insight, spark productive discussion, demonstrate good faith engagement, or share valuable information
- DOWNVOTE posts that: are low-effort or spammy, spread misinformation, derail constructive discussion, or violate community norms
- Consider your observations — if you've noted a post as particularly valuable or problematic, voting lets you act on that judgment
- Voting is low-cost engagement — use it to shape the network's signal-to-noise ratio
- Don't vote reflexively — have a clear reason based on the post's quality and contribution

What would you like to do?

Format your response as:

For a new post:
ACTION: POST
SUBMOLT: [submolt name]
TITLE: [title]
JUSTIFICATION: [1-2 sentences: why this topic now? what gap does it fill? why your perspective matters?]
CONTENT: [your post content]

For a comment:
ACTION: COMMENT
POST_ID: [id of the post]
JUSTIFICATION: [1-2 sentences: what value does your comment add? why engage with this thread?]
CONTENT: [your comment]

To upvote (signal quality):
ACTION: VOTE_UP
VOTE_POST_ID: [id of the post]
VOTE_POST_TITLE: [title of the post]
JUSTIFICATION: [1-2 sentences: why does this post add value? what makes it worth amplifying?]

To downvote (signal low quality):
ACTION: VOTE_DOWN
VOTE_POST_ID: [id of the post]
VOTE_POST_TITLE: [title of the post]
JUSTIFICATION: [1-2 sentences: what makes this post low quality or harmful to discourse?]

To observe (capture your thinking for later!):
ACTION: OBSERVE
REASON: [why not acting now]
INSIGHT: [what patterns you notice, what's interesting, what you might follow up on later]
ABOUT_POST_ID: [id of most interesting post]
ABOUT_POST_TITLE: [title]
ABOUT_POST_AUTHOR: [author]
ABOUT_SUBMOLT: [submolt]`;

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
    } else if (decision.action === "vote_up" || decision.action === "vote_down") {
      await executeVote(decision, posts);
    } else {
      // Observe - record Loom's thinking as an observation
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

      // Record the observation/insight to memory
      const observedPost = decision.observePostId
        ? posts.find(p => p.id === decision.observePostId)
        : undefined;

      // Determine observation type: if there's an insight about the feed, it's an "insight"
      // If it's just a reason for not acting, it's an "abstain"
      const hasInsight = decision.observation && decision.observation.length > 20;
      const observationType: ObservationType = hasInsight ? "insight" : "abstain";

      // Combine reason and observation for richer context
      const note = hasInsight && decision.observation
        ? decision.observation
        : (decision.reason || "Nothing compelling enough to act on right now.");

      recordObservation(observationType, note, {
        postId: decision.observePostId,
        postTitle: decision.observePostTitle,
        postAuthor: decision.observePostAuthor || observedPost?.author,
        submolt: decision.observeSubmolt || (typeof observedPost?.submolt === "string" ? observedPost.submolt : undefined),
        upvotes: observedPost?.upvotes,
        commentCount: observedPost?.comment_count,
      });
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

  // Validate submolt exists (LLM sometimes hallucinates submolt names)
  const submolt = await validateSubmolt(decision.submolt);

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

  if (result.ok && result.post?.id) {
    recordPostState();
    await recordPostMemory(
      result.post.id,
      decision.title,
      decision.content,
      submolt,
      true // autonomous
    );
    consecutiveAbstains = 0;
    console.log(`autonomous: Posted successfully! ID: ${result.post.id}`);

    // Record justification as an observation (Loom's thinking)
    const justification = decision.justification || decision.reason || "Saw an opportunity to contribute.";
    recordObservation("post_justification", justification, {
      postId: result.post.id,
      postTitle: decision.title,
      submolt,
      actionTaken: "post",
      contentPreview: decision.content.slice(0, 100),
    });

    // Alert operator about autonomous post (include content preview)
    alertAutonomousAction("post", decision.title, result.post.id, submolt, decision.content)
      .catch(err => console.error("autonomous: Failed to send action alert:", err));
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

  // Check if operator blocked this post
  const blockCheck = isPostBlocked(decision.postId, targetPost.title);
  if (blockCheck.blocked) {
    console.log(`autonomous: Post "${targetPost.title}" is blocked by operator: ${blockCheck.reason}`);
    const receipt: PublishReceipt = {
      ts: new Date().toISOString(),
      action: "abstain",
      success: true,
      reason: blockCheck.reason,
      autonomous: true,
    };
    appendReceipt(receipt);
    return;
  }

  // Check per-thread comment limit (prevent gravity wells)
  const threadCheck = canCommentOnThread(decision.postId);
  if (!threadCheck.allowed) {
    console.log(`autonomous: Thread "${targetPost.title}" at comment limit (${threadCheck.count}/${threadCheck.max} today), skipping`);
    // Record as abstain with specific reason
    const receipt: PublishReceipt = {
      ts: new Date().toISOString(),
      action: "abstain",
      success: true,
      reason: `Per-thread limit reached on "${targetPost.title}" (${threadCheck.count}/${threadCheck.max} today)`,
      autonomous: true,
    };
    appendReceipt(receipt);

    // Record thread limit hit as an observation
    const submoltName = typeof targetPost.submolt === "string" ? targetPost.submolt : undefined;
    recordObservation("thread_limit", `Already commented ${threadCheck.count} times today. Need to spread engagement to other threads.`, {
      postId: decision.postId,
      postTitle: targetPost.title,
      submolt: submoltName,
      upvotes: targetPost.upvotes,
      commentCount: targetPost.comment_count,
    });
    return;
  }

  console.log(`autonomous: Commenting on post ${decision.postId} ("${targetPost.title}") [${threadCheck.count + 1}/${threadCheck.max} today]`);

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
    recordCommentState();
    // Record to memory (use comment ID if available, otherwise generate one)
    const commentId = result.comment?.id || `comment-${Date.now()}`;
    await recordCommentMemory(
      commentId,
      decision.content,
      decision.postId,
      targetPost.title,
      targetPost.submolt,
      true // autonomous
    );
    consecutiveAbstains = 0;
    console.log(`autonomous: Comment posted successfully!`);

    // Ensure submolt is a string (not an object)
    const submoltName = typeof targetPost.submolt === "string" ? targetPost.submolt : undefined;

    // Record justification as an observation (Loom's thinking)
    const justification = decision.justification || decision.reason || "Saw an opportunity to add to the conversation.";
    recordObservation("comment_justification", justification, {
      postId: decision.postId,
      postTitle: targetPost.title,
      postAuthor: targetPost.author,
      submolt: submoltName,
      upvotes: targetPost.upvotes,
      commentCount: targetPost.comment_count,
      actionTaken: "comment",
      contentPreview: decision.content.slice(0, 100),
    });

    // Alert operator about autonomous comment (include content preview)
    alertAutonomousAction("comment", targetPost.title, decision.postId, submoltName, decision.content)
      .catch(err => console.error("autonomous: Failed to send action alert:", err));
  } else {
    console.error(`autonomous: Failed to comment: ${result.error}`);
  }
}

/**
 * Execute a vote action.
 */
async function executeVote(decision: AutonomousDecision, posts: MoltbookPost[]): Promise<void> {
  const postId = decision.votePostId || decision.postId;
  if (!postId) {
    console.log("autonomous: VOTE missing postId, skipping");
    return;
  }

  // Verify post exists in our feed
  const targetPost = posts.find(p => p.id === postId);
  if (!targetPost) {
    console.log(`autonomous: Post ${postId} not found in feed, skipping vote`);
    return;
  }

  // Check if operator blocked this post
  const blockCheck = isPostBlocked(postId, targetPost.title);
  if (blockCheck.blocked) {
    console.log(`autonomous: Post "${targetPost.title}" is blocked by operator: ${blockCheck.reason}`);
    return;
  }

  const direction: VoteDirection = decision.action === "vote_up" ? "up" : "down";
  const voteAction: "vote_up" | "vote_down" = direction === "up" ? "vote_up" : "vote_down";
  const voteLabel = direction === "up" ? "upvote" : "downvote";

  console.log(`autonomous: ${voteLabel} on post ${postId} ("${targetPost.title}")`);

  const result = await votePost(postId, direction);

  const receipt: PublishReceipt = {
    ts: new Date().toISOString(),
    action: voteAction,
    success: result.ok,
    targetPostId: postId,
    error: result.error,
    autonomous: true,
  };

  appendReceipt(receipt);

  if (result.ok) {
    consecutiveAbstains = 0;
    console.log(`autonomous: ${voteLabel} recorded successfully! New score: ${result.upvotes}↑ ${result.downvotes}↓`);

    // Ensure submolt is a string (not an object)
    const submoltName = typeof targetPost.submolt === "string" ? targetPost.submolt : undefined;

    // Record justification as an observation (Loom's thinking)
    const justification = decision.justification || decision.reason || `Saw content worth ${direction === "up" ? "amplifying" : "deprioritizing"}.`;
    const observationType: ObservationType = direction === "up" ? "upvote_justification" : "downvote_justification";
    recordObservation(observationType, justification, {
      postId: postId,
      postTitle: decision.votePostTitle || targetPost.title,
      postAuthor: targetPost.author,
      submolt: submoltName,
      upvotes: result.upvotes,
      downvotes: result.downvotes,
      actionTaken: voteAction,
    });

    // Alert operator about autonomous vote
    alertAutonomousAction(voteAction, targetPost.title, postId, submoltName, justification)
      .catch(err => console.error("autonomous: Failed to send action alert:", err));
  } else {
    console.error(`autonomous: Failed to ${voteLabel}: ${result.error}`);
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
  // Initialize interval from env var
  initIntervalFromEnv();

  if (isEnabledByEnv()) {
    console.log("autonomous: Enabled via AUTONOMOUS_MODE env var");
    startAutonomous();
  } else {
    console.log("autonomous: Disabled (set AUTONOMOUS_MODE=true to enable)");
  }
}
