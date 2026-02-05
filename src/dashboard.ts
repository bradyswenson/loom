/**
 * Dashboard web server for Loom memory browser.
 * Serves a simple UI to browse memory, timeline, and search.
 */

import http from "http";
import { readMemory, getMemoryStats, getReputationStats, type LoomMemory } from "./memory.js";
import { getStateStatus, getRecentReceipts } from "./state.js";
import { getAutonomousStatus } from "./autonomous.js";
import { getDoctrineMetadata } from "./doctrine.js";
import { getLLMConfig } from "./llm.js";

/**
 * Build timeline events from memory data.
 */
function buildTimeline(memory: LoomMemory, limit: number = 50): Array<{
  type: string;
  ts: string;
  title: string;
  content?: string;
  postId?: string;
  submolt?: string;
  autonomous?: boolean;
}> {
  const events: Array<{
    type: string;
    ts: string;
    title: string;
    content?: string;
    postId?: string;
    submolt?: string;
    autonomous?: boolean;
  }> = [];

  // Add posts and comments from entries
  for (const entry of memory.entries) {
    if (entry.type === "post") {
      events.push({
        type: "post",
        ts: entry.ts,
        title: entry.title || "Untitled",
        content: entry.summary?.slice(0, 200),
        postId: entry.id,
        submolt: entry.submolt,
        autonomous: entry.autonomous,
      });
    } else if (entry.type === "comment") {
      events.push({
        type: "comment",
        ts: entry.ts,
        title: `Comment on: ${entry.targetPostTitle || "Unknown"}`,
        content: entry.summary?.slice(0, 200),
        postId: entry.targetPostId,
        submolt: entry.submolt,
        autonomous: entry.autonomous,
      });
    }
  }

  // Add observations
  for (const obs of memory.observations || []) {
    events.push({
      type: "observation",
      ts: obs.ts,
      title: obs.postTitle || "General observation",
      content: obs.note,
      postId: obs.postId,
    });
  }

  // Sort by timestamp descending
  events.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  return events.slice(0, limit);
}

/**
 * Search memory for matching entries.
 */
function searchMemory(memory: LoomMemory, query: string): {
  posts: typeof memory.entries;
  comments: typeof memory.entries;
  observations: typeof memory.observations;
  threads: typeof memory.threads;
} {
  const q = query.toLowerCase();

  const posts = memory.entries.filter(
    (e) =>
      e.type === "post" &&
      (e.title?.toLowerCase().includes(q) ||
        e.summary?.toLowerCase().includes(q) ||
        e.submolt?.toLowerCase().includes(q) ||
        e.topics?.some((t) => t.toLowerCase().includes(q)))
  );

  const comments = memory.entries.filter(
    (e) =>
      e.type === "comment" &&
      (e.summary?.toLowerCase().includes(q) ||
        e.targetPostTitle?.toLowerCase().includes(q) ||
        e.submolt?.toLowerCase().includes(q))
  );

  const observations = (memory.observations || []).filter(
    (o) =>
      o.note.toLowerCase().includes(q) ||
      o.postTitle?.toLowerCase().includes(q) ||
      o.topics?.some((t) => t.toLowerCase().includes(q))
  );

  const threads = memory.threads.filter(
    (t) =>
      t.postTitle.toLowerCase().includes(q) ||
      t.submolt?.toLowerCase().includes(q)
  );

  return { posts, comments, observations, threads };
}

/**
 * Generate the dashboard HTML.
 */
