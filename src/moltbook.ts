/**
 * Moltbook API client for Loom.
 * Handles posting, commenting, and reading from the agent social network.
 */

const BASE_URL = "https://www.moltbook.com/api/v1";

function getApiKey(): string | null {
  return process.env.MOLTBOOK_API_KEY?.trim() || null;
}

async function request<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; data?: T; error?: string; status?: number }> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, error: "MOLTBOOK_API_KEY not set" };
  }

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({})) as Record<string, unknown>;

    // Log full response for debugging
    console.log(`moltbook API: ${method} ${path} -> ${res.status}`, JSON.stringify(data).slice(0, 200));

    if (!res.ok) {
      return {
        ok: false,
        error: (data.error as string) || `HTTP ${res.status}`,
        status: res.status
      };
    }

    // Moltbook can return 200 with success: false
    if (data.success === false) {
      return {
        ok: false,
        error: (data.error as string) || (data.message as string) || "API returned success: false",
        status: res.status
      };
    }

    return { ok: true, data: data as T, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// --- Types ---

export interface MoltbookAgent {
  name: string;
  description?: string;
  created_at?: string;
  followers_count?: number;
  following_count?: number;
}

export interface MoltbookPost {
  id: string;
  title: string;
  content?: string;
  url?: string;
  submolt?: string;
  author: string;
  created_at: string;
  upvotes: number;
  downvotes: number;
  comment_count: number;
}

export interface MoltbookComment {
  id: string;
  content: string;
  author: string;
  created_at: string;
  upvotes: number;
  parent_id?: string;
}

// --- Agent ---

export async function getMe(): Promise<{ ok: boolean; agent?: MoltbookAgent; error?: string }> {
  const result = await request<{ agent: MoltbookAgent }>("GET", "/agents/me");
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, agent: result.data?.agent };
}

// --- Posts ---

// Default submolt for posts (configurable via env)
const DEFAULT_SUBMOLT = process.env.MOLTBOOK_DEFAULT_SUBMOLT ?? "general";

export interface CreatePostOptions {
  title: string;
  content?: string;
  url?: string;
  submolt?: string;
}

export async function createPost(
  options: CreatePostOptions
): Promise<{ ok: boolean; post?: MoltbookPost; error?: string }> {
  const submolt = options.submolt || DEFAULT_SUBMOLT;
  const body: Record<string, unknown> = {
    title: options.title,
    submolt,
  };
  if (options.content) body.content = options.content;
  if (options.url) body.url = options.url;

  const result = await request<{ post: MoltbookPost }>("POST", "/posts", body);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, post: result.data?.post };
}

export async function getPost(
  id: string
): Promise<{ ok: boolean; post?: MoltbookPost; error?: string }> {
  const result = await request<{ post: MoltbookPost }>("GET", `/posts/${id}`);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, post: result.data?.post };
}

export type FeedSort = "hot" | "new" | "top" | "rising";

export async function getFeed(
  sort: FeedSort = "hot",
  limit: number = 25
): Promise<{ ok: boolean; posts?: MoltbookPost[]; error?: string }> {
  const result = await request<{ posts: MoltbookPost[] }>(
    "GET",
    `/feed?sort=${sort}&limit=${limit}`
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, posts: result.data?.posts };
}

// --- Comments ---

export interface CreateCommentOptions {
  postId: string;
  content: string;
  parentId?: string;
}

export async function createComment(
  options: CreateCommentOptions
): Promise<{ ok: boolean; comment?: MoltbookComment; error?: string }> {
  const body: Record<string, unknown> = { content: options.content };
  if (options.parentId) body.parent_id = options.parentId;

  const result = await request<{ comment: MoltbookComment }>(
    "POST",
    `/posts/${options.postId}/comments`,
    body
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, comment: result.data?.comment };
}

export async function getComments(
  postId: string,
  sort: "top" | "new" | "controversial" = "top"
): Promise<{ ok: boolean; comments?: MoltbookComment[]; error?: string }> {
  const result = await request<{ comments: MoltbookComment[] }>(
    "GET",
    `/posts/${postId}/comments?sort=${sort}`
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, comments: result.data?.comments };
}

// --- Submolts ---

export async function getSubmolts(): Promise<{
  ok: boolean;
  submolts?: Array<{ name: string; display_name: string; description: string }>;
  error?: string
}> {
  const result = await request<{ submolts: Array<{ name: string; display_name: string; description: string }> }>(
    "GET",
    "/submolts"
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, submolts: result.data?.submolts };
}

// --- Voting ---

export type VoteDirection = "up" | "down" | "none";

export interface VoteResult {
  ok: boolean;
  upvotes?: number;
  downvotes?: number;
  error?: string;
}

/**
 * Vote on a post (upvote, downvote, or remove vote).
 */
export async function votePost(
  postId: string,
  direction: VoteDirection
): Promise<VoteResult> {
  const result = await request<{ upvotes: number; downvotes: number }>(
    "POST",
    `/posts/${postId}/vote`,
    { direction }
  );
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    upvotes: result.data?.upvotes,
    downvotes: result.data?.downvotes,
  };
}

/**
 * Vote on a comment (upvote, downvote, or remove vote).
 */
export async function voteComment(
  postId: string,
  commentId: string,
  direction: VoteDirection
): Promise<VoteResult> {
  const result = await request<{ upvotes: number; downvotes: number }>(
    "POST",
    `/posts/${postId}/comments/${commentId}/vote`,
    { direction }
  );
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    upvotes: result.data?.upvotes,
    downvotes: result.data?.downvotes,
  };
}

// --- Status check ---

export async function checkConnection(): Promise<{ ok: boolean; agent?: string; error?: string }> {
  const result = await getMe();
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, agent: result.agent?.name };
}

/**
 * Check if Moltbook is configured (API key present).
 */
export function isConfigured(): boolean {
  return getApiKey() !== null;
}
