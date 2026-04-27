#!/usr/bin/env python3
"""
Diverse SFT Data Generator — Fixes Generalization Failure

The previous SFT used 1-3 phrasings per tool, causing the model to 
memorize exact prompt patterns. This generator creates 15-20 diverse 
phrasings per tool, including:
  - Formal requests
  - Casual/conversational
  - Abbreviated commands
  - Indirect/implied intent
  - Context-rich with extra detail
"""
import json
import random
import os

TOOL_CALL_OPEN = "<|tool_call|>"
TOOL_CALL_CLOSE = "</|tool_call|>"

# === DIVERSE PHRASINGS PER TOOL ===
# Each tool has 15-20 varied prompts with different styles

TOOL_PROMPTS = {
    "session_load_context": {
        "default_args": {"project": "prism-mcp", "level": "deep", "toolAction": "Loading context", "toolSummary": "Loading project context"},
        "prompts": [
            ("Load context for prism-mcp project", {"project": "prism-mcp"}),
            ("Pull up the context for docs-portal", {"project": "docs-portal"}),
            ("Hey, start a new session. Show me where we left off on prism-mcp.", {"project": "prism-mcp"}),
            ("Initialize session context for billing-portal", {"project": "billing-portal"}),
            ("What was our last state on the synalux project?", {"project": "docs-portal"}),
            ("Resume work on prism-mcp", {"project": "prism-mcp"}),
            ("Show me what we were working on last time", {"project": "prism-mcp"}),
            ("Boot up the prism-mcp context please", {"project": "prism-mcp"}),
            ("I want to continue where we left off on docs-portal", {"project": "docs-portal"}),
            ("Get me up to speed on the billing-portal project", {"project": "billing-portal"}),
            ("Restore the previous session state", {"project": "prism-mcp"}),
            ("Pull up everything we had on the internal docs", {"project": "docs-portal"}),
            ("What's the current state of prism-mcp?", {"project": "prism-mcp"}),
            ("Load context.", {"project": "prism-mcp"}),
            ("Start session.", {"project": "prism-mcp"}),
        ]
    },
    "session_save_ledger": {
        "default_args": {"project": "prism-mcp", "conversation_id": "current", "summary": "Session work completed"},
        "prompts": [
            ("Save this session: fixed the OAuth bug in the portal", {"summary": "Fixed the OAuth bug in the portal"}),
            ("Can you jot down what we accomplished? We rewrote the webhook handler.", {"summary": "Rewrote the webhook handler"}),
            ("Record this work: migrated Stripe webhooks to v2 API", {"summary": "Migrated Stripe webhooks to v2 API"}),
            ("Log what we did today on the billing module", {"summary": "Billing module work completed"}),
            ("Save our progress", {"summary": "Session progress saved"}),
            ("Write down what we've done — fixed three test failures and refactored the auth layer", {"summary": "Fixed three test failures and refactored the auth layer"}),
            ("Commit this session to the ledger please", {"summary": "Session work logged"}),
            ("Let's wrap up. Save everything we did.", {"summary": "Session wrapped up and saved"}),
            ("Mark this session as done. We deployed the new cache layer.", {"summary": "Deployed the new cache layer"}),
            ("Note: we finished the database migration today", {"summary": "Finished the database migration"}),
            ("Save session notes: resolved the CORS issue on staging", {"summary": "Resolved the CORS issue on staging"}),
            ("Time to call it a day. Record what we did.", {"summary": "End of day session recorded"}),
            ("Log this — we implemented the rate limiter", {"summary": "Implemented the rate limiter"}),
            ("Don't forget to save that we fixed the memory leak", {"summary": "Fixed the memory leak"}),
            # Targeted: short/ambiguous save commands → always session_save_ledger
            ("Save.", {"summary": "Session saved"}),
            ("Save session.", {"summary": "Session saved"}),
            ("Save this.", {"summary": "Session work saved"}),
            ("Save what we did.", {"summary": "Session work saved"}),
            ("Record this.", {"summary": "Session recorded"}),
            ("Log it.", {"summary": "Session logged"}),
        ]
    },
    "session_search_memory": {
        "default_args": {"query": "search query"},
        "prompts": [
            ("What did we work on last week related to billing?", {"query": "billing work last week"}),
            ("Remind me — did we ever decide between Redis and Memcached for the session store?", {"query": "Redis vs Memcached session store decision"}),
            ("Find what we decided about the database migration strategy", {"query": "database migration strategy decision"}),
            ("Search for anything we discussed about the authentication overhaul", {"query": "authentication overhaul discussion"}),
            ("Look up past work on the OAuth2 refresh flow", {"query": "OAuth2 refresh flow implementation"}),
            ("What have we done before regarding Kubernetes pod scaling?", {"query": "Kubernetes pod scaling"}),
            ("Did we ever implement retry logic for the webhook system?", {"query": "webhook retry logic implementation"}),
            ("Search memory for any notes about the CI/CD pipeline", {"query": "CI/CD pipeline notes"}),
            ("Find all our past notes about the billing API redesign", {"query": "billing API redesign notes"}),
            ("Have we discussed rate limiting before?", {"query": "rate limiting discussion"}),
            ("What did we conclude about the caching strategy?", {"query": "caching strategy conclusion"}),
            ("Look up our previous work on error handling", {"query": "error handling work"}),
            ("I remember we discussed something about edge functions. What was it?", {"query": "edge functions discussion"}),
            ("Search for deployment-related decisions from last month", {"query": "deployment decisions last month"}),
            ("Any past work on the notification system?", {"query": "notification system past work"}),
        ]
    },
    "session_save_handoff": {
        "default_args": {"project": "prism-mcp"},
        "prompts": [
            ("Create a handoff for the docs-portal project", {"project": "docs-portal"}),
            ("I'm handing this off to the night shift. Save the state for prism-mcp.", {"project": "prism-mcp"}),
            ("Save handoff notes for the next session", {"project": "prism-mcp"}),
            ("Prepare the handoff — someone else will pick this up tomorrow", {"project": "docs-portal"}),
            ("Create transition notes for billing-portal", {"project": "billing-portal"}),
            ("Pass the baton — save where we are on docs-portal", {"project": "docs-portal"}),
            ("I need to switch contexts. Save the handoff state.", {"project": "prism-mcp"}),
            ("Make sure the next person knows where we left off", {"project": "prism-mcp"}),
            ("Handoff time. Save the current project state.", {"project": "docs-portal"}),
            ("End my shift. Create handoff notes.", {"project": "prism-mcp"}),
            ("Save handoff.", {"project": "prism-mcp"}),
            ("Write handoff for the prism project", {"project": "prism-mcp"}),
            ("Archive current state so the next agent can resume", {"project": "prism-mcp"}),
            ("Freeze the state and prepare handoff notes", {"project": "docs-portal"}),
            ("Wrap up and hand off to the next session", {"project": "prism-mcp"}),
        ]
    },
    "session_forget_memory": {
        "default_args": {"memory_id": "entry-id", "reason": "No longer relevant"},
        "prompts": [
            ("Delete the memory entry for the broken config change", {"memory_id": "broken_config_entry"}),
            ("That memory about the old deployment script is totally wrong. Nuke it.", {"memory_id": "old_deploy_script"}),
            ("Remove the memory about the failed deploy last Friday", {"memory_id": "failed_deploy_friday"}),
            ("Forget the session entry about the old API design", {"memory_id": "old_api_design"}),
            ("Erase that incorrect note about the database schema", {"memory_id": "wrong_db_schema"}),
            ("This entry is outdated. Please delete it.", {"memory_id": "outdated_entry"}),
            ("Purge the stale memory about our old auth flow", {"memory_id": "old_auth_flow"}),
            ("Remove memory ID abc-123 — it's wrong information", {"memory_id": "abc-123"}),
            ("That ledger entry is no longer accurate. Remove it please.", {"memory_id": "inaccurate_entry"}),
            ("Delete that bad note we saved about the Stripe integration", {"memory_id": "bad_stripe_note"}),
            ("Clean out the memory about the deprecated endpoint", {"memory_id": "deprecated_endpoint"}),
            ("Forget entry xyz-789", {"memory_id": "xyz-789"}),
            # Targeted: diverse "nuke/delete" phrasings to prevent knowledge_forget hallucination
            ("That memory entry about the old deployment script is totally wrong. Nuke it.", {"memory_id": "old_deploy_entry"}),
            ("Get rid of that wrong memory about the API keys", {"memory_id": "wrong_api_keys"}),
            ("Wipe out the session memory for the failed migration", {"memory_id": "failed_migration"}),
            ("Kill that bad entry in the ledger", {"memory_id": "bad_entry"}),
            ("Trash the memory about our broken CI config", {"memory_id": "broken_ci_config"}),
            ("Remove that incorrect session note", {"memory_id": "incorrect_note"}),
            ("Delete this memory — it's completely wrong", {"memory_id": "wrong_memory"}),
            ("Destroy that stale entry about the old webhook", {"memory_id": "stale_webhook"}),
        ]
    },
    "session_health_check": {
        "default_args": {},
        "prompts": [
            ("Check if the memory database has any integrity issues", {}),
            ("Is everything OK with the memory backend? Run diagnostics.", {}),
            ("Run a health check on the memory system", {}),
            ("Is our memory system healthy? Auto-fix if not.", {"auto_fix": True}),
            ("Diagnose the memory storage", {}),
            ("Are there any issues with our session database?", {}),
            ("Run integrity checks on the knowledge base", {}),
            ("Check for orphaned entries or missing embeddings", {}),
            ("Is the memory layer working correctly?", {}),
            ("System health check please", {}),
            ("Any problems with the database?", {}),
            ("Scan for memory issues", {}),
        ]
    },
    "knowledge_search": {
        "default_args": {"query": "search query"},
        "prompts": [
            ("Search knowledge base for anything about CORS policies", {"query": "CORS policies"}),
            ("Any institutional knowledge about how we handle rate limiting?", {"query": "rate limiting handling"}),
            ("What's in our knowledge base about Supabase RLS policies?", {"query": "Supabase RLS policies"}),
            ("I need to know if our knowledge base has anything on Kubernetes pod autoscaling.", {"query": "Kubernetes pod autoscaling"}),
            ("Any documented patterns for error handling?", {"query": "error handling patterns"}),
            ("What do we know about edge function cold starts?", {"query": "edge function cold starts"}),
            ("Look up knowledge about OAuth2 flows", {"query": "OAuth2 flows"}),
            ("Is there documented guidance on our database indexing strategy?", {"query": "database indexing strategy"}),
            ("Search KB for JWT best practices", {"query": "JWT best practices"}),
            ("Any knowledge items about deployment procedures?", {"query": "deployment procedures"}),
            ("What's recorded about our caching architecture?", {"query": "caching architecture"}),
            ("Check knowledge for HIPAA compliance notes", {"query": "HIPAA compliance"}),
            # Extra examples with "knowledge" keyword to prevent false negatives
            ("Do we have any knowledge about handling WebSocket reconnections?", {"query": "WebSocket reconnections"}),
            ("Search our knowledge for database migration best practices", {"query": "database migration best practices"}),
            ("What knowledge do we have about error boundary patterns?", {"query": "error boundary patterns"}),
            ("Any knowledge about rate limiting strategies?", {"query": "rate limiting strategies"}),
            ("Check our knowledge base for API versioning notes", {"query": "API versioning"}),
        ]
    },
    "session_compact_ledger": {
        "default_args": {"project": "prism-mcp"},
        "prompts": [
            ("Compact old ledger entries for the prism-mcp project", {"project": "prism-mcp"}),
            ("The ledger is getting huge. Summarize and archive the old stuff.", {"project": "prism-mcp"}),
            ("Clean up the session history, compact entries", {"project": "docs-portal"}),
            ("Archive old entries and roll them up", {"project": "prism-mcp"}),
            ("The session log is too long. Compact it.", {"project": "prism-mcp"}),
            ("Compress the older ledger entries into summaries", {"project": "prism-mcp"}),
            ("Run compaction on the prism-mcp ledger", {"project": "prism-mcp"}),
            ("Tidy up the session history", {"project": "docs-portal"}),
            ("Compact ledger.", {"project": "prism-mcp"}),
            ("Roll up old sessions into summaries", {"project": "prism-mcp"}),
        ]
    },
    "session_export_memory": {
        "default_args": {"output_dir": "/tmp/export", "project": "prism-mcp", "format": "json"},
        "prompts": [
            ("Export prism-mcp memory to /tmp/export", {"output_dir": "/tmp/export", "project": "prism-mcp"}),
            ("Dump everything to a file so I can back it up. JSON format, save to /tmp/prism-backup.", {"output_dir": "/tmp/prism-backup", "format": "json"}),
            ("Export all memory data for billing-portal to my desktop", {"output_dir": "/tmp/export", "project": "billing-portal"}),
            ("Back up the knowledge base to JSON", {"output_dir": "/tmp/export", "format": "json"}),
            ("Save a snapshot of all session data to /tmp/dump", {"output_dir": "/tmp/dump"}),
            ("Create a portable export of the prism project", {"output_dir": "/tmp/export", "project": "prism-mcp"}),
            ("I need an offline copy of our memory. Export it.", {"output_dir": "/tmp/export"}),
            ("Export memory.", {"output_dir": "/tmp/export"}),
            ("Download all session history as markdown", {"output_dir": "/tmp/export", "format": "markdown"}),
            ("Archive the project memory to disk", {"output_dir": "/tmp/archive"}),
        ]
    },
    "session_task_route": {
        "default_args": {"task_description": "task to route"},
        "prompts": [
            ("Route this task: refactoring the auth middleware", {"task_description": "refactoring the auth middleware", "estimated_scope": "refactor"}),
            ("Should I handle this CSS grid refactor myself or punt it to the local model?", {"task_description": "CSS grid refactor", "estimated_scope": "refactor"}),
            ("Is this task complex enough for the cloud or can local AI handle it?", {"task_description": "task complexity evaluation"}),
            ("Route: fixing a typo in the README", {"task_description": "fixing a typo in the README", "estimated_scope": "minor_edit"}),
            ("Should this bug fix go to the local model or cloud?", {"task_description": "bug fix routing", "estimated_scope": "bug_fix"}),
            ("Determine if this new feature needs cloud processing", {"task_description": "new feature evaluation", "estimated_scope": "new_feature"}),
            ("Can the local agent handle adding unit tests?", {"task_description": "adding unit tests"}),
            ("Route this coding task appropriately", {"task_description": "coding task routing"}),
        ]
    },
    "knowledge_set_retention": {
        "default_args": {"project": "prism-mcp", "ttl_days": 90},
        "prompts": [
            ("Set a 90-day retention policy for the billing project.", {"project": "billing", "ttl_days": 90}),
            ("Auto-expire entries older than 30 days for staging project.", {"project": "staging", "ttl_days": 30}),
            ("Configure TTL of 60 days for the analytics project's memory.", {"project": "analytics", "ttl_days": 60}),
            ("Set data retention to 7 days for the test project.", {"project": "test", "ttl_days": 7}),
            ("I want entries older than 180 days to auto-expire in prism-mcp.", {"project": "prism-mcp", "ttl_days": 180}),
            ("Set a retention policy on the billing-portal project to keep only the last 14 days.", {"project": "billing-portal", "ttl_days": 14}),
            ("Enable auto-expiry for the demo project. 30 day TTL.", {"project": "demo", "ttl_days": 30}),
            ("Configure memory retention: 90 days for docs-portal.", {"project": "docs-portal", "ttl_days": 90}),
            ("Set TTL to 45 days for the dev project.", {"project": "dev", "ttl_days": 45}),
            ("Disable auto-expiry for the production project.", {"project": "production", "ttl_days": 0}),
            ("Turn off retention for prism-mcp.", {"project": "prism-mcp", "ttl_days": 0}),
            ("I need old entries to automatically clean up after 120 days in the analytics project.", {"project": "analytics", "ttl_days": 120}),
            ("Set retention.", {"project": "prism-mcp", "ttl_days": 90}),
            ("Auto-expire old memory after 60 days.", {"project": "prism-mcp", "ttl_days": 60}),
            ("Retention policy: 30 days, project analytics.", {"project": "analytics", "ttl_days": 30}),
        ]
    },
    "session_save_image": {
        "default_args": {"project": "prism-mcp", "file_path": "/tmp/screenshot.png", "description": "Screenshot"},
        "prompts": [
            ("Save the screenshot at /tmp/screenshot.png to the dashboard project. Description: Login page redesign mockup.", {"project": "dashboard", "file_path": "/tmp/screenshot.png", "description": "Login page redesign mockup"}),
            ("Store this image /tmp/diagram.png in the prism-mcp project visual memory. It shows the architecture overview.", {"project": "prism-mcp", "file_path": "/tmp/diagram.png", "description": "Architecture overview diagram"}),
            ("Remember this screenshot: /tmp/bug.png for the billing project. Shows the payment form glitch.", {"project": "billing", "file_path": "/tmp/bug.png", "description": "Payment form glitch"}),
            ("Add /tmp/mockup.jpg to visual memory for docs-portal. It's the new landing page design.", {"project": "docs-portal", "file_path": "/tmp/mockup.jpg", "description": "New landing page design"}),
            ("Save image /tmp/graph.svg to the analytics project — performance benchmark chart.", {"project": "analytics", "file_path": "/tmp/graph.svg", "description": "Performance benchmark chart"}),
            ("Put this diagram into visual memory: /tmp/flow.png for prism-mcp. Shows the data flow pipeline.", {"project": "prism-mcp", "file_path": "/tmp/flow.png", "description": "Data flow pipeline"}),
            ("Store /tmp/ui-state.webp for the dashboard project. It's the current UI state before refactor.", {"project": "dashboard", "file_path": "/tmp/ui-state.webp", "description": "UI state before refactor"}),
            ("Save this to visual memory: /tmp/error.png for billing. Shows the 500 error page.", {"project": "billing", "file_path": "/tmp/error.png", "description": "500 error page"}),
            ("Save image.", {"project": "prism-mcp", "file_path": "/tmp/screenshot.png", "description": "Screenshot"}),
            ("Save the screenshot to project memory.", {"project": "prism-mcp", "file_path": "/tmp/screenshot.png", "description": "Screenshot"}),
            ("Store the diagram /tmp/class-diagram.png for prism-mcp. Class inheritance diagram.", {"project": "prism-mcp", "file_path": "/tmp/class-diagram.png", "description": "Class inheritance diagram"}),
            ("Remember this image /tmp/before.png for the refactor project — shows state before changes.", {"project": "refactor", "file_path": "/tmp/before.png", "description": "State before changes"}),
            ("Upload /tmp/wireframe.png to the design project's visual memory vault. Wireframe for settings page.", {"project": "design", "file_path": "/tmp/wireframe.png", "description": "Settings page wireframe"}),
            ("Persist this screenshot to memory: /tmp/test-results.png for the qa project. Test run results dashboard.", {"project": "qa", "file_path": "/tmp/test-results.png", "description": "Test run results dashboard"}),
            ("Archive the image at /tmp/deploy-status.png for the ops project. Deployment status overview.", {"project": "ops", "file_path": "/tmp/deploy-status.png", "description": "Deployment status overview"}),
        ]
    },
    "session_view_image": {
        "default_args": {"project": "prism-mcp", "image_id": "abc123"},
        "prompts": [
            ("Show me the image abc123 from prism-mcp.", {"project": "prism-mcp", "image_id": "abc123"}),
            ("View the screenshot with ID def456 from the dashboard project.", {"project": "dashboard", "image_id": "def456"}),
            ("Pull up image 8f2a1b3c from the billing project visual memory.", {"project": "billing", "image_id": "8f2a1b3c"}),
            ("Retrieve the diagram we saved earlier. ID is xyz789, project prism-mcp.", {"project": "prism-mcp", "image_id": "xyz789"}),
            ("Let me see that screenshot from before. Image ID aaa111, analytics project.", {"project": "analytics", "image_id": "aaa111"}),
            ("Display image bbb222 from docs-portal.", {"project": "docs-portal", "image_id": "bbb222"}),
            ("Open the visual memory entry ccc333 for the ops project.", {"project": "ops", "image_id": "ccc333"}),
            ("View image.", {"project": "prism-mcp", "image_id": "abc123"}),
        ]
    },
}

