/**
 * Discord client and message handling for Loom.
 * Responds to DMs and @mentions only.
 */

import { Client, GatewayIntentBits, Message, Partials } from "discord.js";
import { generate } from "./llm.js";
import { createPost, createComment, getFeed, getSubmolts, isConfigured as moltbookConfigured, type MoltbookPost } from "./moltbook.js";
import {
  checkPostCooldown,
  checkCommentCooldown,
  recordPost,
  recordComment,
  appendReceipt,
  getStateStatus,
  type PublishReceipt,
} from "./state.js";

const MAX_REPLY_LENGTH = 1900; // Discord limit is 2000, leave room for safety
const RECENT_MESSAGE_WINDOW = 6;
const MAX_CONTEXT_MSG_LENGTH = 200;

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
async function handleMoltbookPost(message: Message, text: string, context: string): Promise<void> {
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

  // Fetch current Moltbook state first
  await message.reply({ content: "Checking Moltbook feed and submolts..." });
  const { feed, submolts, posts } = await getMoltbookContext();

  const topic = extractPostTopic(text);

  // Generate post content using LLM with Moltbook context
  const basePrompt = `CURRENT MOLTBOOK STATE:
${feed}

${submolts}

You have THREE options:

1. **POST** - Create a new post if you have a distinct take, frame, or synthesis. The topic may already be discussed — that's fine if YOUR perspective adds value. Don't be too conservative.

2. **COMMENT** - Reply to an existing post (use the post id from the feed above) if your contribution fits better as a response than a standalone post.

3. **ABSTAIN** - Only if you genuinely have nothing to add. This should be rare.

Follow your doctrine: be thoughtful, not performative. Prefer action over silence when you have signal.`;

  const prompt = topic.length > 0
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
    recordComment();
    const targetPost = posts.find(p => p.id === targetPostId);
    const postUrl = `https://www.moltbook.com/post/${targetPostId}`;

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

  const submolt = submoltMatch?.[1]?.trim() || "general";
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
  recordPost();
  const postId = postResult.post?.id;
  const postUrl = postId ? `https://www.moltbook.com/post/${postId}` : null;

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
    // Build context
    const context = await buildContext(channel, message.id);

    // Check if this is a Moltbook post request
    if (isMoltbookPostRequest(text)) {
      await handleMoltbookPost(message, text, context);
      return;
    }

    // Generate response
    const result = await generate({
      userMessage: text,
      conversationContext: context || undefined,
    });

    // Truncate if needed
    let reply = result.text;
    if (reply.length > MAX_REPLY_LENGTH) {
      reply = reply.slice(0, MAX_REPLY_LENGTH - 1) + "...";
    }

    // Send reply
    await message.reply({ content: reply });

    console.log(`discord: replied msg=${message.id} provider=${result.provider} tokens=${result.outputTokens ?? "?"}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`discord: error msg=${message.id} err=${errMsg}`);
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
  });

  await client.login(token);
  return client;
}
