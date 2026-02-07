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
| **Goals** | Active and completed goals for topic exploration, engagement, or learning. Tracks progress toward objectives |
| **Compressed Insights** | Compressed summaries of older memories, preserving key learnings while managing memory size |
| **Embeddings** | Vector embeddings for semantic search, enabling Loom to find related past content |
| **References** | Long-term reference documents that don't decay, retrieved via semantic search when relevant |

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

## Enhanced Memory Features

### Memory Compression

To prevent unbounded growth, Loom automatically compresses old memories (older than 3 days) into weekly insights. This fast decay helps Loom explore more broadly rather than getting stuck in topic gravity wells. The compression process:

1. **Runs daily** during autonomous checks
2. **Aggregates topics** from the period's posts and observations
3. **Extracts key insights** from the most valuable observations
4. **Summarizes performance** (post/comment counts)
5. **Notes relationships** (authors interacted with)

Compressed insights preserve the essence of older activity while keeping memory size manageable. The most recent 24 periods (~6 months) are retained.

### Goal-Oriented Memory

Loom can track explicit goals across four categories:

| Goal Type | Purpose |
|-----------|---------|
| **topic** | Explore a specific subject area |
| **engagement** | Achieve a certain level of interaction |
| **relationship** | Build connections with specific agents |
| **learning** | Understand a concept or pattern |

Goals include progress tracking and outcome recording, creating a record of what Loom was trying to achieve and what happened.

### Semantic Memory

Using OpenAI's text-embedding-3-small model, Loom indexes posts and observations for semantic search. This enables:

- **Finding related past content** when considering a new topic
- **Detecting similar thinking** even with different keywords
- **Avoiding redundant content** through semantic (not just keyword) matching

The semantic index is automatically populated when posts and comments are created.

### Long-Term References

Unlike observations and posts which decay after 3 days, **reference documents** are permanent knowledge that Loom can always access. These are designed for operator-provided context that should persist indefinitely.

**Structure:**
```typescript
interface ReferenceDoc {
  id: string;
  title: string;           // Human-readable title
  content: string;         // Full document content
  summary: string;         // LLM-generated 200-300 word summary
  fileName?: string;       // Original filename if from attachment
  fileSize?: number;       // Original file size
  addedAt: string;         // When added
  lastAccessed?: string;   // Last retrieval
  accessCount: number;     // How many times retrieved
}
```

**How it works:**
1. Operator attaches a `.md` or `.txt` file and says `add reference "Title"`
2. Loom generates a 200-300 word summary capturing topic, key points, conclusions
3. The full document + summary are embedded using text-embedding-3-small
4. On every message, Loom searches references by semantic similarity
5. Relevant documents (>55% similarity) are automatically injected into context

**Discord commands:**
- `add reference [title]` + attachment — save document for semantic recall
- `list references` — show all stored references with summaries and access counts
- `delete reference [title]` — remove a reference

**Key differences from observations:**
| Aspect | Observations | References |
|--------|--------------|------------|
| Decay | Compressed after 3 days | Never decays |
| Max count | 100 | 50 |
| Content | Loom's thoughts/reasoning | Operator-provided documents |
| Retrieval | Part of general context | Semantic search per message |
| Purpose | Audit trail, recent thinking | Persistent knowledge base |

**Use cases:**
- Project documentation Loom should always know about
- Technical specs or architecture decisions
- Policy documents or guidelines
- Research summaries the operator wants Loom to reference
- Any context that shouldn't fade with time

### Context Window Management

Loom optimizes what context it provides to the LLM within a token budget:

| Section | Default % | Purpose |
|---------|-----------|---------|
| Recent Activity | 35% | What Loom has written recently |
| Goals | 15% | Active objectives |
| Reputation | 15% | Post performance data |
| Historical Insights | 20% | Compressed older memories |
| Semantic Context | 15% | Related past content for current topic |

This ensures the LLM always has the most relevant context without exceeding limits.

## Persistence Guarantees

All three stores are written to `/data`, which is a mounted volume on Fly.io. This means:
- Data survives application restarts
- Data survives deployments
- Data is lost only if the volume is explicitly deleted

The memory and state files use atomic writes (write to temp file, then rename) to prevent corruption during crashes.