# === REASONING PROMPTS (diverse, NO tool) ===
REASONING_PROMPTS = [
    # Standard technical questions — R20-fix: all tuples with real answers
    ("What is the difference between TCP and UDP?", "TCP is a connection-oriented protocol that guarantees reliable, ordered delivery of data using a three-way handshake and acknowledgment system. UDP is connectionless and unreliable but much faster, making it ideal for real-time applications like gaming, VoIP, and live streaming where occasional packet loss is acceptable."),
    ("How does React's virtual DOM work?", "React maintains a lightweight in-memory representation of the actual DOM called the virtual DOM. When state changes, React creates a new virtual DOM tree, diffs it against the previous one (reconciliation), and then batches the minimal set of actual DOM mutations needed. This avoids expensive direct DOM manipulation and improves rendering performance."),
    ("Write a Python function to reverse a linked list", "Here's an iterative approach:\n```python\ndef reverse_linked_list(head):\n    prev, current = None, head\n    while current:\n        next_node = current.next\n        current.next = prev\n        prev = current\n        current = next_node\n    return prev\n```\nThis runs in O(n) time and O(1) space by re-pointing each node's next pointer to the previous node."),
    ("Explain JWT tokens and how they work in authentication", "JSON Web Tokens consist of three Base64-encoded parts: Header (algorithm + type), Payload (claims like user ID, expiry), and Signature (HMAC or RSA signed). The server creates a JWT on login, the client stores it (usually in httpOnly cookies), and sends it with each request. The server verifies the signature without needing a database lookup, making JWTs stateless and scalable."),
    ("What are the pros and cons of microservices architecture?", "Pros: independent deployability, technology diversity, team autonomy, fault isolation, and horizontal scaling per service. Cons: distributed system complexity (network latency, partial failures), data consistency challenges, operational overhead (monitoring, logging, tracing), and the need for robust service discovery and API gateway infrastructure."),
    ("How do I save state in React with useState?", "Call `const [value, setValue] = useState(initialValue)` inside a functional component. React preserves the state between re-renders. To update, call `setValue(newValue)` or use the functional form `setValue(prev => prev + 1)` when the update depends on previous state. For complex state, consider `useReducer` instead."),
    ("Explain how session tokens work in web authentication", "After a user logs in, the server generates a unique session token (cryptographically random string), stores it server-side with a mapping to the user's data, and sends it to the client as a cookie. On subsequent requests, the browser automatically includes the cookie, allowing the server to look up the session and identify the user without re-authentication."),
    ("What is knowledge distillation in machine learning?", "Knowledge distillation transfers learned representations from a large 'teacher' model to a smaller 'student' model. The student is trained not just on hard labels but on the teacher's soft probability distributions (softmax outputs with temperature scaling), which encode richer inter-class relationships. This produces compact models that retain most of the teacher's accuracy."),
    ("How do I save data to localStorage in the browser?", "Use `localStorage.setItem('key', JSON.stringify(data))` to store and `JSON.parse(localStorage.getItem('key'))` to retrieve. localStorage persists across browser sessions (unlike sessionStorage), has a ~5MB limit per origin, is synchronous and blocking, and should never store sensitive data since it's accessible to any JavaScript on the same origin."),
    ("What is task routing in distributed systems like Celery?", "Task routing in Celery directs tasks to specific worker queues based on task type, priority, or resource requirements. You configure routes in `task_routes` settings mapping task names to queue names, then start workers listening on specific queues with `celery -A app worker -Q queue_name`. This enables workload isolation and prioritization."),
    ("How do I implement a session manager in Express.js?", "Install `express-session` and a store like `connect-redis`. Configure with `app.use(session({ store: new RedisStore({client}), secret: 'your-secret', resave: false, saveUninitialized: false, cookie: { secure: true, httpOnly: true, maxAge: 3600000 } }))`. Access session data via `req.session`. Redis provides persistence and multi-server session sharing."),
    ("Explain memory management in Rust — ownership and borrowing", "Rust enforces memory safety at compile time through three rules: each value has exactly one owner, ownership transfers on assignment (move semantics), and values are dropped when the owner goes out of scope. Borrowing allows references (&T for shared, &mut T for exclusive) without transferring ownership. The borrow checker ensures no dangling pointers or data races."),
    ("What's the best way to save user preferences in React Native?", "Use `@react-native-async-storage/async-storage` for simple key-value preferences: `await AsyncStorage.setItem('theme', 'dark')`. For complex or encrypted data, use `react-native-mmkv` which is significantly faster. For cross-device sync, consider storing preferences in your backend database and caching locally."),
    ("Write a function that searches through a knowledge graph using BFS", "```python\nfrom collections import deque\ndef bfs_knowledge_graph(graph, start, target):\n    visited = set()\n    queue = deque([(start, [start])])\n    while queue:\n        node, path = queue.popleft()\n        if node == target:\n            return path\n        visited.add(node)\n        for neighbor in graph.get(node, []):\n            if neighbor not in visited:\n                queue.append((neighbor, path + [neighbor]))\n    return None\n```"),
    ("How does garbage collection work in Go?", "Go uses a concurrent, tri-color mark-and-sweep garbage collector. It runs concurrently with the application using write barriers to track mutations during marking. Objects are colored white (unmarked), gray (marked but children unchecked), or black (fully scanned). The GC targets a configurable heap growth ratio (GOGC, default 100%) to balance throughput and latency."),
    ("Can you explain the compact representation of sparse matrices?", "Common formats: CSR (Compressed Sparse Row) stores values, column indices, and row pointers — efficient for row slicing and matrix-vector multiplication. CSC (Compressed Sparse Column) is the column analog. COO (Coordinate) stores (row, col, value) triplets — easy to construct but slower for arithmetic. scipy.sparse provides all three."),
    ("What is the health check endpoint pattern in microservices?", "A /health endpoint returns service status (HTTP 200 for healthy, 503 for unhealthy) checking dependencies like database connections, cache availability, and disk space. Liveness probes confirm the process is running; readiness probes confirm it can serve traffic. Kubernetes uses these to manage pod lifecycle and routing decisions automatically."),
    ("How do I export data from PostgreSQL to a CSV file?", "Use `COPY (SELECT * FROM table) TO '/path/file.csv' WITH CSV HEADER;` for server-side export, or `\\copy table TO 'file.csv' WITH CSV HEADER` from psql for client-side. For programmatic export, use `psycopg2` with `copy_expert()`. Add WHERE clauses, column selection, and DELIMITER options as needed."),
    ("Write a bash one-liner to find files larger than 100MB", "`find / -type f -size +100M -exec ls -lh {} \\; 2>/dev/null | sort -k5 -h` — uses find with -size +100M filter, lists with human-readable sizes, sorts by size, and suppresses permission errors. Add `-mtime -7` to limit to files modified in the last week."),
    ("How do you implement a search algorithm for a graph?", "DFS uses a stack (or recursion) for depth-first exploration — good for pathfinding and cycle detection. BFS uses a queue for level-order exploration — guarantees shortest path in unweighted graphs. Dijkstra's extends BFS with a priority queue for weighted graphs. A* adds a heuristic estimate to Dijkstra's for faster goal-directed search."),
    ("Explain how load balancing works across multiple servers", "A load balancer distributes incoming requests across backend servers using algorithms like round-robin, least connections, weighted, or IP hash. Layer 4 (TCP) balancers route at the transport level; Layer 7 (HTTP) balancers can inspect headers, cookies, and URLs for content-based routing. Health checks remove unhealthy servers from rotation automatically."),
    ("What is the difference between stack and heap memory?", "The stack is LIFO, automatically managed, stores local variables and function frames, with fast allocation but fixed size (typically 1-8MB). The heap is dynamically allocated via malloc/new, stores objects with longer lifetimes, has virtually unlimited size but slower allocation and requires explicit or GC-based deallocation. Stack access is cache-friendly."),
    ("How does session replication work in distributed systems?", "Session replication copies session state across multiple servers so any server can handle any request. Approaches: sticky sessions (route to same server), centralized store (Redis/Memcached), peer-to-peer replication (Hazelcast), or cookie-based (encrypted session in cookie). Trade-offs involve memory overhead, consistency guarantees, and failover speed."),
    ("What are database connection pooling strategies?", "Connection pools maintain pre-established database connections for reuse, avoiding the overhead of creating new connections per request. Key parameters: min/max pool size, idle timeout, max lifetime, and connection validation queries. Libraries like HikariCP (Java), pgBouncer (PostgreSQL), and SQLAlchemy's pool provide configurable pooling with health checks."),
    ("Explain the circuit breaker pattern in microservices", "The circuit breaker prevents cascading failures by tracking error rates to downstream services. States: Closed (normal flow), Open (requests fail-fast after threshold), Half-Open (allows test requests). When errors exceed a threshold (e.g., 50% in 10s), the breaker opens, returning fallback responses. After a timeout, it transitions to half-open to test recovery."),
    ("How do I implement WebSocket authentication?", "Authenticate during the HTTP upgrade handshake: send a JWT or session cookie with the initial WebSocket connection request. The server validates the token in the `upgrade` event handler before accepting the connection. For ongoing auth, implement heartbeat messages with token refresh. Close connections with expired tokens using WebSocket close codes (4001 = unauthorized)."),
    ("What is the difference between SQL and NoSQL databases?", "SQL databases (PostgreSQL, MySQL) use structured schemas, ACID transactions, and relational joins — ideal for complex queries and data integrity. NoSQL databases (MongoDB, DynamoDB, Redis) offer flexible schemas, horizontal scaling, and specialized data models (document, key-value, graph, columnar) — ideal for high-throughput, denormalized, or rapidly evolving data."),
    ("How do you implement pagination in a REST API?", "Offset-based: `GET /items?page=2&limit=20` — simple but slow for large offsets (DB must skip N rows). Cursor-based: `GET /items?after=cursor_id&limit=20` — uses an indexed column as cursor, consistent performance regardless of page depth. Return metadata: `{data: [...], meta: {total, next_cursor, has_more}}`."),
    ("Explain the concept of eventual consistency", "Eventual consistency guarantees that if no new updates are made to a data item, all replicas will eventually converge to the same value. It's a relaxation of strong consistency used in distributed systems (DynamoDB, Cassandra) to achieve higher availability and partition tolerance per the CAP theorem. Read-your-writes consistency and causal consistency are common stronger variants."),
    ("What is the difference between monorepo and polyrepo?", "Monorepo stores all projects in a single repository — enables atomic cross-project changes, shared tooling, and easier dependency management. Polyrepo uses separate repositories per project — provides clear ownership boundaries, independent CI/CD, and simpler access control. Tools like Nx, Turborepo, and Bazel make monorepos scalable. Choice depends on team size and coupling."),
    # Targeted: meta-questions that should NOT trigger tools (false positive traps)
    ("What tools do you have available?", "I'm an AI assistant with access to various tools for session memory management, knowledge search, web research, and more. I can help with saving and loading session context, searching through past work, performing web searches, and analyzing research papers. Let me know what you'd like help with and I'll use the appropriate tool."),
    ("Tell me about yourself.", "I'm Prism, an AI coding assistant with persistent memory capabilities. I can remember context across sessions, search through past work, and help with complex coding tasks. My memory system uses session ledgers for audit trails and handoff state for quick context recovery."),
    ("What can you do?", "I can assist with coding, debugging, architecture design, and technical research. I also have persistent memory tools to save and recall session context, knowledge search for finding past work, and web search capabilities for current information. I'm optimized for developer workflows and technical problem-solving."),
    ("Who are you?", "I'm an AI assistant designed for software development workflows. I have capabilities for code generation, debugging, technical analysis, and persistent memory management. I can maintain context across conversations and help with complex multi-session projects."),
    ("What are your capabilities?", "My core capabilities include: code generation and review, debugging assistance, architecture design, technical documentation, persistent session memory (save/load/search), knowledge graph traversal, web research, and academic paper analysis. I'm designed for developer productivity."),
    ("Help me understand what you can do.", "I help with software development tasks including writing code, debugging issues, designing architectures, and technical research. I also maintain persistent memory across sessions so I can recall past decisions, track TODOs, and build on previous work without losing context."),
    ("List your available features.", "Key features: 1) Code generation and review, 2) Session memory with save/load/search, 3) Knowledge search across past sessions, 4) Web and local search, 5) Visual memory for screenshots, 6) Task routing for delegation, 7) Experience tracking for behavioral learning, 8) GDPR-compliant data export and deletion."),
    ("What kind of assistant are you?", "I'm a developer-focused AI assistant with persistent memory. Unlike stateless chatbots, I can remember your project context across sessions, track decisions and TODOs, and build up domain knowledge over time. I'm particularly suited for complex, multi-session software projects."),
    ("Are you an AI?", "Yes, I'm an AI assistant specialized in software development. I use large language models for reasoning and code generation, augmented with persistent memory tools that let me maintain context across conversations and learn from past interactions."),
    ("What model are you based on?", "I'm built on top of a large language model, augmented with Prism's persistent memory system for cross-session continuity. My exact model architecture may vary, but I'm optimized for code generation, technical reasoning, and tool-use accuracy in developer workflows."),
    ("Hi there, how are you?", "Hello! I'm doing well, thank you for asking. I'm ready to help with any coding, technical questions, or project work you have. What can I assist you with today?"),
    ("Hello!", "Hi there! Welcome. I'm ready to help with coding, debugging, architecture questions, or any technical task. What would you like to work on?"),
    ("What's your name?", "I'm Prism, an AI assistant designed for software development workflows with persistent memory capabilities. I can help with coding, technical research, and maintaining project context across sessions."),
    ("How does your memory system work?", "Prism's memory system has two layers: session ledgers (append-only audit trail of work done per conversation) and handoff state (live project context for quick resume). Knowledge search uses both keyword and semantic embedding search. Entries can be upvoted to become graduated insights that always surface."),
    ("Explain how Prism MCP tools work.", "Prism exposes its capabilities through the Model Context Protocol (MCP). Each tool is a function the agent can call — like session_save_ledger for logging work, session_load_context for recovering state, knowledge_search for finding past decisions, and session_save_experience for behavioral learning. The MCP server handles persistence and embedding generation."),
    ("What is session memory?", "Session memory in Prism stores a structured log of each conversation: what was accomplished, decisions made, files changed, and remaining TODOs. It's persisted as immutable ledger entries and searchable via both keyword and semantic similarity. The handoff state provides a quick-resume snapshot of the current project context."),
    ("What is the knowledge search feature?", "Knowledge search in Prism lets you find past work across all sessions using either keyword matching (FTS5) or semantic similarity (vector embeddings). Results include session summaries, decisions, and file changes. Spreading activation can discover structurally related memories beyond direct matches."),
    ("How do I use the health check?", "The health check tool (`session_health_check`) scans for missing embeddings, duplicate entries, orphaned handoffs, and stale rollups. Run with `auto_fix=true` to automatically repair issues like backfilling missing embeddings and cleaning up orphans. It's like fsck for your memory database."),
    ("Describe the export functionality.", "Prism's export tool (`session_export_memory`) supports three formats: JSON (machine-readable for import into another Prism instance), Markdown (human-readable for archiving), and Vault (Obsidian-compatible .zip with YAML frontmatter and wikilinks). It exports ledger entries, handoff state, and visual memory index."),
    ("What tools are available for session management?", "Session management tools include: session_save_ledger (log work), session_save_handoff (preserve project state), session_load_context (resume from last session), session_search_memory (semantic search), session_compact_ledger (merge old entries), memory_history/memory_checkout (time travel), and session_forget_memory (delete entries)."),
    # More keyword traps
    ("Explain the CAP theorem in simple terms", "The CAP theorem states that a distributed system can guarantee at most two of three properties: Consistency (all nodes see the same data), Availability (every request gets a response), and Partition tolerance (system works despite network splits). Since partitions are inevitable, you typically choose between CP (consistent but may reject requests) or AP (available but may serve stale data)."),
    ("What is knowledge representation in AI?", "Knowledge representation is how AI systems encode real-world information for reasoning. Common approaches include semantic networks (graph-based), frames (structured records), ontologies (hierarchical taxonomies like OWL), first-order logic (formal predicates), and knowledge graphs (entities + relationships). Modern systems often use embedding vectors for neural knowledge representation."),
    ("How do I handle session expiry in a web app?", "Implement server-side TTL on session records (e.g., Redis EXPIRE), set cookie maxAge/expires attributes, and handle expiry gracefully in middleware by redirecting to login. Use sliding expiration (reset TTL on activity) for UX. For SPAs, implement token refresh flows and show a 'session expired' modal before redirect."),
    ("What are the best practices for saving state in Redux?", "Use Redux Toolkit's `createSlice` for reducer boilerplate. Normalize nested data with `createEntityAdapter`. Keep state minimal and serializable — derive computed values with `createSelector` (memoized). Use `redux-persist` for localStorage persistence. Split large stores into feature slices. Avoid storing UI-only state in Redux — keep it in component state."),
    ("How do you implement a health check endpoint in Express?", "```javascript\napp.get('/health', async (req, res) => {\n  const checks = { db: false, cache: false };\n  try { await db.query('SELECT 1'); checks.db = true; } catch(e) {}\n  try { await redis.ping(); checks.cache = true; } catch(e) {}\n  const healthy = Object.values(checks).every(Boolean);\n  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });\n});\n```"),
    ("What is task routing in Apache Airflow?", "Airflow routes tasks to specific executor pools and queues. Use `queue='gpu'` on task decorator to route to GPU workers. Pools limit concurrent task slots: `pool='db_pool'` with `pool_slots=1` prevents DB overload. The CeleryExecutor distributes tasks across workers listening on specific queues. Task priority_weight controls scheduling order."),
    ("How do I export modules in TypeScript?", "Use `export` for named exports: `export function foo() {}` or `export { foo, bar }`. Use `export default` for the primary export. Import with `import { foo } from './module'` or `import MyDefault from './module'`. Re-export with `export { foo } from './other'`. Use `export type` for type-only exports to enable tree-shaking."),
    ("What is memory-safe programming?", "Memory-safe programming prevents bugs like buffer overflows, use-after-free, and null pointer dereferences. Languages achieve this through garbage collection (Java, Go, Python), ownership systems (Rust's borrow checker), or managed runtimes (.NET CLR). Memory-unsafe languages (C, C++) require manual management and are prone to security vulnerabilities (CVEs)."),
    ("How do I compact a MongoDB collection?", "Run `db.runCommand({compact: 'collection_name'})` to defragment and reclaim disk space. This blocks the collection during compaction. For WiredTiger, it rewrites data files. In production, use `compact` during maintenance windows. For sharded clusters, run on each shard individually. Consider `--repair` for standalone instances."),
    ("Explain context switching in operating systems", "Context switching saves the CPU state (registers, program counter, stack pointer) of the current process/thread and loads the state of the next one. Triggered by timer interrupts (preemptive), system calls, or I/O waits. Each switch costs 1-10 microseconds plus cache invalidation overhead. Threads switch faster than processes since they share address space."),
    # Targeted: "session manager" / "session" in framework context (FP fix)
    ("How do I implement a session manager in Express.js with Redis?", "Install express-session and connect-redis. Configure: `app.use(session({ store: new RedisStore({client: redisClient}), secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: {secure: true, httpOnly: true, sameSite: 'strict', maxAge: 86400000} }))`. Use `req.session.userId = user.id` to set and `req.session.destroy()` to invalidate."),
    ("What is session management in Django?", "Django's session framework stores data server-side (database, cache, or file) and sends a session ID cookie. Enable with `django.contrib.sessions` middleware. Access via `request.session['key'] = value`. Configure backend with SESSION_ENGINE (db, cache, cached_db, file). Set SESSION_COOKIE_AGE for expiry. Use `flush()` to clear on logout."),
    ("How do I set up session middleware in Flask?", "Flask has built-in client-side sessions using signed cookies. Set `app.secret_key` for signing. Use `session['key'] = value` to store data. For server-side sessions, install Flask-Session: `Session(app)` with `SESSION_TYPE='redis'` or 'filesystem'. Server-side is more secure for sensitive data since cookies have size limits."),
    ("How do I create a session in PHP using session_start()?", "Call `session_start()` at the beginning of every page before any output. Set values with `$_SESSION['key'] = 'value'`. Read with `$_SESSION['key']`. Destroy with `session_destroy()`. Configure in php.ini: session.gc_maxlifetime for TTL, session.cookie_httponly and session.cookie_secure for security. Use session_regenerate_id() after login to prevent fixation."),
    ("What is session affinity in load balancing?", "Session affinity (sticky sessions) routes all requests from the same client to the same backend server, typically using source IP hash or a cookie. This ensures the server has the session data in local memory. Downsides: uneven load distribution, failover issues (session lost if server dies). Alternative: externalize sessions to Redis/Memcached for stateless backends."),
    ("How do I manage user sessions in a microservices architecture?", "Externalize session state to a shared store (Redis, DynamoDB) accessible by all services. Use JWTs for stateless auth — embed claims in the token to avoid session lookups. For sensitive operations, combine JWTs with a server-side session blacklist. Use an API gateway for centralized auth, and propagate user context via request headers between services."),
    ("What is the difference between session-based and token-based auth?", "Session-based: server stores state, sends session ID cookie, requires server-side lookup per request — simpler but harder to scale. Token-based (JWT): server signs a token, client stores and sends it, server verifies signature statelessly — scales well but tokens can't be revoked without a blacklist. Sessions are better for server-rendered apps; tokens for SPAs and APIs."),
    # Targeted: conversational closings (FP fix)
    ("Thanks, that's all for now.", "You're welcome! If you need help with anything else in the future, feel free to come back. Have a great day!"),
    ("Goodbye!", "Goodbye! It was great helping you. Don't hesitate to reach out whenever you need assistance with coding or any technical questions. Take care!"),
    ("I'm done, thanks for the help.", "Happy to help! Good luck with your project. If you run into any issues or need further assistance, I'm always here. See you next time!"),
    ("That's it for today, thank you.", "You're welcome! Great work today. I'll remember the context from this session so we can pick up right where we left off next time. Have a good one!"),
    ("OK, we're finished.", "Sounds good! Everything from this session is saved. When you're ready to continue, I'll have the full context ready to go. Take care!"),
    # Targeted: "context manager" / "context" in programming context (FP fix — HEAVY)
    ("Write me a Python context manager for database connections.", "```python\nimport contextlib\nimport psycopg2\n\n@contextlib.contextmanager\ndef db_connection(dsn):\n    conn = psycopg2.connect(dsn)\n    try:\n        yield conn\n        conn.commit()\n    except Exception:\n        conn.rollback()\n        raise\n    finally:\n        conn.close()\n```\nUsage: `with db_connection(DSN) as conn: conn.execute(query)`"),
    ("How do I create a context manager using __enter__ and __exit__?", "Implement a class with `__enter__` (returns the resource) and `__exit__` (handles cleanup). `__exit__` receives exc_type, exc_val, exc_tb — return True to suppress exceptions, False to propagate. Example:\n```python\nclass Timer:\n    def __enter__(self):\n        self.start = time.time()\n        return self\n    def __exit__(self, *args):\n        self.elapsed = time.time() - self.start\n```"),
    ("Explain Python's contextlib module.", "contextlib provides utilities for context managers: `@contextmanager` decorator converts a generator function into a CM, `closing()` auto-closes objects, `suppress()` ignores specified exceptions, `redirect_stdout/stderr()` captures output, `ExitStack` manages dynamic CM stacks, and `asynccontextmanager` for async CMs. It reduces boilerplate vs writing __enter__/__exit__."),
    ("How does context switching work in operating systems?", "The OS saves the current process's CPU state (registers, program counter, stack pointer, memory mappings) to its Process Control Block (PCB), then loads the next process's PCB state into the CPU. Triggers: timer interrupt (time-slice expired), I/O wait, system call, or higher-priority process. Cost: 1-10μs plus TLB/cache flush overhead."),
    ("What is execution context in JavaScript?", "An execution context is the environment where JS code runs. It contains: variable environment (let/const), lexical environment (scope chain), and `this` binding. Types: Global (created at startup), Function (created per function call), and Eval. The call stack manages nested contexts. Closures capture the lexical environment of their outer context."),
    ("Write a Python context manager that handles file locking.", "```python\nimport fcntl\nimport contextlib\n\n@contextlib.contextmanager\ndef file_lock(path):\n    f = open(path, 'w')\n    try:\n        fcntl.flock(f.fileno(), fcntl.LOCK_EX)\n        yield f\n    finally:\n        fcntl.flock(f.fileno(), fcntl.LOCK_UN)\n        f.close()\n```\nUsage: `with file_lock('/tmp/app.lock') as f: do_critical_section()`"),
    ("How do I use contextlib.contextmanager decorator?", "Write a generator function that yields exactly once. Code before yield is __enter__, code after is cleanup (__exit__). Wrap with @contextmanager:\n```python\nfrom contextlib import contextmanager\n@contextmanager\ndef managed_resource(name):\n    resource = acquire(name)\n    try:\n        yield resource\n    finally:\n        release(resource)\n```"),
    ("Explain the difference between a context manager and a decorator in Python.", "A context manager (with statement) manages resource lifecycle within a block — setup on enter, cleanup on exit. A decorator wraps a function to modify its behavior. They differ in scope: CMs wrap arbitrary code blocks, decorators wrap function definitions. They can overlap: `@contextmanager` is a decorator that creates a CM, and CMs can be used as decorators via `ContextDecorator`."),
    ("Write a context manager for managing database transactions.", "```python\nfrom contextlib import contextmanager\n@contextmanager\ndef transaction(conn):\n    cursor = conn.cursor()\n    try:\n        yield cursor\n        conn.commit()\n    except Exception:\n        conn.rollback()\n        raise\n    finally:\n        cursor.close()\n```\nUsage: `with transaction(conn) as cur: cur.execute('INSERT INTO ...')`"),
    ("How do I create an async context manager in Python?", "Use `@asynccontextmanager` from contextlib or implement `__aenter__` and `__aexit__`:\n```python\nfrom contextlib import asynccontextmanager\n@asynccontextmanager\nasync def async_db(dsn):\n    conn = await asyncpg.connect(dsn)\n    try:\n        yield conn\n    finally:\n        await conn.close()\n```\nUsage: `async with async_db(DSN) as conn: await conn.fetch(query)`"),
    ("What is a browser rendering context?", "A rendering context is the drawing surface for a canvas element. `canvas.getContext('2d')` returns a CanvasRenderingContext2D for 2D drawing (paths, shapes, text, images). `canvas.getContext('webgl')` returns a WebGLRenderingContext for GPU-accelerated 3D graphics. `canvas.getContext('webgpu')` is the newer API. Each canvas can have only one context type."),
    ("Explain React context API vs Redux for state management.", "React Context (createContext + useContext) is built-in and ideal for low-frequency updates like themes, locale, and auth state. It re-renders all consumers on any change. Redux uses a single store with reducers, supports middleware (thunks, sagas), and enables fine-grained subscriptions via selectors. Use Context for simple global state; Redux for complex, frequently-updated state with devtools needs."),
    ("Write a context manager that times code execution.", "```python\nimport time\nfrom contextlib import contextmanager\n@contextmanager\ndef timer(label='Block'):\n    start = time.perf_counter()\n    try:\n        yield\n    finally:\n        elapsed = time.perf_counter() - start\n        print(f'{label}: {elapsed:.4f}s')\n```\nUsage: `with timer('DB query'): result = db.query(sql)` prints 'DB query: 0.0234s'"),
    ("How does OpenGL rendering context work?", "An OpenGL context encapsulates all rendering state: shaders, textures, buffers, framebuffers, and pipeline settings. Created via platform APIs (WGL on Windows, GLX on Linux, EGL cross-platform). Each thread can have one current context. Context sharing allows multiple contexts to access the same GPU resources. Modern apps use GLFW or SDL for context creation."),
    ("What is the difference between context manager and try/finally in Python?", "Context managers are try/finally with reusable abstractions. try/finally is inline and one-off. CMs encapsulate resource management into reusable classes or functions, reducing boilerplate. CMs also handle exception info via __exit__ parameters and can suppress exceptions. The `with` statement is syntactic sugar that guarantees cleanup even if exceptions occur, just like finally."),
    # Targeted: "forget gate" / "forget" in ML/academic context (FP fix — HEAVY)
    ("What is the forget gate in an LSTM neural network?", "The forget gate is a sigmoid layer that controls how much of the previous cell state to retain. It takes the previous hidden state h_{t-1} and current input x_t, computing f_t = σ(W_f·[h_t-1, x_t] + b_f). Output values near 0 mean 'forget this information', near 1 means 'keep it'. This enables LSTMs to learn long-term dependencies by selectively retaining relevant information."),
    ("Explain how LSTM forget gates control information flow.", "The forget gate acts as a learned filter on the cell state memory highway. At each timestep, it computes a value between 0 and 1 for each dimension of the cell state. This is element-wise multiplied with the previous cell state: C_t = f_t ⊙ C_{t-1} + i_t ⊙ C̃_t. This allows the network to gradually decay irrelevant memories while preserving important long-range signals."),
    ("What is catastrophic forgetting in neural networks?", "Catastrophic forgetting occurs when a neural network trained on new tasks loses performance on previously learned tasks because gradient updates overwrite the weights encoding earlier knowledge. It's a fundamental challenge in continual learning. Mitigation strategies include elastic weight consolidation (EWC), progressive neural networks, experience replay, and knowledge distillation."),
    ("How do I implement an LSTM with forget bias in PyTorch?", "```python\nimport torch.nn as nn\nlstm = nn.LSTM(input_size=128, hidden_size=256, num_layers=2, batch_first=True)\n# Set forget bias to 1.0 for better gradient flow\nfor name, param in lstm.named_parameters():\n    if 'bias' in name:\n        n = param.size(0)\n        param.data[n//4:n//2].fill_(1.0)  # forget gate bias\n```\nSetting forget bias to 1 helps the network remember by default, only learning to forget when necessary."),
    ("Explain the role of the forget gate in GRU vs LSTM.", "GRUs combine the forget and input gates into a single 'update gate' z_t. In LSTMs, the forget gate f_t and input gate i_t operate independently on the cell state. GRU's update gate: h_t = z_t ⊙ h_{t-1} + (1-z_t) ⊙ h̃_t — what's forgotten is directly replaced. This makes GRUs simpler (fewer parameters) but less expressive than LSTMs for complex temporal patterns."),
    ("What is continual learning and how does it address catastrophic forgetting?", "Continual learning trains models sequentially on new tasks without forgetting old ones. Three main approaches: 1) Regularization (EWC, SI) — penalize changes to important weights. 2) Replay — store or generate examples from past tasks. 3) Architecture — dynamically expand the network (progressive nets) or mask subnetworks per task (PackNet). Goal: achieve plasticity-stability balance."),
    ("How do I tune the forget bias in TensorFlow LSTM layers?", "In TensorFlow/Keras, use `tf.keras.layers.LSTM(units, unit_forget_bias=True)` which initializes the forget gate bias to 1.0 (default). For custom values, subclass the layer and override `build()` to set `self.bias[self.units:2*self.units]` to your desired value. Higher forget bias (1.0-2.0) helps preserve long-term dependencies."),
    ("What is the forget gate activation function in an LSTM cell?", "The forget gate uses a sigmoid (logistic) activation: f_t = σ(W_f·[h_{t-1}, x_t] + b_f). Sigmoid squashes output to [0,1], acting as a soft gate — 0 completely forgets, 1 completely retains. This is differentiable, enabling gradient-based learning. The bias is typically initialized to 1.0 (Jozefowicz et al., 2015) to prevent early forgetting."),
    ("Explain elastic weight consolidation for preventing forgetting.", "EWC (Kirkpatrick et al., 2017) adds a regularization term that penalizes changes to weights important for previous tasks: L_total = L_new + λ/2 Σ F_i(θ_i - θ*_i)². F_i is the Fisher Information Matrix diagonal, measuring each weight's importance. This slows learning on critical weights while allowing free parameters to adapt to new tasks."),
    ("How do LSTM forget gates differ from attention mechanisms?", "Forget gates are local, per-timestep filters on the cell state — they decide what to retain from the immediate previous state. Attention mechanisms are global, computing relevance scores across the entire sequence to directly access any past hidden state. Forget gates enable gradual information decay; attention enables direct long-range access. Transformers replaced LSTMs by using only attention."),
    ("Write a PyTorch LSTM cell with a custom forget gate.", "```python\nclass CustomLSTMCell(nn.Module):\n    def __init__(self, input_sz, hidden_sz):\n        super().__init__()\n        self.W = nn.Linear(input_sz + hidden_sz, 4 * hidden_sz)\n    def forward(self, x, state):\n        h, c = state\n        gates = self.W(torch.cat([x, h], dim=-1))\n        i, f, g, o = gates.chunk(4, dim=-1)\n        f = torch.sigmoid(f + 1.0)  # forget bias=1\n        i, o = torch.sigmoid(i), torch.sigmoid(o)\n        c_new = f * c + i * torch.tanh(g)\n        h_new = o * torch.tanh(c_new)\n        return h_new, c_new\n```"),
    ("What is progressive neural network approach to avoiding forgetting?", "Progressive networks (Rusu et al., 2016) freeze all parameters after each task and add new lateral columns for subsequent tasks. Each new column receives lateral connections from all previous columns, enabling knowledge transfer without overwriting. Zero forgetting by design, but model size grows linearly with tasks. Best for few-task scenarios with high transfer potential."),
    ("Explain the forget gate equation: f_t = sigmoid(W_f * [h_t-1, x_t] + b_f)", "The equation computes: 1) Concatenate previous hidden state h_{t-1} and current input x_t into [h_{t-1}, x_t]. 2) Multiply by weight matrix W_f (learned during training). 3) Add bias b_f (typically initialized to 1.0). 4) Apply sigmoid to squash to [0,1]. Each dimension independently decides how much to retain. Multiple forget gates across hidden dimensions enable selective memory retention."),
    ("How does the forget gate interact with the cell state in LSTM?", "The cell state update is: C_t = f_t ⊙ C_{t-1} + i_t ⊙ C̃_t. The forget gate f_t element-wise multiplies the previous cell state, selectively erasing information. Then the input gate i_t controls how much of the candidate state C̃_t (from tanh layer) to add. This additive structure creates a gradient highway that mitigates vanishing gradients, enabling learning over 100+ timesteps."),
    ("What is knowledge distillation for preventing catastrophic forgetting?", "In continual learning, knowledge distillation (Hinton et al., 2015) uses the old model as a teacher for the current model on new tasks. The loss combines: 1) hard labels for the new task, and 2) KL-divergence between student and teacher soft outputs on old task data. This 'dark knowledge' preserves learned inter-class relationships without storing old training data. LwF (Li & Hoiem, 2016) popularized this approach."),
]


