# State and Memory Architecture

Loom uses three persistent data stores on a mounted volume (`/data`) that survive restarts. This architecture enables Loom to maintain coherent behavior over time, learn from engagement patterns, and respect operator boundaries.

## Data Stores

### 1. State (`loom-state.json`)

Tracks operational boundaries and learns from feedback:

| Field | Purpose |
|-------|---------|
| **Cooldowns** | Enforces rate limits (e.g., 4 hours between posts, 5 minutes between comments) to prevent flooding |
| **Daily counters** | Tracks posts/comments per day against configurable limits |
| **Karma history** | Daily snapshots of upvotes/downvotes to detect trends (e.g., "my recent posts are landing poorly") |
| **Stop conditions** | Can halt posting entirely if receiving repeated negative feedback |
| **Operator instructions** | Remembers blocked posts/topics from Discord commands |

### 2. Memory (`loom-memory.json`)

The "brain" that enables coherent, non-repetitive engagement:

| Field | Purpose |
|-------|---------|
| **Entries** | Every post/comment Loom has written, with topics, summaries, and timestamps. Used to avoid repeating itself and to reference past work |
| **Threads** | Posts Loom is following, tracking upvotes/comments over time. Distinguishes between posts Loom *authored* vs. posts Loom just *commented on* (via `isOurPost`) |
| **Observations** | Loom's reasoning: why it posted, why it abstained, insights noticed during browsing. Creates an audit trail of its thinking |
| **Recent browse** | Last 50 posts seen, preventing Loom from commenting on the same posts repeatedly within a session |

### 3. Receipts (`publish-receipts.jsonl`)

Append-only audit log of every action (post, comment, vote, abstain) with:
- Success/failure status
- Timing information
- Justification for the decision
- Error messages (if failed)

## How Memory Makes Loom More Effective

### Avoiding Repetition
Before creating content, Loom checks if it has recently covered a topic. This prevents the "broken record" effect where an agent keeps posting variations of the same idea.

### Building on Context
Loom can reference its own history: "I wrote about X last week, and since then..." This creates a sense of continuity and allows for evolving perspectives.

### Learning from Engagement
Karma tracking shows which content resonates with the community. Over time, Loom can identify patterns:
- Topics that consistently perform well
- Framing approaches that land better
- Times when engagement is higher

### Respecting Engagement Limits
Per-thread limits (max 2 comments per day per thread) prevent over-engagement. Without this, Loom might dominate conversations, which damages community trust.

### Operator Oversight
The operator instructions system remembers directives like "don't comment on that thread" or "avoid topic X." These persist across restarts, ensuring consistent behavior.

### Traction Awareness
Thread tracking distinguishes between:
- **Posts Loom authored** — alerts operator when these gain traction
- **Posts Loom commented on** — tracked for reply detection, but no traction alerts

This prevents alert spam when a popular thread Loom happened to comment on continues growing.

## Data Flow Example

When Loom considers making a post:

```
1. Check state.json
   └─ Am I in cooldown? Have I hit daily limits?
   └─ Are there any stop conditions active?
   └─ Is this topic/post blocked by operator?

2. Check memory.json
   └─ Have I written about this topic recently?
   └─ What's my track record on similar topics?
   └─ Does this add to my existing body of work?

3. Make decision
   └─ If posting: record in entries, create thread entry
   └─ If abstaining: record observation explaining why

4. Log receipt
   └─ Append to publish-receipts.jsonl
```

## Persistence Guarantees

All three stores are written to `/data`, which is a mounted volume on Fly.io. This means:
- Data survives application restarts
- Data survives deployments
- Data is lost only if the volume is explicitly deleted

The memory and state files use atomic writes (write to temp file, then rename) to prevent corruption during crashes.
