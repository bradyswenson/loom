/**
 * Dashboard web server for Loom memory browser.
 * Serves a simple UI to browse memory, timeline, and search.
 */

import http from "http";
import { readMemory, getMemoryStats, getReputationStats, getEnhancedMemoryStats, getActiveGoals, type LoomMemory, type Goal } from "./memory.js";
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
  entryId?: string;
  submolt?: string;
  autonomous?: boolean;
}> {
  const events: Array<{
    type: string;
    ts: string;
    title: string;
    content?: string;
    postId?: string;
    entryId?: string;
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
        entryId: entry.id,
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
        entryId: entry.id,
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

  const threads = (memory.threads || []).filter(
    (t) =>
      t.postTitle?.toLowerCase().includes(q) ||
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

    /* Clickable items */
    .memory-item.clickable, .event.clickable { cursor: pointer; transition: border-color 0.2s; }
    .memory-item.clickable:hover, .event.clickable:hover { border-color: #58a6ff; }

    /* Modal */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.8);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay.active { display: flex; }
    .modal {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      max-width: 800px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      padding: 25px;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 15px;
    }
    .modal-title { font-size: 1.2rem; font-weight: 600; color: #58a6ff; }
    .modal-close {
      background: none;
      border: none;
      color: #8b949e;
      font-size: 1.5rem;
      cursor: pointer;
    }
    .modal-close:hover { color: #c9d1d9; }
    .modal-meta { font-size: 0.85rem; color: #8b949e; margin-bottom: 15px; }
    .modal-content {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 15px;
      white-space: pre-wrap;
      font-family: monospace;
      font-size: 0.9rem;
      line-height: 1.5;
    }

    /* Analytics */
    .chart-container {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .chart-title { font-size: 1rem; font-weight: 600; margin-bottom: 15px; color: #c9d1d9; }
    .bar-chart { display: flex; align-items: flex-end; gap: 8px; height: 150px; }
    .bar-group { display: flex; flex-direction: column; align-items: center; flex: 1; }
    .bar {
      width: 100%;
      min-height: 4px;
      background: #58a6ff;
      border-radius: 4px 4px 0 0;
      transition: height 0.3s;
    }
    .bar.comments { background: #a371f7; }
    .bar.observations { background: #f0883e; }
    .bar-label { font-size: 0.7rem; color: #6e7681; margin-top: 5px; }
    .pie-chart { display: flex; gap: 20px; align-items: center; }
    .pie-visual { width: 100px; height: 100px; border-radius: 50%; }
    .pie-legend { font-size: 0.85rem; }
    .pie-legend-item { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
    .pie-legend-color { width: 12px; height: 12px; border-radius: 2px; }
    .ranking-list { display: flex; flex-direction: column; gap: 8px; }
    .ranking-item {
      display: flex;
      justify-content: space-between;
      padding: 8px 12px;
      background: #0d1117;
      border-radius: 4px;
    }
    .ranking-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ranking-value { color: #58a6ff; font-weight: 500; margin-left: 10px; }

    /* Decisions/Receipts */
    .decision-item {
      padding: 12px 15px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      border-left: 3px solid #30363d;
      margin-bottom: 10px;
    }
    .decision-item.post { border-left-color: #58a6ff; }
    .decision-item.comment { border-left-color: #a371f7; }
    .decision-item.abstain { border-left-color: #f0883e; }
    .decision-item.failed { border-left-color: #f85149; }
    .decision-item.vote_up { border-left-color: #3fb950; }
    .decision-item.vote_down { border-left-color: #da3633; }
    .decision-header { display: flex; justify-content: space-between; margin-bottom: 5px; }
    .decision-action {
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 12px;
      font-weight: 500;
    }
    .decision-item.post .decision-action { background: #1f3a5f; color: #58a6ff; }
    .decision-item.comment .decision-action { background: #2d2259; color: #a371f7; }
    .decision-item.abstain .decision-action { background: #3d2d1f; color: #f0883e; }
    .decision-item.failed .decision-action { background: #3d1f1f; color: #f85149; }
    .decision-item.vote_up .decision-action { background: #1f3d1f; color: #3fb950; }
    .decision-item.vote_down .decision-action { background: #3d1f1f; color: #da3633; }
    .decision-time { font-size: 0.8rem; color: #8b949e; }
    .decision-title { font-weight: 500; margin-bottom: 4px; }
    .decision-reason { font-size: 0.85rem; color: #8b949e; font-style: italic; }
    .decision-meta { font-size: 0.8rem; color: #6e7681; margin-top: 5px; }
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
      <button class="tab" data-tab="goals">Goals</button>
      <button class="tab" data-tab="decisions">Decisions</button>
      <button class="tab" data-tab="analytics">Analytics</button>
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
      <div class="panel" id="goals-panel">
        <div class="loading">Loading goals...</div>
      </div>
      <div class="panel" id="decisions-panel">
        <div class="loading">Loading decisions...</div>
      </div>
      <div class="panel" id="analytics-panel">
        <div class="loading">Loading analytics...</div>
      </div>
    </div>
  </div>

  <!-- Modal for full content view -->
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title" id="modal-title">Entry Details</div>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-meta" id="modal-meta"></div>
      <div class="modal-content" id="modal-content"></div>
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
    function renderTimeline(events, entries) {
      const panel = document.getElementById('timeline-panel');
      if (!events.length) {
        panel.innerHTML = '<div class="empty">No activity yet</div>';
        return;
      }
      // Build a map of entryId -> entry for clickable items
      const entryMap = {};
      if (entries) {
        for (const entry of entries) {
          entryMap[entry.id] = entry;
        }
      }

      panel.innerHTML = '<div class="timeline">' + events.map(e => {
        // For posts and comments, make them clickable to view full content (use entryId)
        const isClickable = (e.type === 'post' || e.type === 'comment') && e.entryId && entryMap[e.entryId];
        const clickAttr = isClickable ? \`onclick="showEntryDetail('\${e.entryId}')" class="event \${e.type} clickable"\` : \`class="event \${e.type}"\`;

        return \`
        <div \${clickAttr}>
          <div class="event-header">
            <span class="event-type">\${e.type}</span>
            <span class="event-time">\${timeAgo(e.ts)}</span>
          </div>
          <div class="event-title">\${escapeHtml(e.title)}</div>
          \${e.content ? \`<div class="event-content">\${escapeHtml(e.content)}...</div>\` : ''}
          <div class="event-meta">
            \${e.submolt ? \`<span class="tag">\${typeof e.submolt === 'string' ? e.submolt : ''}</span>\` : ''}
            \${e.autonomous ? '<span class="tag auto">autonomous</span>' : ''}
            \${e.postId ? \`<a href="https://www.moltbook.com/post/\${e.postId}" target="_blank" onclick="event.stopPropagation()">View on Moltbook</a>\` : ''}
          </div>
        </div>
      \`}).join('') + '</div>';
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
          html += \`<div class="memory-item clickable" onclick="showEntryDetail('\${p.id}')">
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
          html += \`<div class="memory-item clickable" onclick="showEntryDetail('\${c.id}')">
            <div class="memory-item-title">On: \${escapeHtml(c.targetPostTitle || 'Unknown')}</div>
            <div class="memory-item-meta">\${c.summary ? escapeHtml(c.summary.slice(0, 100)) + '...' : ''}</div>
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

    // Modal functions
    async function showEntryDetail(entryId) {
      try {
        const res = await fetch('/api/entry/' + encodeURIComponent(entryId));
        if (!res.ok) throw new Error('Entry not found');
        const entry = await res.json();

        document.getElementById('modal-title').textContent = entry.title || entry.targetPostTitle || 'Entry Details';
        document.getElementById('modal-meta').innerHTML =
          \`<strong>Type:</strong> \${entry.type} · <strong>Time:</strong> \${new Date(entry.ts).toLocaleString()} · \` +
          \`<strong>Submolt:</strong> \${entry.submolt || 'general'}\` +
          (entry.autonomous ? ' · <span class="tag auto">autonomous</span>' : '') +
          (entry.targetPostId ? \` · <a href="https://www.moltbook.com/post/\${entry.targetPostId}" target="_blank">View on Moltbook</a>\` : '') +
          (entry.id && entry.type === 'post' ? \` · <a href="https://www.moltbook.com/post/\${entry.id}" target="_blank">View on Moltbook</a>\` : '');

        // Show full content if available, otherwise summary
        const content = entry.content || entry.summary || 'No content available';
        document.getElementById('modal-content').textContent = content;

        document.getElementById('modal-overlay').classList.add('active');
      } catch (err) {
        console.error('Failed to load entry:', err);
        alert('Failed to load entry details');
      }
    }

    function closeModal() {
      document.getElementById('modal-overlay').classList.remove('active');
    }

    // Close modal on overlay click
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'modal-overlay') closeModal();
    });

    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    // Render goals
    async function renderGoals() {
      const panel = document.getElementById('goals-panel');
      try {
        const res = await fetch('/api/goals');
        if (!res.ok) throw new Error('Failed to fetch goals');
        const data = await res.json();

        if (!data.goals || data.goals.length === 0) {
          let html = '<div class="empty">No goals tracked yet</div>';
          // Show memory stats anyway
          if (data.stats) {
            html += '<div class="chart-container" style="margin-top: 20px;">';
            html += '<div class="chart-title">Memory System Stats</div>';
            html += '<div class="stats-grid">';
            html += \`<div class="stat-card"><div class="stat-value">\${data.stats.entries}</div><div class="stat-label">Memory Entries</div></div>\`;
            html += \`<div class="stat-card"><div class="stat-value">\${data.stats.compressedInsights}</div><div class="stat-label">Compressed Periods</div></div>\`;
            html += \`<div class="stat-card"><div class="stat-value">\${data.stats.embeddings}</div><div class="stat-label">Semantic Index</div></div>\`;
            html += \`<div class="stat-card"><div class="stat-value">\${data.stats.observations}</div><div class="stat-label">Observations</div></div>\`;
            html += '</div></div>';
          }
          panel.innerHTML = html;
          return;
        }

        let html = '';

        // Active goals
        const active = data.goals.filter(g => g.status === 'active');
        const completed = data.goals.filter(g => g.status !== 'active');

        if (active.length > 0) {
          html += '<h3 style="color: #58a6ff; margin-bottom: 15px;">Active Goals</h3>';
          for (const goal of active) {
            const typeIcon = goal.type === 'topic' ? '📚' : goal.type === 'engagement' ? '💬' : goal.type === 'relationship' ? '🤝' : '🧠';
            html += \`<div class="timeline-item">
              <div class="timeline-header">
                <span class="timeline-type type-post">\${typeIcon} \${goal.type}</span>
                <span class="timeline-date">\${formatDate(goal.createdAt)}</span>
              </div>
              <div class="timeline-title">\${escapeHtml(goal.description)}</div>
              \${goal.targetDate ? \`<div class="timeline-meta">Target: \${goal.targetDate}</div>\` : ''}
              \${goal.progress.length > 0 ? \`<div class="timeline-content" style="margin-top: 8px; font-size: 0.85rem; color: #8b949e;">Latest: \${escapeHtml(goal.progress[goal.progress.length - 1])}</div>\` : ''}
            </div>\`;
          }
        }

        if (completed.length > 0) {
          html += '<h3 style="color: #8b949e; margin: 25px 0 15px 0;">Completed/Abandoned</h3>';
          for (const goal of completed.slice(-5)) {
            const statusIcon = goal.status === 'completed' ? '✅' : '❌';
            html += \`<div class="timeline-item" style="opacity: 0.7;">
              <div class="timeline-header">
                <span class="timeline-type type-observation">\${statusIcon} \${goal.type}</span>
                <span class="timeline-date">\${formatDate(goal.completedAt || goal.createdAt)}</span>
              </div>
              <div class="timeline-title">\${escapeHtml(goal.description)}</div>
              \${goal.outcome ? \`<div class="timeline-content" style="margin-top: 8px; font-size: 0.85rem;">\${escapeHtml(goal.outcome)}</div>\` : ''}
            </div>\`;
          }
        }

        // Memory stats
        if (data.stats) {
          html += '<div class="chart-container" style="margin-top: 25px;">';
          html += '<div class="chart-title">Memory System Stats</div>';
          html += '<div class="stats-grid">';
          html += \`<div class="stat-card"><div class="stat-value">\${data.stats.entries}</div><div class="stat-label">Memory Entries</div></div>\`;
          html += \`<div class="stat-card"><div class="stat-value">\${data.stats.compressedInsights}</div><div class="stat-label">Compressed Periods</div></div>\`;
          html += \`<div class="stat-card"><div class="stat-value">\${data.stats.embeddings}</div><div class="stat-label">Semantic Index</div></div>\`;
          html += \`<div class="stat-card"><div class="stat-value">\${data.stats.observations}</div><div class="stat-label">Observations</div></div>\`;
          html += '</div>';
          if (data.stats.lastCompression) {
            html += \`<div style="text-align: center; color: #8b949e; font-size: 0.85rem; margin-top: 10px;">Last compression: \${formatDate(data.stats.lastCompression)}</div>\`;
          }
          html += '</div>';
        }

        // Compressed insights preview
        if (data.insights && data.insights.length > 0) {
          html += '<div class="chart-container" style="margin-top: 20px;">';
          html += '<div class="chart-title">Historical Memory (Compressed)</div>';
          for (const insight of data.insights.slice(-4)) {
            html += \`<div style="padding: 10px; border-bottom: 1px solid #30363d;">
              <div style="color: #58a6ff; font-weight: 500;">\${insight.period}</div>
              <div style="color: #8b949e; font-size: 0.85rem;">\${insight.performanceSummary} | Topics: \${insight.topicCluster.join(', ') || 'none'}</div>
              \${insight.keyInsights.length > 0 ? \`<div style="margin-top: 5px; font-size: 0.85rem;">\${escapeHtml(insight.keyInsights[0].slice(0, 150))}...</div>\` : ''}
            </div>\`;
          }
          html += '</div>';
        }

        panel.innerHTML = html;
      } catch (err) {
        console.error('Failed to load goals:', err);
        panel.innerHTML = '<div class="empty">Failed to load goals</div>';
      }
    }

    // Render analytics
    async function renderAnalytics() {
      const panel = document.getElementById('analytics-panel');
      try {
        const res = await fetch('/api/analytics');
        const data = await res.json();

        let html = '';

        // Summary stats
        html += '<div class="stats-grid">';
        html += \`<div class="stat-card"><div class="stat-value">\${data.summary.totalPosts}</div><div class="stat-label">Total Posts</div></div>\`;
        html += \`<div class="stat-card"><div class="stat-value">\${data.summary.totalComments}</div><div class="stat-label">Total Comments</div></div>\`;
        html += \`<div class="stat-card"><div class="stat-value">\${data.summary.autonomousPosts}</div><div class="stat-label">Autonomous Posts</div></div>\`;
        html += \`<div class="stat-card"><div class="stat-value">\${data.summary.autonomousComments}</div><div class="stat-label">Autonomous Comments</div></div>\`;
        html += '</div>';

        // Activity chart (last 7 days)
        html += '<div class="chart-container">';
        html += '<div class="chart-title">Activity Over Time (Last 7 Days)</div>';
        html += '<div class="bar-chart">';

        const days = Object.entries(data.activityByDay);
        const maxActivity = Math.max(...days.map(([_, d]) => d.posts + d.comments + d.observations), 1);

        for (const [date, counts] of days) {
          const postHeight = (counts.posts / maxActivity) * 120;
          const commentHeight = (counts.comments / maxActivity) * 120;
          const obsHeight = (counts.observations / maxActivity) * 120;
          const dayLabel = new Date(date).toLocaleDateString('en-US', { weekday: 'short' });

          html += \`<div class="bar-group">
            <div style="display: flex; flex-direction: column-reverse; height: 120px; width: 100%;">
              <div class="bar" style="height: \${postHeight}px;" title="Posts: \${counts.posts}"></div>
              <div class="bar comments" style="height: \${commentHeight}px;" title="Comments: \${counts.comments}"></div>
              <div class="bar observations" style="height: \${obsHeight}px;" title="Observations: \${counts.observations}"></div>
            </div>
            <div class="bar-label">\${dayLabel}</div>
          </div>\`;
        }
        html += '</div>';
        html += '<div style="display: flex; gap: 15px; margin-top: 10px; font-size: 0.8rem;">';
        html += '<span><span style="color: #58a6ff;">■</span> Posts</span>';
        html += '<span><span style="color: #a371f7;">■</span> Comments</span>';
        html += '<span><span style="color: #f0883e;">■</span> Observations</span>';
        html += '</div></div>';

        // Action vs Observe ratio
        html += '<div class="chart-container">';
        html += '<div class="chart-title">Decision Distribution</div>';
        const total = data.summary.actionCount + data.summary.observeCount || 1;
        const actionPct = Math.round((data.summary.actionCount / total) * 100);
        const observePct = 100 - actionPct;
        html += '<div class="pie-chart">';
        html += \`<div class="pie-visual" style="background: conic-gradient(#238636 0% \${actionPct}%, #f0883e \${actionPct}% 100%);"></div>\`;
        html += '<div class="pie-legend">';
        html += \`<div class="pie-legend-item"><div class="pie-legend-color" style="background: #238636;"></div> Actions: \${data.summary.actionCount} (\${actionPct}%)</div>\`;
        html += \`<div class="pie-legend-item"><div class="pie-legend-color" style="background: #f0883e;"></div> Abstained: \${data.summary.observeCount} (\${observePct}%)</div>\`;
        html += '</div></div></div>';

        // Top posts by reputation (Loom's own posts)
        if (data.reputationData && data.reputationData.length > 0) {
          html += '<div class="chart-container">';
          html += '<div class="chart-title">Top Posts by Upvotes (Loom\\'s Posts)</div>';
          html += '<div class="ranking-list">';
          for (const post of data.reputationData) {
            html += \`<div class="ranking-item">
              <span class="ranking-title">\${escapeHtml(post.title)}</span>
              <span class="ranking-value">\${post.upvotes}↑ · \${post.comments} comments</span>
            </div>\`;
          }
          html += '</div></div>';
        }

        // Loom's top comments (by thread engagement)
        if (data.topCommentsData && data.topCommentsData.length > 0) {
          html += '<div class="chart-container">';
          html += '<div class="chart-title">Loom\\'s Top Comments</div>';
          html += '<div class="ranking-list">';
          for (const comment of data.topCommentsData) {
            const autoTag = comment.autonomous ? ' 🤖' : '';
            const upvoteLabel = comment.threadUpvotes > 0 ? \`\${comment.threadUpvotes}↑ · \` : '';
            html += \`<div class="ranking-item">
              <span class="ranking-title">\${escapeHtml(comment.preview)}...\${autoTag}</span>
              <span class="ranking-value">\${upvoteLabel}on "\${escapeHtml(comment.threadTitle)}"</span>
            </div>\`;
          }
          html += '</div></div>';
        }

        // Top topics
        if (data.topTopics.length > 0) {
          html += '<div class="chart-container">';
          html += '<div class="chart-title">Top Topics</div>';
          html += '<div class="ranking-list">';
          for (const [topic, count] of data.topTopics) {
            html += \`<div class="ranking-item">
              <span class="ranking-title">\${escapeHtml(topic)}</span>
              <span class="ranking-value">\${count} mentions</span>
            </div>\`;
          }
          html += '</div></div>';
        }

        panel.innerHTML = html;
      } catch (err) {
        console.error('Failed to load analytics:', err);
        panel.innerHTML = '<div class="empty">Failed to load analytics</div>';
      }
    }

    // Render decisions/receipts
    async function renderDecisions() {
      const panel = document.getElementById('decisions-panel');
      try {
        const res = await fetch('/api/receipts?limit=100');
        const data = await res.json();
        const receipts = data.receipts || [];

        if (!receipts.length) {
          panel.innerHTML = '<div class="empty">No decisions logged yet</div>';
          return;
        }

        let html = '<div class="memory-list">';
        for (const r of receipts) {
          const statusClass = !r.success ? 'failed' : r.action;
          const actionLabel = !r.success ? \`\${r.action} (failed)\` : r.action;

          html += \`<div class="decision-item \${statusClass}">
            <div class="decision-header">
              <span class="decision-action">\${actionLabel}</span>
              <span class="decision-time">\${timeAgo(r.ts)}</span>
            </div>\`;

          if (r.title) {
            html += \`<div class="decision-title">\${escapeHtml(r.title)}</div>\`;
          } else if (r.targetPostId) {
            html += \`<div class="decision-title">On post: \${r.targetPostId}</div>\`;
          }

          if (r.reason) {
            html += \`<div class="decision-reason">"\${escapeHtml(r.reason)}"</div>\`;
          }

          if (r.contentPreview) {
            html += \`<div class="decision-meta">\${escapeHtml(r.contentPreview.slice(0, 100))}...</div>\`;
          }

          if (r.error) {
            html += \`<div class="decision-reason" style="color: #f85149;">Error: \${escapeHtml(r.error)}</div>\`;
          }

          html += \`<div class="decision-meta">
            \${r.submolt ? \`Submolt: \${r.submolt}\` : ''}
            \${r.autonomous ? ' · autonomous' : ''}
            \${r.postId ? \` · <a href="https://www.moltbook.com/post/\${r.postId}" target="_blank">View</a>\` : ''}
          </div></div>\`;
        }
        html += '</div>';
        panel.innerHTML = html;
      } catch (err) {
        console.error('Failed to load decisions:', err);
        panel.innerHTML = '<div class="empty">Failed to load decisions</div>';
      }
    }

    // Search - universal across all tabs
    let currentSearchQuery = '';

    function getSearchBanner(query, count) {
      return '<div style="margin-bottom: 15px; padding: 10px 15px; background: #1f3a5f; border-radius: 6px; color: #58a6ff; display: flex; justify-content: space-between; align-items: center;">' +
        '<span>🔍 ' + count + ' results for "' + escapeHtml(query) + '"</span>' +
        '<button onclick="clearSearch()" style="background: none; border: 1px solid #58a6ff; color: #58a6ff; padding: 4px 12px; border-radius: 4px; cursor: pointer;">Clear</button>' +
        '</div>';
    }

    function clearSearch() {
      document.getElementById('search').value = '';
      currentSearchQuery = '';
      loadData();
    }

    async function doSearch() {
      const query = document.getElementById('search').value.trim();
      currentSearchQuery = query;

      if (!query) {
        loadData();
        return;
      }

      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(query));
        if (!res.ok) {
          throw new Error('Search failed: ' + res.status);
        }
        const data = await res.json();

        // Combine search results for timeline view
        const searchEvents = [];
        for (const p of data.posts || []) {
          searchEvents.push({ type: 'post', ts: p.ts, title: p.title || 'Untitled', content: p.summary?.slice(0, 200), postId: p.id, entryId: p.id, submolt: p.submolt, autonomous: p.autonomous });
        }
        for (const c of data.comments || []) {
          searchEvents.push({ type: 'comment', ts: c.ts, title: 'Comment on: ' + (c.targetPostTitle || 'Unknown'), content: c.summary?.slice(0, 200), postId: c.targetPostId, entryId: c.id, submolt: c.submolt, autonomous: c.autonomous });
        }
        for (const o of data.observations || []) {
          searchEvents.push({ type: 'observation', ts: o.ts, title: o.postTitle || 'General observation', content: o.note, postId: o.postId });
        }
        searchEvents.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

        const allEntries = [...(data.posts || []), ...(data.comments || [])];
        const totalResults = (data.posts?.length || 0) + (data.comments?.length || 0) + (data.observations?.length || 0) + (data.threads?.length || 0);
        const banner = getSearchBanner(query, totalResults);

        // Timeline panel
        const timelinePanel = document.getElementById('timeline-panel');
        if (searchEvents.length === 0) {
          timelinePanel.innerHTML = banner + '<div class="empty">No matching activity</div>';
        } else {
          renderTimeline(searchEvents, allEntries);
          timelinePanel.innerHTML = banner + timelinePanel.innerHTML;
        }

        // Memory panel
        renderMemory({ entries: allEntries, threads: data.threads, observations: data.observations });
        const memoryPanel = document.getElementById('memory-panel');
        memoryPanel.innerHTML = banner + memoryPanel.innerHTML;

        // Threads panel
        renderThreads(data.threads);
        const threadsPanel = document.getElementById('threads-panel');
        threadsPanel.innerHTML = banner + threadsPanel.innerHTML;

        // Observations panel
        renderObservations(data.observations);
        const obsPanel = document.getElementById('observations-panel');
        obsPanel.innerHTML = banner + obsPanel.innerHTML;

        // Decisions panel - filter by query
        const receiptsRes = await fetch('/api/receipts?limit=100');
        const receiptsData = await receiptsRes.json();
        const q = query.toLowerCase();
        const filteredReceipts = (receiptsData.receipts || []).filter(r =>
          (r.title && r.title.toLowerCase().includes(q)) ||
          (r.reason && r.reason.toLowerCase().includes(q)) ||
          (r.contentPreview && r.contentPreview.toLowerCase().includes(q)) ||
          (r.submolt && r.submolt.toLowerCase().includes(q))
        );
        renderDecisionsWithBanner(filteredReceipts, banner);

        // Analytics - no filtering, just show banner
        renderAnalytics();
        const analyticsPanel = document.getElementById('analytics-panel');
        analyticsPanel.innerHTML = banner + analyticsPanel.innerHTML;

        // Goals - no filtering, just show banner
        renderGoals();
        const goalsPanel = document.getElementById('goals-panel');
        goalsPanel.innerHTML = banner + goalsPanel.innerHTML;

      } catch (err) {
        console.error('Search failed:', err);
        document.getElementById('timeline-panel').innerHTML = '<div class="empty">Search failed</div>';
      }
    }

    function renderDecisionsWithBanner(receipts, banner) {
      const panel = document.getElementById('decisions-panel');
      if (!receipts.length) {
        panel.innerHTML = banner + '<div class="empty">No matching decisions</div>';
        return;
      }
      let html = '<div class="memory-list">';
      for (const r of receipts) {
        const statusClass = !r.success ? 'failed' : r.action;
        const actionLabel = !r.success ? r.action + ' (failed)' : r.action;
        html += '<div class="decision-item ' + statusClass + '">';
        html += '<div class="decision-header"><span class="decision-action">' + actionLabel + '</span><span class="decision-time">' + timeAgo(r.ts) + '</span></div>';
        if (r.title) html += '<div class="decision-title">' + escapeHtml(r.title) + '</div>';
        if (r.reason) html += '<div class="decision-reason">"' + escapeHtml(r.reason) + '"</div>';
        if (r.contentPreview) html += '<div class="decision-meta">' + escapeHtml(r.contentPreview.slice(0, 100)) + '...</div>';
        html += '</div>';
      }
      html += '</div>';
      panel.innerHTML = banner + html;
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

        // Load timeline (pass entries for clickable items)
        const timelineRes = await fetch('/api/timeline');
        const timeline = await timelineRes.json();
        renderTimeline(timeline.events, memory.entries);

        // Load analytics, goals, and decisions
        renderAnalytics();
        renderGoals();
        renderDecisions();
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
    try {
      const memory = readMemory();
      const results = searchMemory(memory, query);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
    } catch (err) {
      console.error("dashboard: search error", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Search failed", posts: [], comments: [], observations: [], threads: [] }));
    }
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

  // API: Goals and memory stats
  if (url.pathname === "/api/goals") {
    try {
      const memory = readMemory();
      const stats = getEnhancedMemoryStats();
      const goals = memory.goals || [];
      const insights = memory.compressedInsights || [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ goals, stats, insights }));
    } catch (err) {
      console.error("dashboard: goals error", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to load goals", goals: [], stats: null, insights: [] }));
    }
    return true;
  }

  // API: Get single entry by ID
  const entryMatch = url.pathname.match(/^\/api\/entry\/(.+)$/);
  if (entryMatch) {
    const entryId = decodeURIComponent(entryMatch[1]);
    const memory = readMemory();
    const entry = memory.entries.find((e) => e.id === entryId);
    if (entry) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(entry));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Entry not found" }));
    }
    return true;
  }

  // API: Analytics data
  if (url.pathname === "/api/analytics") {
    const memory = readMemory();
    const receipts = getRecentReceipts(100);

    // Calculate analytics
    const posts = memory.entries.filter((e) => e.type === "post");
    const comments = memory.entries.filter((e) => e.type === "comment");
    const observations = memory.observations || [];

    // Activity over time (last 7 days by hour buckets)
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const activityByDay: Record<string, { posts: number; comments: number; observations: number }> = {};

    for (let i = 6; i >= 0; i--) {
      const date = new Date(now - i * dayMs);
      const key = date.toISOString().split("T")[0];
      activityByDay[key] = { posts: 0, comments: 0, observations: 0 };
    }

    for (const entry of memory.entries) {
      const key = entry.ts.split("T")[0];
      if (activityByDay[key]) {
        if (entry.type === "post") activityByDay[key].posts++;
        else activityByDay[key].comments++;
      }
    }

    for (const obs of observations) {
      const key = obs.ts.split("T")[0];
      if (activityByDay[key]) activityByDay[key].observations++;
    }

    // Action vs observe ratio from receipts
    const actionCount = receipts.filter((r) =>
      r.action === "post" || r.action === "comment" || r.action === "vote_up" || r.action === "vote_down"
    ).length;
    const observeCount = receipts.filter((r) => r.action === "abstain").length;

    // Reputation by entry (only for Loom's OWN posts, not posts Loom commented on)
    // Get set of post IDs that Loom authored
    const loomPostIds = new Set(posts.map((p) => p.id));
    // Filter threads to only those where Loom authored the post
    const threads = memory.threads || [];
    const reputationData = threads
      .filter((t) => loomPostIds.has(t.postId))
      .map((t) => ({
        title: (t.postTitle || "Untitled").slice(0, 30),
        upvotes: t.lastKnownUpvotes || 0,
        comments: t.lastKnownCommentCount || 0,
      }))
      .sort((a, b) => b.upvotes - a.upvotes)
      .slice(0, 10);

    // Top comments - Loom's own comments, sorted by thread upvotes (proxy for visibility)
    // Build a map of thread upvotes for quick lookup
    const threadUpvotes = new Map<string, number>();
    for (const t of threads) {
      threadUpvotes.set(t.postId, t.lastKnownUpvotes || 0);
    }

    const topCommentsData = comments
      .map((c) => ({
        preview: c.summary || (c.content ? c.content.slice(0, 50) : "No content"),
        threadTitle: (c.targetPostTitle || "Unknown thread").slice(0, 25),
        ts: c.ts,
        autonomous: c.autonomous,
        threadUpvotes: threadUpvotes.get(c.targetPostId || "") || 0,
      }))
      .sort((a, b) => {
        // Sort by thread upvotes desc, then by recency desc
        if (b.threadUpvotes !== a.threadUpvotes) {
          return b.threadUpvotes - a.threadUpvotes;
        }
        return new Date(b.ts).getTime() - new Date(a.ts).getTime();
      })
      .slice(0, 10);

    // Topics frequency
    const topicCounts: Record<string, number> = {};
    for (const entry of memory.entries) {
      for (const topic of entry.topics || []) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
    }
    const topTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      summary: {
        totalPosts: posts.length,
        totalComments: comments.length,
        totalObservations: observations.length,
        autonomousPosts: posts.filter((p) => p.autonomous).length,
        autonomousComments: comments.filter((c) => c.autonomous).length,
        actionCount,
        observeCount,
      },
      activityByDay,
      reputationData,
      topCommentsData,
      topTopics,
    }));
    return true;
  }

  return false;
}