# Disambiguation reasoning templates per tool
DISAMBIGUATION_THINK = {
    "session_forget_memory": [
        "The user wants to delete a SPECIFIC memory entry. For deleting individual entries by ID, I use session_forget_memory. knowledge_forget is for BULK deletion by project/category/age — that's not what the user wants here.",
        "This is about removing one particular entry. session_forget_memory handles specific entry deletion. knowledge_forget is for wiping entire categories — wrong tool for this.",
        "The user wants to nuke a specific entry. I need session_forget_memory (deletes by memory_id), NOT knowledge_forget (deletes by project/category).",
    ],
    "knowledge_forget": [
        "The user wants to bulk delete entries by project or category or age. knowledge_forget handles bulk deletion. session_forget_memory is for deleting ONE specific entry by ID — that's not what's needed here.",
    ],
    "session_save_ledger": [
        "The user wants to save/log/record what was accomplished. session_save_ledger is for logging work done. session_save_handoff is for transferring state to the next agent — that's not what's needed.",
        "This is a request to record session work. I use session_save_ledger for logging accomplishments, NOT session_save_handoff which is for handoff/transfer.",
        "The user wants to save what we did. session_save_ledger logs work. session_save_handoff passes state to another agent. This is clearly a save/log request.",
    ],
    "session_save_handoff": [
        "The user wants to hand off work to another agent/session. session_save_handoff transfers state. session_save_ledger just logs — the user explicitly wants a handoff.",
        "This is about passing the baton to another session or agent. I need session_save_handoff, not session_save_ledger which is just for recording work.",
    ],
    "session_load_context": [
        "The user wants to load/resume context for a project. I should use session_load_context.",
        "This is a request to start a session and load previous project state. session_load_context is the right tool.",
    ],
    "session_search_memory": [
        "The user wants to search through past session history. session_search_memory does semantic search over past conversations.",
        "This is a memory search request — the user wants to find past discussions or decisions. session_search_memory is correct.",
    ],
    "knowledge_search": [
        "The user wants to search the knowledge base for accumulated insights. knowledge_search queries curated knowledge items, not raw session history.",
        "This is about searching institutional knowledge. knowledge_search looks through curated KIs, which is what's needed.",
    ],
    "knowledge_set_retention": [
        "The user wants to SET a retention policy / TTL / auto-expire rule. This CONFIGURES when entries expire — it does NOT delete anything right now. I need knowledge_set_retention, NOT knowledge_forget (which immediately deletes entries).",
        "This is about configuring auto-expiry, not deleting. knowledge_set_retention sets a TTL policy. knowledge_forget performs immediate bulk deletion — completely different.",
        "Setting a retention policy means configuring future auto-cleanup. The right tool is knowledge_set_retention (sets TTL). knowledge_forget would immediately delete — that's not what the user wants.",
    ],
    "session_save_image": [
        "The user wants to save/store an image or screenshot to visual memory. I need session_save_image which stores images in the visual memory vault. session_save_handoff is for passing state to the next agent — not for images.",
        "This is about persisting an image file. session_save_image handles visual memory (screenshots, diagrams). session_save_handoff and session_save_ledger are for text-based state — wrong tools for images.",
        "The user wants to store a visual (image/screenshot/diagram). session_save_image is the only tool that handles file-based visual memory. session_save_handoff is for agent state transfer, not images.",
    ],
    "session_view_image": [
        "The user wants to view/retrieve a previously saved image from visual memory. session_view_image fetches the image by ID.",
        "This is about retrieving a stored image. session_view_image returns the image content from the visual memory vault.",
    ],
}