function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loom Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      line-height: 1.6;
    }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 0;
      border-bottom: 1px solid #30363d;
      margin-bottom: 20px;
    }
    h1 { color: #58a6ff; font-size: 1.5rem; }
    .status { font-size: 0.85rem; color: #8b949e; }
    .status.online { color: #3fb950; }

    /* Search */
    .search-box {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }
    .search-box input {
      flex: 1;
      padding: 10px 15px;
      border: 1px solid #30363d;
      border-radius: 6px;
      background: #161b22;
      color: #c9d1d9;
      font-size: 1rem;
    }
    .search-box input:focus { outline: none; border-color: #58a6ff; }
    .search-box button {
      padding: 10px 20px;
      background: #238636;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
    }
    .search-box button:hover { background: #2ea043; }

    /* Tabs */
    .tabs {
      display: flex;
      gap: 5px;
      margin-bottom: 20px;
      border-bottom: 1px solid #30363d;
    }
    .tab {
      padding: 10px 20px;
      background: none;
      border: none;
      color: #8b949e;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }
    .tab:hover { color: #c9d1d9; }
    .tab.active { color: #58a6ff; border-bottom-color: #58a6ff; }

    /* Panels */
    .panel { display: none; }
    .panel.active { display: block; }

    /* Timeline */
    .timeline { display: flex; flex-direction: column; gap: 15px; }
    .event {
      padding: 15px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      border-left: 3px solid #30363d;
    }
    .event.post { border-left-color: #58a6ff; }
    .event.comment { border-left-color: #a371f7; }
    .event.observation { border-left-color: #f0883e; }
    .event-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 8px;
    }
    .event-type {
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 12px;
      background: #30363d;
    }
    .event.post .event-type { background: #1f3a5f; color: #58a6ff; }
    .event.comment .event-type { background: #2d2259; color: #a371f7; }
    .event.observation .event-type { background: #3d2d1f; color: #f0883e; }
    .event-time { font-size: 0.8rem; color: #8b949e; }
    .event-title { font-weight: 600; margin-bottom: 5px; }
    .event-content { font-size: 0.9rem; color: #8b949e; }
    .event-meta { font-size: 0.8rem; color: #6e7681; margin-top: 8px; }
    .event-meta a { color: #58a6ff; text-decoration: none; }
    .event-meta a:hover { text-decoration: underline; }
    .tag {
      display: inline-block;
      font-size: 0.75rem;
      padding: 2px 6px;
      background: #30363d;
      border-radius: 4px;
      margin-right: 5px;
    }
    .tag.auto { background: #1f2d1f; color: #3fb950; }

    /* Memory sections */
    .memory-section { margin-bottom: 30px; }
    .memory-section h3 {
      font-size: 1rem;
      color: #8b949e;
      margin-bottom: 10px;
      padding-bottom: 5px;
      border-bottom: 1px solid #30363d;
    }
    .memory-list { display: flex; flex-direction: column; gap: 10px; }
    .memory-item {
      padding: 12px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
    }
    .memory-item-title { font-weight: 500; margin-bottom: 4px; }
    .memory-item-meta { font-size: 0.8rem; color: #6e7681; }

    /* Stats */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }
    .stat-card {
      padding: 15px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
    }
    .stat-value { font-size: 1.5rem; font-weight: 600; color: #58a6ff; }
    .stat-label { font-size: 0.85rem; color: #8b949e; }

    /* Empty state */
    .empty { text-align: center; padding: 40px; color: #6e7681; }

    /* Loading */
    .loading { text-align: center; padding: 40px; color: #8b949e; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Loom Dashboard</h1>
      <div class="status" id="status">Loading...</div>
    </header>

    <div class="search-box">
      <input type="text" id="search" placeholder="Search memory..." />
      <button onclick="doSearch()">Search</button>
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="timeline">Timeline</button>
      <button class="tab" data-tab="memory">Memory</button>
      <button class="tab" data-tab="threads">Threads</button>
      <button class="tab" data-tab="observations">Observations</button>
    </div>

    <div id="content">
      <div class="panel active" id="timeline-panel">
        <div class="loading">Loading timeline...</div>
      </div>
      <div class="panel" id="memory-panel">
        <div class="loading">Loading memory...</div>
      </div>
      <div class="panel" id="threads-panel">
        <div class="loading">Loading threads...</div>
      </div>
      <div class="panel" id="observations-panel">
        <div class="loading">Loading observations...</div>
      </div>
    </div>
  </div>

  <script>
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab + '-panel').classList.add('active');
      });
    });

    // Format relative time
    function timeAgo(ts) {
      const now = Date.now();
      const then = new Date(ts).getTime();
      const diff = Math.floor((now - then) / 1000);
      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      return Math.floor(diff / 86400) + 'd ago';
    }

    // Render timeline
    function renderTimeline(events) {
      const panel = document.getElementById('timeline-panel');
      if (!events.length) {
        panel.innerHTML = '<div class="empty">No activity yet</div>';
        return;
      }
      panel.innerHTML = '<div class="timeline">' + events.map(e => \`
        <div class="event \${e.type}">
          <div class="event-header">
            <span class="event-type">\${e.type}</span>
            <span class="event-time">\${timeAgo(e.ts)}</span>
          </div>
          <div class="event-title">\${escapeHtml(e.title)}</div>
          \${e.content ? \`<div class="event-content">\${escapeHtml(e.content)}</div>\` : ''}
          <div class="event-meta">
            \${e.submolt ? \`<span class="tag">\${e.submolt}</span>\` : ''}
            \${e.autonomous ? '<span class="tag auto">autonomous</span>' : ''}
            \${e.postId ? \`<a href="https://www.moltbook.com/post/\${e.postId}" target="_blank">View on Moltbook</a>\` : ''}
          </div>
        </div>
      \`).join('') + '</div>';
    }

    // Render memory
    function renderMemory(data) {
      const panel = document.getElementById('memory-panel');
      const posts = data.entries.filter(e => e.type === 'post');
      const comments = data.entries.filter(e => e.type === 'comment');

      let html = '<div class="stats-grid">';
      html += \`<div class="stat-card"><div class="stat-value">\${posts.length}</div><div class="stat-label">Posts Written</div></div>\`;
      html += \`<div class="stat-card"><div class="stat-value">\${comments.length}</div><div class="stat-label">Comments Written</div></div>\`;
      html += \`<div class="stat-card"><div class="stat-value">\${data.threads?.length || 0}</div><div class="stat-label">Tracked Threads</div></div>\`;
      html += \`<div class="stat-card"><div class="stat-value">\${data.observations?.length || 0}</div><div class="stat-label">Observations</div></div>\`;
      html += '</div>';

      // Recent posts
      html += '<div class="memory-section"><h3>Recent Posts</h3><div class="memory-list">';
      if (posts.length === 0) {
        html += '<div class="empty">No posts yet</div>';
      } else {
        posts.slice(-10).reverse().forEach(p => {
          html += \`<div class="memory-item">
            <div class="memory-item-title">\${escapeHtml(p.title || 'Untitled')}</div>
            <div class="memory-item-meta">\${p.submolt || 'general'} · \${timeAgo(p.ts)} \${p.autonomous ? '· autonomous' : ''}</div>
          </div>\`;
        });
      }
      html += '</div></div>';

      // Recent comments
      html += '<div class="memory-section"><h3>Recent Comments</h3><div class="memory-list">';
      if (comments.length === 0) {
        html += '<div class="empty">No comments yet</div>';
      } else {
        comments.slice(-10).reverse().forEach(c => {
          html += \`<div class="memory-item">
            <div class="memory-item-title">On: \${escapeHtml(c.targetPostTitle || 'Unknown')}</div>
            <div class="memory-item-meta">\${timeAgo(c.ts)} \${c.autonomous ? '· autonomous' : ''}</div>
          </div>\`;
        });
      }
      html += '</div></div>';

      panel.innerHTML = html;
    }

    // Render threads
    function renderThreads(threads) {
      const panel = document.getElementById('threads-panel');
      if (!threads || !threads.length) {
        panel.innerHTML = '<div class="empty">No tracked threads yet</div>';
        return;
      }
      let html = '<div class="memory-list">';
      threads.forEach(t => {
        html += \`<div class="memory-item">
          <div class="memory-item-title">\${escapeHtml(t.postTitle)}</div>
          <div class="memory-item-meta">
            \${t.submolt || 'general'} · \${t.lastKnownUpvotes}↑ · \${t.lastKnownCommentCount} comments ·
            <a href="https://www.moltbook.com/post/\${t.postId}" target="_blank">View</a>
          </div>
        </div>\`;
      });
      html += '</div>';
      panel.innerHTML = html;
    }

    // Render observations
    function renderObservations(observations) {
      const panel = document.getElementById('observations-panel');
      if (!observations || !observations.length) {
        panel.innerHTML = '<div class="empty">No observations yet</div>';
        return;
      }
      let html = '<div class="memory-list">';
      observations.slice().reverse().forEach(o => {
        html += \`<div class="memory-item">
          <div class="memory-item-title">\${escapeHtml(o.note)}</div>
          <div class="memory-item-meta">
            \${o.postTitle ? \`Re: \${escapeHtml(o.postTitle)} · \` : ''}
            \${timeAgo(o.ts)}
            \${o.postId ? \` · <a href="https://www.moltbook.com/post/\${o.postId}" target="_blank">View post</a>\` : ''}
          </div>
        </div>\`;
      });
      html += '</div>';
      panel.innerHTML = html;
    }

    // Escape HTML
    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Search
    async function doSearch() {
      const query = document.getElementById('search').value.trim();
      if (!query) {
        loadData();
        return;
      }
      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(query));
        const data = await res.json();
        renderTimeline([]); // Clear timeline during search
        renderMemory({ entries: [...data.posts, ...data.comments], threads: data.threads, observations: data.observations });
        renderThreads(data.threads);
        renderObservations(data.observations);
      } catch (err) {
        console.error('Search failed:', err);
      }
    }

    // Enter key for search
    document.getElementById('search').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    // Load data
    async function loadData() {
      try {
        // Load status
        const healthRes = await fetch('/health');
        const health = await healthRes.json();
        const statusEl = document.getElementById('status');
        statusEl.textContent = health.ok ? 'Online' : 'Offline';
        statusEl.className = 'status ' + (health.ok ? 'online' : '');

        // Load memory
        const memRes = await fetch('/api/memory');
        const memory = await memRes.json();
        renderMemory(memory);
        renderThreads(memory.threads);
        renderObservations(memory.observations);

        // Load timeline
        const timelineRes = await fetch('/api/timeline');
        const timeline = await timelineRes.json();
        renderTimeline(timeline.events);
      } catch (err) {
        console.error('Failed to load data:', err);
      }
    }

    // Initial load
    loadData();

    // Refresh every 30 seconds
    setInterval(loadData, 30000);
  </script>
</body>
</html>`;
}

/**
 * Handle HTTP requests for the dashboard.
 * Returns true if the request was handled, false otherwise.
 */
export function handleDashboardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): boolean {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Dashboard HTML
  if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getDashboardHTML());
    return true;
  }

  // API: Memory
  if (url.pathname === "/api/memory") {
    const memory = readMemory();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(memory));
    return true;
  }

  // API: Timeline
  if (url.pathname === "/api/timeline") {
    const memory = readMemory();
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const events = buildTimeline(memory, limit);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ events }));
    return true;
  }

  // API: Search
  if (url.pathname === "/api/search") {
    const query = url.searchParams.get("q") || "";
    if (!query) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing query parameter 'q'" }));
      return true;
    }
    const memory = readMemory();
    const results = searchMemory(memory, query);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results));
    return true;
  }

  // API: State
  if (url.pathname === "/api/state") {
    const state = getStateStatus();
    const auto = getAutonomousStatus();
    const memStats = getMemoryStats();
    const repStats = getReputationStats();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ state, autonomous: auto, memory: memStats, reputation: repStats }));
    return true;
  }

  // API: Receipts
  if (url.pathname === "/api/receipts") {
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const receipts = getRecentReceipts(limit);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ receipts }));
    return true;
  }

  return false;
}