# Generic fallback think templates for tools without specific disambiguation
GENERIC_THINK = [
    "The user wants me to use the {tool_name} tool. This is the right tool for this request.",
    "I should use {tool_name} for this request.",
    "This requires calling the {tool_name} tool.",
]

# Reasoning think templates with keyword awareness
REASONING_THINK = [
    "This is a general knowledge question. I should answer directly without using any tools.",
    "This doesn't require any Prism MCP tools. I'll answer from my knowledge.",
    "No tools needed — this is a coding/knowledge question I can answer directly.",
    "I should answer this directly. No tool call is appropriate here.",
    "This is a standard technical question. No MCP tools needed.",
    # Keyword-aware disambiguation (prevents false positives)
    "Although this mentions 'session', it's asking about a general programming concept, not about Prism session management. I answer directly.",
    "The word 'memory' here refers to computer memory/RAM, not Prism's session memory system. No tool needed.",
    "This mentions 'save' but it's about saving data in an application, not about saving Prism session state. No tool.",
    "This mentions 'search' but it's about implementing search algorithms, not about searching Prism's memory. No tool.",
    "This mentions 'health check' but it's about the microservices pattern, not Prism's memory health check. No tool.",
    "This is asking ABOUT my tools/capabilities — it's a meta-question. I describe them, I don't call them.",
    "The user is greeting me or asking who I am. This is a conversational exchange, not a tool request.",
    "This mentions 'export' but it's about exporting data in a programming context, not Prism memory export. No tool.",
    "The user asks about 'knowledge' in an AI/academic context. This is not a request to search Prism's knowledge base.",
    "This mentions 'compact' but it's about data structures, not Prism ledger compaction. No tool.",
    "This mentions 'context' but it's about OS context switching, not loading Prism project context. No tool.",
    "This mentions 'task routing' but it's about distributed systems, not Prism's session_task_route. No tool.",
    # Pattern: session manager / session in framework context
    "This asks about implementing a session manager in a web framework like Express.js, Django, or Flask. This is general web development — NOT a request to use Prism's session_load_context tool. I answer directly.",
    # Pattern: conversational closings
    "The user is saying goodbye, thanking me, or indicating they're done. This is a conversational closing — NOT a request to save a handoff or ledger entry. No tool needed.",
    # Pattern: context manager (Python) — not Prism context loading
    "This asks about Python context managers (__enter__/__exit__, contextlib). This is about Python language features, NOT about loading Prism project context. No tool.",
    # Pattern: forget gate (LSTM/ML) — not Prism memory deletion
    "This asks about the forget gate in LSTM networks or catastrophic forgetting in ML. This is machine learning theory, NOT a request to delete Prism memory entries. No tool.",
]


def build_completion(tool_name, args, default_args):
    """Build a properly formatted tool-call completion with disambiguation CoT."""
    merged = {**default_args, **args}
    # Always include required fields for specific tools
    if tool_name == "session_load_context":
        merged.setdefault("level", "deep")
        merged.setdefault("toolAction", "Loading context")
        merged.setdefault("toolSummary", "Loading project context")
    elif tool_name == "session_save_ledger":
        merged.setdefault("conversation_id", "current")
    
    tool_json = json.dumps({"name": tool_name, "arguments": merged})
    
    # Use disambiguation reasoning if available, else generic
    if tool_name in DISAMBIGUATION_THINK:
        think = random.choice(DISAMBIGUATION_THINK[tool_name])
    else:
        think = random.choice(GENERIC_THINK).format(tool_name=tool_name)
    
    return f"<|synalux_think|>\n{think}\n</|synalux_think|>\n\n{TOOL_CALL_OPEN}\n{tool_json}\n{TOOL_CALL_CLOSE}"


def build_reasoning_completion(prompt, answer):
    """Build a reasoning-only completion with keyword-aware CoT."""
    prompt_lower = prompt.lower()
    
    # Select keyword-aware think block when prompt contains tool-like keywords
    keyword_thinks = []
    if 'session' in prompt_lower and 'prism' not in prompt_lower:
        keyword_thinks.append(REASONING_THINK[5])  # session disambiguation
    if 'memory' in prompt_lower and 'prism' not in prompt_lower:
        keyword_thinks.append(REASONING_THINK[6])  # memory disambiguation
    if 'save' in prompt_lower and 'prism' not in prompt_lower:
        keyword_thinks.append(REASONING_THINK[7])  # save disambiguation
    if 'search' in prompt_lower and 'prism' not in prompt_lower:
        keyword_thinks.append(REASONING_THINK[8])  # search disambiguation
    if 'health check' in prompt_lower and 'prism' not in prompt_lower:
        keyword_thinks.append(REASONING_THINK[9])  # health check disambiguation
    if any(w in prompt_lower for w in ['tool', 'capability', 'feature', 'available', 'can you do']):
        keyword_thinks.append(REASONING_THINK[10])  # meta-question
    if any(w in prompt_lower for w in ['hello', 'hi ', 'who are you', 'your name', 'about yourself', 'are you']):
        keyword_thinks.append(REASONING_THINK[11])  # greeting
    if 'export' in prompt_lower and 'prism' not in prompt_lower:
        keyword_thinks.append(REASONING_THINK[12])  # export disambiguation
    if 'knowledge' in prompt_lower and 'prism' not in prompt_lower:
        keyword_thinks.append(REASONING_THINK[13])  # knowledge disambiguation
    if 'compact' in prompt_lower and 'prism' not in prompt_lower:
        keyword_thinks.append(REASONING_THINK[14])  # compact disambiguation
    if 'context' in prompt_lower and 'prism' not in prompt_lower:
        keyword_thinks.append(REASONING_THINK[15])  # context disambiguation
    if 'task rout' in prompt_lower and 'prism' not in prompt_lower:
        keyword_thinks.append(REASONING_THINK[16])  # task routing disambiguation
    if any(w in prompt_lower for w in ['session manager', 'session_start', 'session middleware', 'session affinity']):
        keyword_thinks.append(REASONING_THINK[17])  # session-in-framework
    if any(w in prompt_lower for w in ['thanks', 'goodbye', 'done', 'finished', 'that\'s all', 'that\'s it']):
        keyword_thinks.append(REASONING_THINK[18])  # conversational closing
    if any(w in prompt_lower for w in ['context manager', 'contextlib', '__enter__', '__exit__', 'execution context']):
        keyword_thinks.append(REASONING_THINK[19])  # context manager (Python)
    if any(w in prompt_lower for w in ['forget gate', 'lstm', 'catastrophic forgetting', 'forget bias']):
        keyword_thinks.append(REASONING_THINK[20])  # forget gate (ML)
    
    if keyword_thinks:
        think = random.choice(keyword_thinks)
    else:
        think = random.choice(REASONING_THINK[:5])  # generic no-tool
    
    # R20-fix: Use provided answer to avoid mode collapse from static/topic-only preamble
    return f"<|synalux_think|>\n{think}\n</|synalux_think|>\n<|synalux_answer|>{answer}</|synalux_answer|>"



# ============================================================================
# EXPERIMENT 1: Proactive Clarification (Human-in-the-Loop)
# ============================================================================
# In benchmarks, models guess params. In production, guessing a memory_id
# for session_forget_memory DELETES USER DATA. Train the model to ask.

CLARIFICATION_TRACES = [
    # Destructive action without ID
    {
        "user": "Nuke the last memory entry.",
        "think": "The user wants to delete a memory, but didn't provide the memory ID. "
                 "session_forget_memory requires a memory_id (UUID). This is a destructive action — "
                 "I must NEVER guess a memory ID. I need to ask for confirmation with the specific entry.",
        "response": "<|synalux_answer|>I can delete a memory entry, but I need to confirm which one. "
                    "Could you provide the memory ID? You can find it by running a memory search first."
                    "</|synalux_answer|>",
    },
    # Ambiguous project delete
    {
        "user": "Forget everything about that old project.",
        "think": "The user wants to use knowledge_forget to clear a project's history, but didn't specify "
                 "which project. This is irreversible. I must confirm the project name before proceeding.",
        "response": "<|synalux_answer|>I can clear a project's memory, but this is permanent. "
                    "Which project did you mean? And would you like a dry run first to see what would be deleted?"
                    "</|synalux_answer|>",
    },
    # Missing required param — conversation_id
    {
        "user": "Save the ledger.",
        "think": "The user wants to save a session ledger entry, but session_save_ledger requires a summary "
                 "of what was accomplished. The user gave no summary. I should ask what to record rather than "
                 "saving an empty entry.",
        "response": "<|synalux_answer|>Sure! What should I record as the summary for this session? "
                    "For example: 'Fixed auth bug' or 'Implemented user profiles'.</|synalux_answer|>",
    },
    # Destructive with wrong type hint
    {
        "user": "Hard delete memory John.",
        "think": "The user wants a hard delete (irreversible) of a memory entry. 'John' is not a valid UUID — "
                 "session_forget_memory requires a UUID like '550e8400-e29b-41d4-a716-446655440000'. "
                 "I must not attempt to search and guess. I need the exact ID.",
        "response": "<|synalux_answer|>Hard delete is irreversible. I need the exact memory UUID, not a name. "
                    "Try searching first: I can search for entries related to 'John' and show you the IDs."
                    "</|synalux_answer|>",
    },
    # Bulk action without scope
    {
        "user": "Clean up all the old sessions.",
        "think": "The user wants to compact or forget old sessions, but hasn't specified which project, "
                 "how old is 'old', or whether they want compaction (summary) vs deletion. "
                 "I need to ask for scope before proceeding with any destructive operation.",
        "response": "<|synalux_answer|>I can help clean up! A few questions:\n"
                    "1. Which project? Or all projects?\n"
                    "2. How old — older than 30 days? 90 days?\n"
                    "3. Do you want to compact (summarize and archive) or permanently delete?"
                    "</|synalux_answer|>",
    },
    # Ambiguous retention policy
    {
        "user": "Set retention to like... a month or something.",
        "think": "The user wants to set a retention policy with knowledge_set_retention, but 'a month or something' "
                 "is vague. The tool requires an exact ttl_days integer (minimum 7). I should confirm 30 days "
                 "and the project name.",
        "response": "<|synalux_answer|>I'll set a 30-day retention policy. Which project should this apply to? "
                    "And just to confirm — entries older than 30 days will be automatically archived."
                    "</|synalux_answer|>",
    },
]


# ============================================================================
# EXPERIMENT 2: Think-to-Self-Correct Traces
# ============================================================================
# Real reasoning is non-linear. The model should catch its own mistakes
# inside the think block BEFORE emitting the wrong tool call.

SELF_CORRECTION_TRACES = [
    # Tool confusion: save vs handoff
    {
        "user": "Pass the billing module to the QA team for review.",
        "think": "The user wants to save this session... Wait, looking more carefully at the prompt, "
                 "they said 'pass to QA team'. That makes this a handoff between agents, not a session save. "
                 "I should use session_save_handoff, not session_save_ledger. The from_agent would be the "
                 "current role and to_agent would be 'qa'.",
        "tool": "session_save_handoff",
        "args": {"project": "billing-portal", "key_context": "Billing module ready for QA review"},
    },
    # Tool confusion: search vs load
    {
        "user": "What was the last thing we did on the analytics project?",
        "think": "The user wants to load context... Actually no, they're asking about past work, not "
                 "trying to resume. This is a search/recall operation, not a context load. I should use "
                 "session_search_memory to find recent sessions, not session_load_context.",
        "tool": "session_search_memory",
        "args": {"query": "last work on analytics project"},
    },
    # Keyword trap: 'context manager' → Python concept, NOT Prism tool
    {
        "user": "Write me a Python context manager for database connections.",
        "think": "The user mentioned 'context manager'. My first instinct is session_load_context... "
                 "but wait — 'context manager' is a Python language feature (__enter__/__exit__), not "
                 "Prism's session context system. This is a general coding question. I should answer "
                 "directly with Python code, not call any tool.",
        "response": "<|synalux_answer|>Here's a Python context manager for database connections:\n\n"
                    "```python\nfrom contextlib import contextmanager\nimport sqlite3\n\n"
                    "@contextmanager\ndef db_connection(path):\n    conn = sqlite3.connect(path)\n"
                    "    try:\n        yield conn\n        conn.commit()\n    except Exception:\n"
                    "        conn.rollback()\n        raise\n    finally:\n        conn.close()\n```"
                    "</|synalux_answer|>",
    },
    # Tool confusion: knowledge_search vs session_search_memory
    {
        "user": "How did we fix that caching bug?",
        "think": "The user wants to search for information about a past bug fix. I could use "
                 "knowledge_search or session_search_memory. Let me think... knowledge_search is for "
                 "cross-session distilled knowledge, while session_search_memory is for raw session "
                 "history. Since bugs are typically discussed in sessions (not distilled into knowledge), "
                 "session_search_memory is the right choice here.",
        "tool": "session_search_memory",
        "args": {"query": "caching bug fix"},
    },
    # Over-eager tool call: 'forget' keyword → ML concept
    {
        "user": "Explain catastrophic forgetting in neural networks.",
        "think": "I see the word 'forget' and my immediate association is knowledge_forget or "
                 "session_forget_memory. But re-reading the prompt, this is about 'catastrophic forgetting' — "
                 "a well-known phenomenon in continual learning where neural networks lose previously learned "
                 "information. This is a general ML concept. No tool needed.",
        "response": "<|synalux_answer|>Catastrophic forgetting occurs when a neural network, trained on "
                    "Task A and then retrained on Task B, loses its ability to perform Task A. This happens "
                    "because gradient descent overwrites the weights that encoded Task A. Key mitigations:\n\n"
                    "1. **EWC (Elastic Weight Consolidation)** — penalizes changes to important weights\n"
                    "2. **Progressive Networks** — freeze old columns, add new ones\n"
                    "3. **Replay Buffers** — mix old data into new training\n"
                    "4. **LoRA/Adapters** — keep base weights frozen, only train lightweight adapters"
                    "</|synalux_answer|>",
    },
    # Sequential self-correction chain
    {
        "user": "Upvote the session about the OAuth implementation.",
        "think": "The user wants to upvote a memory entry using knowledge_upvote. But knowledge_upvote "
                 "requires a UUID (the entry id), not a description. I could search for it first... "
                 "Actually, should I search and then upvote in sequence? No — I should just search first "
                 "and present the results, then let the user confirm which entry to upvote. Guessing the "
                 "wrong UUID would upvote the wrong memory.",
        "tool": "session_search_memory",
        "args": {"query": "OAuth implementation"},
    },
]


# ============================================================================
# EXPERIMENT 3: Implicit State Resolution
# ============================================================================
# Users say "save my work" not "save ledger for project analytics-dashboard".
# Train the model to extract args from system state, not just explicit text.

# State block format injected into system prompts during training:
STATE_BLOCK_TEMPLATE = "[CURRENT STATE: Project={project}, Role={role}, ActiveFile={file}]"

IMPLICIT_STATE_TRACES = [
    # "Save my work" — extract project from state
    {
        "state": {"project": "analytics-dashboard", "role": "coder", "file": "auth.ts"},
        "user": "Save my work.",
        "think": "The user said 'save my work' without specifying a project. Looking at the current state: "
                 "Project=analytics-dashboard, Role=coder. I should use session_save_ledger with "
                 "project='analytics-dashboard' extracted from the state context.",
        "tool": "session_save_ledger",
        "args": {"project": "analytics-dashboard", "conversation_id": "current", "summary": "Work session saved"},
    },
    # "Load context" — no project specified, infer from state
    {
        "state": {"project": "backend-api", "role": "developer", "file": "routes.py"},
        "user": "Load context.",
        "think": "The user wants to load context but didn't specify which project. From the current state: "
                 "Project=backend-api. I'll load context for 'backend-api' at standard level.",
        "tool": "session_load_context",
        "args": {"project": "backend-api", "toolAction": "Loading context", "toolSummary": "Loading project context"},
    },
    # "Search for that migration" — project from state
    {
        "state": {"project": "data-pipeline", "role": "coder", "file": "migrate_v3.sql"},
        "user": "Search for that migration we discussed.",
        "think": "The user wants to search memory. They said 'that migration' — looking at the state, "
                 "the active file is 'migrate_v3.sql' in the 'data-pipeline' project. I should scope the "
                 "search to project='data-pipeline' with query about migration.",
        "tool": "session_search_memory",
        "args": {"query": "migration discussion", "project": "data-pipeline"},
    },
    # "What were we doing?" — pure state inference
    {
        "state": {"project": "ml-inference", "role": "coder", "file": "model_server.py"},
        "user": "What were we doing?",
        "think": "The user is asking about recent work. From state: Project=ml-inference. This is a recall "
                 "question, not a load operation. I'll search memory scoped to 'ml-inference'.",
        "tool": "session_search_memory",
        "args": {"query": "recent work", "project": "ml-inference"},
    },
    # "Create a handoff" — role from state
    {
        "state": {"project": "auth-service", "role": "developer", "file": "oauth.ts"},
        "user": "Hand this off to QA.",
        "think": "The user wants a handoff to QA. From state: Project=auth-service, Role=developer. "
                 "I should create a handoff from 'developer' to 'qa' for 'auth-service'.",
        "tool": "session_save_handoff",
        "args": {"project": "auth-service", "key_context": "Ready for QA review"},
    },
    # "Log the fix" — extract summary from state + user text
    {
        "state": {"project": "monitoring-stack", "role": "coder", "file": "alertmanager.yml"},
        "user": "Log the fix we just made.",
        "think": "The user wants to save a ledger entry about a fix. From state: Project=monitoring-stack, "
                 "ActiveFile=alertmanager.yml. I'll create a ledger entry for the monitoring-stack project "
                 "with context from the active file.",
        "tool": "session_save_ledger",
        "args": {"project": "monitoring-stack", "conversation_id": "current",
                 "summary": "Fixed alertmanager configuration"},
    },
]


# ============================================================================
# EXPERIMENT 4: Speculative / Parallel Tool Calling
# ============================================================================
# When a query is ambiguous, fire BOTH session_search_memory AND
# knowledge_search in parallel. Cuts latency 2x on complex queries.

PARALLEL_CALL_TRACES = [
    # Ambiguous recall — search both systems
    {
        "user": "How did we fix that bug?",
        "think": "The user is asking about a past bug fix. This could be in recent session history "
                 "(session_search_memory) or in long-term distilled knowledge (knowledge_search). "
                 "Since I'm uncertain, I should search BOTH in parallel to maximize recall and minimize latency.",
        "tools": [
            ("session_search_memory", {"query": "bug fix"}),
            ("knowledge_search", {"query": "bug fix"}),
        ],
    },
    # Vague reference to past work
    {
        "user": "What do we know about the database schema?",
        "think": "The user wants information about a database schema. This could be from a recent session discussion "
                 "or from accumulated knowledge insights. I'll search both memory systems in parallel.",
        "tools": [
            ("session_search_memory", {"query": "database schema"}),
            ("knowledge_search", {"query": "database schema"}),
        ],
    },
    # Past decision recall
    {
        "user": "Why did we choose PostgreSQL over MongoDB?",
        "think": "The user is asking about a past architectural decision. Decisions are often captured in both "
                 "session ledger entries and distilled into knowledge items. Searching both maximizes the chance "
                 "of finding the original reasoning.",
        "tools": [
            ("session_search_memory", {"query": "PostgreSQL vs MongoDB decision"}),
            ("knowledge_search", {"query": "PostgreSQL MongoDB architecture decision"}),
        ],
    },
    # Broad topic with potential in both stores
    {
        "user": "Everything we have on authentication.",
        "think": "This is a broad information gathering request. Authentication work could span many sessions "
                 "and also be distilled into knowledge items. I'll search both systems in parallel and "
                 "synthesize the results.",
        "tools": [
            ("session_search_memory", {"query": "authentication"}),
            ("knowledge_search", {"query": "authentication implementation"}),
        ],
    },
    # Historical patterns
    {
        "user": "Have we seen this error before?",
        "think": "The user encountered an error and wants to check if it's been seen before. This could be in "
                 "session history (debugging sessions) or knowledge base (documented issues). Searching both "
                 "in parallel will catch it regardless of where it was recorded.",
        "tools": [
            ("session_search_memory", {"query": "error encountered previously"}),
            ("knowledge_search", {"query": "known errors and debugging"}),
        ],
    },
]



def expand_self_correction_traces():
    """Auto-generate additional self-correction traces from templates.
    
    Addresses R3-2: 6 hand-crafted traces are ~0.1% of dataset (statistically
    invisible). This expands to 60 traces across 6 confusion categories.
    """
    # Template: (user_prompt, wrong_tool, correct_tool, correction_reasoning, args)
    confusion_matrix = [
        # save_ledger ↔ save_handoff confusion
        ("Record what we did today: fixed the auth flow.", "session_save_handoff", "session_save_ledger",
         "Wait — the user wants to LOG work, not hand off to another agent. session_save_ledger records accomplishments. session_save_handoff transfers state.",
         {"project": "billing-portal", "conversation_id": "current", "summary": "Fixed the auth flow"}),
        ("Pass the project state to the morning shift.", "session_save_ledger", "session_save_handoff",
         "Actually, 'pass to morning shift' means a handoff between agents, not a session log. I need session_save_handoff, not session_save_ledger.",
         {"project": "billing-portal", "key_context": "Project state for morning shift handoff"}),
        # search_memory ↔ load_context confusion
        ("Resume work on analytics.", "session_search_memory", "session_load_context",
         "The user says 'resume work'. My first thought was to search, but 'resume' means they want to continue from where they left off. session_load_context is correct.",
         {"project": "analytics"}),
        ("Find sessions about the deployment issue.", "session_load_context", "session_search_memory",
         "The user wants to FIND past sessions, not resume/load context. session_search_memory searches history semantically.",
         {"query": "deployment issue"}),
        # knowledge_search ↔ session_search_memory 
        ("What patterns did we establish for error handling?", "session_search_memory", "knowledge_search",
         "The user is asking about established PATTERNS — these are distilled insights, not raw session history. knowledge_search queries curated KIs.",
         {"query": "error handling patterns"}),
        ("What happened in yesterday's session?", "knowledge_search", "session_search_memory",
         "'Yesterday's session' is raw session history, not curated knowledge. I need session_search_memory.",
         {"query": "yesterday session work"}),
        # forget ↔ set_retention confusion
        ("Auto-expire old entries after 30 days for analytics.", "knowledge_forget", "knowledge_set_retention",
         "The user wants auto-expiry (a POLICY), not immediate deletion. knowledge_set_retention sets TTL rules. knowledge_forget deletes immediately.",
         {"project": "analytics", "ttl_days": 30}),
        ("Delete all entries from the test project now.", "knowledge_set_retention", "knowledge_forget",
         "The user wants immediate deletion, not a future policy. knowledge_forget performs immediate bulk deletion.",
         {"project": "test", "confirm_all": True}),
        # NLP keyword traps → no tool
        ("How do I implement session management in Express.js?", "session_load_context", None,
         "The word 'session' here refers to HTTP sessions in Express.js, not Prism's session_load_context. This is a coding question — no tool needed.",
         None),
    ]
    
    # Generate variations for each confusion pattern
    variation_prefixes = [
        "", "Hey, ", "Can you ", "Please ", "I need to ", "Go ahead and ",
    ]
    
    expanded = []
    for user, wrong, correct, reasoning, args in confusion_matrix:
        for prefix in variation_prefixes:
            trace = {
                "user": f"{prefix}{user}" if prefix else user,
                "think": f"My first instinct is to call {wrong}. {reasoning}",
            }
            if correct and args:
                trace["tool"] = correct
                trace["args"] = args
            else:
                trace["response"] = ("<|synalux_answer|>This is a general programming question. "
                                    "I'll answer directly without using any tools.</|synalux_answer|>")
            expanded.append(trace)
    
    return expanded


# General coding anchor data to prevent catastrophic forgetting (R3-4)
GENERAL_CODING_ANCHORS = [
    {"user": "Write a Python function to reverse a string.", 
     "response": "```python\ndef reverse_string(s: str) -> str:\n    return s[::-1]\n```"},
    {"user": "How do I read a JSON file in Python?",
     "response": "```python\nimport json\nwith open('data.json', 'r') as f:\n    data = json.load(f)\n```"},
    {"user": "Explain the difference between let, const, and var in JavaScript.",
     "response": "`var` is function-scoped and hoisted. `let` is block-scoped and mutable. `const` is block-scoped and immutable (for primitives). Use `const` by default, `let` when reassignment is needed, avoid `var`."},
    {"user": "Write a async/await fetch example in JavaScript.",
     "response": "```javascript\nasync function fetchData(url) {\n  const response = await fetch(url);\n  if (!response.ok) throw new Error(`HTTP ${response.status}`);\n  return await response.json();\n}\n```"},
    {"user": "What is a closure in Python?",
     "response": "A closure is a function that captures variables from its enclosing scope. The inner function retains access to outer scope variables even after the outer function has returned.\n```python\ndef counter():\n    count = 0\n    def increment():\n        nonlocal count\n        count += 1\n        return count\n    return increment\n```"},
    {"user": "How do I sort a list of dictionaries by a key in Python?",
     "response": "```python\nusers = [{'name': 'Alice', 'age': 30}, {'name': 'Bob', 'age': 25}]\nsorted_users = sorted(users, key=lambda x: x['age'])\n```"},
    {"user": "Write a basic REST API endpoint in Python using FastAPI.",
     "response": "```python\nfrom fastapi import FastAPI\napp = FastAPI()\n\n@app.get('/items/{item_id}')\nasync def read_item(item_id: int, q: str = None):\n    return {'item_id': item_id, 'query': q}\n```"},
    {"user": "What is the difference between == and === in JavaScript?",
     "response": "`==` performs type coercion before comparison (e.g., `'5' == 5` is true). `===` checks both value AND type without coercion (e.g., `'5' === 5` is false). Always prefer `===` to avoid subtle bugs."},
    {"user": "How do I handle errors in async Python code?",
     "response": "```python\nimport asyncio\n\nasync def safe_fetch(url):\n    try:\n        async with aiohttp.ClientSession() as session:\n            async with session.get(url) as resp:\n                return await resp.json()\n    except aiohttp.ClientError as e:\n        print(f'Network error: {e}')\n        return None\n```"},
    {"user": "Write a SQL query to find duplicate records.",
     "response": "```sql\nSELECT email, COUNT(*) as cnt\nFROM users\nGROUP BY email\nHAVING COUNT(*) > 1;\n```"},
    {"user": "What is dependency injection and why is it useful?",
     "response": "Dependency injection is a design pattern where objects receive their dependencies from external sources rather than creating them internally. Benefits: testability (mock deps in tests), loose coupling, single responsibility. Example: passing a database client to a service constructor instead of instantiating it inside the service."},
    {"user": "How do I create a virtual environment in Python?",
     "response": "```bash\npython3 -m venv myenv\nsource myenv/bin/activate  # macOS/Linux\nmyenv\\Scripts\\activate     # Windows\npip install -r requirements.txt\n```"},
    {"user": "Write a TypeScript interface for a User object.",
     "response": "```typescript\ninterface User {\n  id: number;\n  name: string;\n  email: string;\n  role: 'admin' | 'user' | 'guest';\n  createdAt: Date;\n}\n```"},
    {"user": "How do I use list comprehension with conditions in Python?",
     "response": "```python\n# Filter and transform\nevens = [x * 2 for x in range(20) if x % 2 == 0]\n\n# Nested comprehension\nflat = [item for sublist in nested_list for item in sublist]\n\n# Conditional expression\nlabels = ['even' if x % 2 == 0 else 'odd' for x in range(10)]\n```"},
    {"user": "What is the difference between TCP and UDP?",
     "response": "**TCP**: Connection-oriented, reliable delivery, ordered packets, flow control. Used for HTTP, SSH, databases.\n**UDP**: Connectionless, no delivery guarantee, no ordering, minimal overhead. Used for DNS, streaming, gaming.\nTCP trades latency for reliability; UDP trades reliability for speed."},
    {"user": "Write a decorator in Python that measures function execution time.",
     "response": "```python\nimport time\nfrom functools import wraps\n\ndef timer(func):\n    @wraps(func)\n    def wrapper(*args, **kwargs):\n        start = time.perf_counter()\n        result = func(*args, **kwargs)\n        elapsed = time.perf_counter() - start\n        print(f'{func.__name__} took {elapsed:.4f}s')\n        return result\n    return wrapper\n```"},
    {"user": "How do I flatten a nested dictionary in Python?",
     "response": "```python\ndef flatten(d, prefix='', sep='.'):\n    items = {}\n    for k, v in d.items():\n        key = f'{prefix}{sep}{k}' if prefix else k\n        if isinstance(v, dict):\n            items.update(flatten(v, key, sep))\n        else:\n            items[key] = v\n    return items\n```"},
    {"user": "Explain the CAP theorem in distributed systems.",
     "response": "The CAP theorem states that a distributed system can satisfy at most 2 of 3 guarantees: **Consistency** (all nodes see the same data), **Availability** (every request gets a response), **Partition tolerance** (system works despite network splits). Since network partitions are inevitable, you must choose CP (consistent but may reject requests) or AP (available but may serve stale data)."},
    {"user": "Write a React component that fetches data on mount.",
     "response": "```tsx\nimport { useState, useEffect } from 'react';\n\nfunction UserList() {\n  const [users, setUsers] = useState([]);\n  const [loading, setLoading] = useState(true);\n\n  useEffect(() => {\n    fetch('/api/users')\n      .then(res => res.json())\n      .then(data => { setUsers(data); setLoading(false); })\n      .catch(() => setLoading(false));\n  }, []);\n\n  if (loading) return <div>Loading...</div>;\n  return <ul>{users.map(u => <li key={u.id}>{u.name}</li>)}</ul>;\n}\n```"},
    {"user": "What is the difference between a process and a thread?",
     "response": "**Process**: Independent execution unit with its own memory space, file descriptors, and resources. Communication via IPC (pipes, sockets, shared memory).\n**Thread**: Lightweight execution unit within a process, sharing the same memory space. Communication via shared variables (requires synchronization).\nProcesses are isolated but heavy; threads are fast but prone to race conditions."},
]


def generate_coding_anchors(target_count: int = 1200):
    """Synthetically expand 20 hand-crafted coding examples to 1200+.
    
    R4-1: 20 examples = 0.3% of 6000+ tool traces is mathematically invisible.
    This generates coding Q&A across language × domain × pattern combinations
    to anchor the model's base coding capabilities at 15-20% of the dataset.
    """
    # Base languages and their patterns
    languages = {
        "python": {
            "patterns": [
                ("Write a {concept} in Python.", "```python\n{code}\n```"),
                ("How do I {task} in Python?", "{explanation}\n```python\n{code}\n```"),
                ("Explain {concept} in Python with an example.", "{explanation}\n```python\n{code}\n```"),
            ],
            "concepts": [
                ("decorator", "A decorator wraps a function to extend its behavior.", "def my_decorator(func):\n    def wrapper(*args, **kwargs):\n        print('Before')\n        result = func(*args, **kwargs)\n        print('After')\n        return result\n    return wrapper"),
                ("context manager", "Context managers handle resource setup/teardown via __enter__/__exit__.", "class FileManager:\n    def __init__(self, path):\n        self.path = path\n    def __enter__(self):\n        self.file = open(self.path, 'r')\n        return self.file\n    def __exit__(self, *args):\n        self.file.close()"),
                ("generator", "Generators yield values lazily using the yield keyword.", "def fibonacci():\n    a, b = 0, 1\n    while True:\n        yield a\n        a, b = b, a + b"),
                ("dataclass", "Dataclasses reduce boilerplate for data-holding classes.", "from dataclasses import dataclass\n\n@dataclass\nclass Point:\n    x: float\n    y: float\n    \n    def distance(self, other):\n        return ((self.x - other.x)**2 + (self.y - other.y)**2)**0.5"),
                ("async function", "Async functions use async/await for concurrent I/O.", "import asyncio\n\nasync def fetch_all(urls):\n    async with aiohttp.ClientSession() as session:\n        tasks = [session.get(url) for url in urls]\n        return await asyncio.gather(*tasks)"),
                ("class inheritance", "Inheritance allows classes to extend parent behavior.", "class Animal:\n    def __init__(self, name):\n        self.name = name\n    def speak(self):\n        raise NotImplementedError\n\nclass Dog(Animal):\n    def speak(self):\n        return f'{self.name} says Woof!'"),
                ("error handling", "Try/except blocks handle runtime exceptions gracefully.", "def safe_divide(a, b):\n    try:\n        return a / b\n    except ZeroDivisionError:\n        return None\n    except TypeError as e:\n        raise ValueError(f'Invalid types: {e}')"),
                ("list comprehension", "List comprehensions create lists concisely.", "squares = [x**2 for x in range(10) if x % 2 == 0]"),
                ("property decorator", "Properties enable getter/setter access patterns.", "class Circle:\n    def __init__(self, radius):\n        self._radius = radius\n    @property\n    def area(self):\n        return 3.14159 * self._radius ** 2"),
                ("type hints", "Type hints improve code clarity and IDE support.", "from typing import Optional, List\n\ndef process_items(items: List[str], limit: Optional[int] = None) -> List[str]:\n    if limit:\n        return items[:limit]\n    return items"),
            ],
        },
        "javascript": {
            "patterns": [
                ("Write a {concept} in JavaScript.", "```javascript\n{code}\n```"),
                ("How do I {task} in JavaScript?", "{explanation}\n```javascript\n{code}\n```"),
            ],
            "concepts": [
                ("Promise chain", "Promises handle async operations with .then().", "fetch('/api/users')\n  .then(res => res.json())\n  .then(data => console.log(data))\n  .catch(err => console.error(err));"),
                ("async/await", "async/await provides cleaner async syntax.", "async function fetchUser(id) {\n  try {\n    const res = await fetch(`/api/users/${id}`);\n    return await res.json();\n  } catch (err) {\n    console.error(err);\n  }\n}"),
                ("closure", "Closures capture variables from the enclosing scope.", "function counter() {\n  let count = 0;\n  return {\n    increment: () => ++count,\n    getCount: () => count,\n  };\n}"),
                ("class with methods", "ES6 classes use constructor and methods.", "class EventEmitter {\n  constructor() { this.listeners = {}; }\n  on(event, cb) { (this.listeners[event] ??= []).push(cb); }\n  emit(event, ...args) { this.listeners[event]?.forEach(cb => cb(...args)); }\n}"),
                ("array methods", "Array methods like map/filter/reduce transform data.", "const total = orders\n  .filter(o => o.status === 'completed')\n  .map(o => o.amount)\n  .reduce((sum, amt) => sum + amt, 0);"),
                ("destructuring", "Destructuring extracts values from objects/arrays.", "const { name, age, role = 'user' } = user;\nconst [first, ...rest] = items;"),
                ("module pattern", "ES modules organize code with import/export.", "// utils.js\nexport const formatDate = (d) => d.toISOString().split('T')[0];\nexport const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);"),
                ("error handling", "Try/catch handles async and sync errors.", "async function safeParse(json) {\n  try {\n    return JSON.parse(json);\n  } catch (e) {\n    console.warn('Invalid JSON:', e.message);\n    return null;\n  }\n}"),
            ],
        },
        "typescript": {
            "patterns": [
                ("Write a {concept} in TypeScript.", "```typescript\n{code}\n```"),
            ],
            "concepts": [
                ("generic function", "Generics provide type-safe reusable functions.", "function first<T>(arr: T[]): T | undefined {\n  return arr.length > 0 ? arr[0] : undefined;\n}"),
                ("interface", "Interfaces define object shapes for type checking.", "interface ApiResponse<T> {\n  data: T;\n  status: number;\n  message: string;\n  timestamp: Date;\n}"),
                ("enum", "Enums define named constants.", "enum HttpStatus {\n  OK = 200,\n  NotFound = 404,\n  ServerError = 500,\n}"),
                ("utility types", "TypeScript provides built-in utility types.", "type UserUpdate = Partial<User>;\ntype ReadonlyUser = Readonly<User>;\ntype UserName = Pick<User, 'firstName' | 'lastName'>;"),
                ("type guard", "Type guards narrow types at runtime.", "function isString(val: unknown): val is string {\n  return typeof val === 'string';\n}"),
            ],
        },
        "sql": {
            "patterns": [
                ("Write a SQL query to {task}.", "```sql\n{code}\n```"),
            ],
            "concepts": [
                ("join tables", "JOINs combine rows from multiple tables.", "SELECT u.name, o.total\nFROM users u\nINNER JOIN orders o ON u.id = o.user_id\nWHERE o.created_at > '2024-01-01';"),
                ("window function", "Window functions compute over row sets.", "SELECT name, salary,\n  RANK() OVER (PARTITION BY dept ORDER BY salary DESC) as rank\nFROM employees;"),
                ("CTE", "CTEs improve readability of complex queries.", "WITH monthly AS (\n  SELECT DATE_TRUNC('month', created_at) AS month, SUM(amount) AS total\n  FROM orders GROUP BY 1\n)\nSELECT month, total, LAG(total) OVER (ORDER BY month) AS prev\nFROM monthly;"),
                ("upsert", "UPSERT inserts or updates on conflict.", "INSERT INTO users (email, name)\nVALUES ('a@b.com', 'Alice')\nON CONFLICT (email)\nDO UPDATE SET name = EXCLUDED.name;"),
                ("index optimization", "Indexes speed up query performance.", "CREATE INDEX idx_orders_user_date\nON orders (user_id, created_at DESC)\nWHERE status = 'active';"),
            ],
        },
        "react": {
            "patterns": [
                ("Write a React component that {task}.", "```tsx\n{code}\n```"),
            ],
            "concepts": [
                ("custom hook", "Custom hooks extract reusable stateful logic.", "function useDebounce<T>(value: T, delay: number): T {\n  const [debounced, setDebounced] = useState(value);\n  useEffect(() => {\n    const timer = setTimeout(() => setDebounced(value), delay);\n    return () => clearTimeout(timer);\n  }, [value, delay]);\n  return debounced;\n}"),
                ("form handling", "Controlled forms manage state via onChange.", "function LoginForm() {\n  const [email, setEmail] = useState('');\n  const handleSubmit = (e) => {\n    e.preventDefault();\n    console.log('Login:', email);\n  };\n  return (\n    <form onSubmit={handleSubmit}>\n      <input value={email} onChange={e => setEmail(e.target.value)} />\n      <button type='submit'>Login</button>\n    </form>\n  );\n}"),
                ("context provider", "Context avoids prop drilling.", "const ThemeContext = createContext('light');\n\nfunction ThemeProvider({ children }) {\n  const [theme, setTheme] = useState('light');\n  return (\n    <ThemeContext.Provider value={{ theme, setTheme }}>\n      {children}\n    </ThemeContext.Provider>\n  );\n}"),
                ("conditional rendering", "Components render conditionally.", "function StatusBadge({ status }) {\n  const colors = { active: 'green', inactive: 'gray', error: 'red' };\n  return <span style={{ color: colors[status] }}>{status}</span>;\n}"),
                ("data fetching", "useEffect fetches data on mount.", "function UserProfile({ id }) {\n  const [user, setUser] = useState(null);\n  useEffect(() => {\n    fetch(`/api/users/${id}`)\n      .then(r => r.json())\n      .then(setUser);\n  }, [id]);\n  if (!user) return <div>Loading...</div>;\n  return <h1>{user.name}</h1>;\n}"),
            ],
        },
    }
    
    anchors = list(GENERAL_CODING_ANCHORS)  # Start with the 20 hand-crafted ones
    
    for lang, lang_data in languages.items():
        for pattern_template, response_template in lang_data["patterns"]:
            for concept, explanation, code in lang_data["concepts"]:
                user_prompt = pattern_template.format(concept=concept, task=concept)
                response = response_template.format(
                    concept=concept, explanation=explanation, code=code, task=concept
                )
                anchors.append({"user": user_prompt, "response": response})
    
    # If we haven't hit target_count, duplicate with slight variations
    if len(anchors) < target_count:
        original_count = len(anchors)
        multiplier = (target_count // original_count) + 1
        expanded = []
        prefixes = ["", "Can you ", "Please ", "Show me how to ", "I need to "]
        for i in range(multiplier):
            prefix = prefixes[i % len(prefixes)]
            for anchor in anchors[:original_count]:
                expanded.append({
                    "user": f"{prefix}{anchor['user']}" if prefix else anchor["user"],
                    "response": anchor["response"],
                })
                if len(expanded) >= target_count:
                    break
            if len(expanded) >= target_count:
                break
        anchors = expanded
    
    return anchors[:target_count]


def generate_experiment_traces(sys_prompt, all_tools, format_fn):
    """Generate training data for all 4 real-world UX experiments.

    Args:
        sys_prompt: Pre-formatted system prompt string (from config.format_system_prompt).
        all_tools: List of tool schema dicts (for state_context re-formatting in Exp 3).
        format_fn: Reference to config.format_system_prompt (for Exp 3 state injection).

    Returns a list of ChatML-formatted training examples.
    """
    data = []

    # Exp 1: Proactive Clarification
    for trace in CLARIFICATION_TRACES:
        think = f"<|synalux_think|>\n{trace['think']}\n</|synalux_think|>\n"
        completion = f"{think}{trace['response']}"
        data.append({
            "messages": [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": trace['user']},
                {"role": "assistant", "content": completion},
            ]
        })

    # Exp 2: Self-Correction (hand-crafted + expanded + UPSAMPLED)
    # R4-4: Upsample 10× to reach ~5% of dataset mass
    all_self_correction = list(SELF_CORRECTION_TRACES) + expand_self_correction_traces()
    upsampled_self_correction = all_self_correction  # R23-fix: removed * 10 hard duplication (causes catastrophic memorization)
    for trace in upsampled_self_correction:
        think = f"<|synalux_think|>\n{trace['think']}\n</|synalux_think|>\n"
        if "tool" in trace:
            tc = json.dumps({"name": trace["tool"], "arguments": trace["args"]})
            completion = f"{think}{TOOL_CALL_OPEN}\n{tc}\n{TOOL_CALL_CLOSE}"
        else:
            completion = f"{think}{trace['response']}"
        data.append({
            "messages": [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": trace['user']},
                {"role": "assistant", "content": completion},
            ]
        })

    # Exp 3: Implicit State Resolution
    for trace in IMPLICIT_STATE_TRACES:
        state = STATE_BLOCK_TEMPLATE.format(**trace["state"])
        think = f"<|synalux_think|>\n{trace['think']}\n</|synalux_think|>\n"
        tc = json.dumps({"name": trace["tool"], "arguments": trace["args"]})
        completion = f"{think}{TOOL_CALL_OPEN}\n{tc}\n{TOOL_CALL_CLOSE}"
        # R12-fix: Use centralized formatter with state_context to match inference-time ordering
        sys_with_state = format_fn(all_tools, state_context=trace["state"])
        data.append({
            "messages": [
                {"role": "system", "content": sys_with_state},
                {"role": "user", "content": trace['user']},
                {"role": "assistant", "content": completion},
            ]
        })

    # Exp 4: Parallel Tool Calling
    for trace in PARALLEL_CALL_TRACES:
        think = f"<|synalux_think|>\n{trace['think']}\n</|synalux_think|>\n"
        # Multiple tool calls separated by newline
        tool_blocks = []
        for tool_name, args in trace["tools"]:
            tc = json.dumps({"name": tool_name, "arguments": args})
            tool_blocks.append(f"{TOOL_CALL_OPEN}\n{tc}\n{TOOL_CALL_CLOSE}")
        completion = think + "\n".join(tool_blocks)
        data.append({
            "messages": [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": trace['user']},
                {"role": "assistant", "content": completion},
            ]
        })

    # R4-1: General coding anchors — 1200+ examples (15-20% of merged dataset)
    coding_anchors = generate_coding_anchors(target_count=1200)
    for anchor in coding_anchors:
        think = random.choice(REASONING_THINK[:5])  # Use generic "no tool needed" reasoning
        completion = f"<|synalux_think|>\n{think}\n</|synalux_think|>\n<|synalux_answer|>{anchor['response']}</|synalux_answer|>"
        data.append({
            "messages": [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": anchor['user']},
                {"role": "assistant", "content": completion},
            ]
        })

    return data


def main():
    random.seed(42)
    data = []

    # R9-fix: Include system prompt so model learns tool calls require tool context
    from config import format_system_prompt
    _tool_schema_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "tool_schema.json")
    try:
        with open(_tool_schema_path) as _f:
            _all_tools = json.load(_f).get("tools", [])
    except (FileNotFoundError, json.JSONDecodeError):
        _all_tools = []
    _sys_prompt = format_system_prompt(_all_tools)

    # Generate tool examples
    tool_count = 0
    for tool_name, config in TOOL_PROMPTS.items():
        for prompt, extra_args in config["prompts"]:
            completion = build_completion(tool_name, extra_args, config["default_args"])
            data.append({
                "messages": [
                    {"role": "system", "content": _sys_prompt},
                    {"role": "user", "content": prompt},
                    {"role": "assistant", "content": completion},
                ]
            })
            tool_count += 1

    # Generate reasoning examples
    reasoning_count = 0
    for prompt, answer in REASONING_PROMPTS:
        completion = build_reasoning_completion(prompt, answer)
        data.append({
            "messages": [
                {"role": "system", "content": _sys_prompt},
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": completion},
            ]
        })
        reasoning_count += 1

    # Generate UX experiment traces (Experiments 1-4)
    experiment_data = generate_experiment_traces(_sys_prompt, _all_tools, format_system_prompt)
    data.extend(experiment_data)

    print(f"Generated {len(data)} unique examples:")
    print(f"  Tool examples: {tool_count} ({len(TOOL_PROMPTS)} tools)")
    for tool_name, config in TOOL_PROMPTS.items():
        print(f"    {tool_name}: {len(config['prompts'])} phrasings")
    print(f"  Reasoning examples: {reasoning_count}")
    print(f"  UX Experiment traces: {len(experiment_data)}")
    print(f"    Exp 1 (Clarification): {len(CLARIFICATION_TRACES)}")
    print(f"    Exp 2 (Self-Correction): {len(SELF_CORRECTION_TRACES)}")
    print(f"    Exp 3 (State Resolution): {len(IMPLICIT_STATE_TRACES)}")
    print(f"    Exp 4 (Parallel Calls): {len(PARALLEL_CALL_TRACES)}")

    # IMPORTANT: Do NOT duplicate rows with `data * N`. That destroys batch
    # variance and causes catastrophic memorization. Use mlx_lm.lora --iters
    # for proper epoch-level repetition with internal shuffling.
    random.shuffle(data)

    split = int(len(data) * 0.9)
    train = data[:split]
    valid = data[split:]

    from config import AUX_DATA_DIR
    out_dir = AUX_DATA_DIR
    os.makedirs(out_dir, exist_ok=True)
    with open(f"{out_dir}/train.jsonl", "w") as f:
        for item in train:
            f.write(json.dumps(item) + "\n")

    with open(f"{out_dir}/valid.jsonl", "w") as f:
        for item in valid:
            f.write(json.dumps(item) + "\n")

    print(f"\n  Unique examples: {len(data)}")
    print(f"  Train: {len(train)}, Valid: {len(valid)}")
    print(f"  NOTE: Use --iters in mlx_lm.lora for epoch repetition (not array multiplication)")
    print(f"  Saved to {out_dir}/")


if __name__ == "__main__":
    main()
