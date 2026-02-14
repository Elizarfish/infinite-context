# infinite-context

Persistent memory for Claude Code. Archives context before compaction, restores it after, and provides proactive recall across sessions.

## Problem

Claude Code loses all accumulated context when compaction triggers. Long sessions, complex projects, multi-step debugging — everything gets compressed away. Start a new session and you're back to zero.

## Solution

`infinite-context` hooks into Claude Code's lifecycle events to:

- **Archive** decisions, file changes, errors, and findings into SQLite before compaction
- **Restore** the most important memories after compaction or session start
- **Recall** relevant context proactively on every prompt via FTS5 full-text search
- **Support agents** — subagents spawned via Task tool receive project context automatically
- **Web dashboard** — browse, search, and manage memories via `ic dashboard`
- **Rollback-safe** — handles message editing (double-ESC) without orphaning memories

One dependency (`better-sqlite3`), ~17 source files, installs in seconds.

## Install

```bash
git clone https://github.com/Elizarfish/infinite-context.git
cd infinite-context
npm install
node src/cli.js install
```

Restart Claude Code. Done.

## Uninstall

```bash
node src/cli.js uninstall
```

Hooks are removed, existing hooks untouched, data preserved.

## How It Works

Six hooks registered in `~/.claude/settings.json`:

| Hook | Event | What it does |
|------|-------|-------------|
| `pre-compact.js` | PreCompact | Parses transcript, extracts memories, archives to SQLite |
| `session-start.js` | SessionStart | Restores top memories (by importance score) into context |
| `user-prompt-submit.js` | UserPromptSubmit | FTS5 keyword search, injects relevant memories |
| `session-end.js` | SessionEnd | Final archive pass, score decay, pruning |
| `subagent-start.js` | SubagentStart | Injects project context into Task-spawned agents |
| `subagent-stop.js` | SubagentStop | Archives subagent transcript into memory DB |

### Memory Scoring

Each memory gets an importance score based on:
- **Category weight** — architecture (1.0) > decisions (0.9) > errors (0.8) > findings (0.7) > file changes (0.5) > notes (0.4)
- **Recency** — exponential decay with 7-day half-life
- **Access frequency** — log-scaled, memories that get recalled often stay alive
- **Score decay** — unused memories decay daily, pruned when below threshold

### Storage

- SQLite with WAL mode for concurrent access
- FTS5 virtual table for full-text keyword search
- Incremental transcript parsing via checkpoints (only new lines since last parse)
- SHA-256 content hashing for deduplication
- Per-project memory isolation (keyed by `cwd`)

## CLI

```bash
ic install                        # Install hooks
ic uninstall                      # Remove hooks (data preserved)
ic status                         # Show stats: memory count, DB size, projects
ic search <keywords>              # FTS5 search across memories
ic search <keywords> --project .  # Search within specific project
ic export                         # Export all memories as JSON
ic export --project .             # Export specific project
ic prune                          # Decay scores and prune low-value memories
ic prune --older-than 30          # Prune memories older than N days (never accessed)
ic prune --below-score 0.1        # Prune below score threshold
ic prune --dry-run                # Preview what would be pruned
ic dashboard                     # Start web dashboard on port 3333
ic dashboard --port 8080         # Custom port
ic config                         # Show current configuration
```

## Web Dashboard

```bash
ic dashboard              # http://localhost:3333
ic dashboard --port 8080  # Custom port
```

Interactive web interface for monitoring and managing memories:

- **Overview** — stats, category distribution, recent sessions
- **Memories** — browse, search, filter by project/category, sort by score/date, delete
- **Projects** — per-project memory counts, click to filter
- **Sessions** — timeline with compaction and memory stats
- **Config** — current configuration, prune controls

REST API available at `/api/stats`, `/api/memories`, `/api/projects`, `/api/sessions`, `/api/config`.

## Configuration

Optional. Create `~/.claude/infinite-context/config.json`:

```json
{
  "maxRestoreTokens": 4000,
  "maxMemoriesPerRestore": 20,
  "maxPromptRecallResults": 5,
  "decayFactor": 0.95,
  "decayIntervalDays": 1,
  "pruneThreshold": 0.05,
  "scoreFloor": 0.01,
  "maxMemoriesPerProject": 5000
}
```

All fields optional — defaults are sensible.

## Project Structure

```
src/
  cli.js                     # CLI interface
  install.js                 # Hook registration/removal
  core/
    config.js                # Configuration with defaults
    transcript-parser.js     # JSONL transcript parser with checkpoints
    archiver.js              # Memory extraction from conversation turns
    scorer.js                # Scoring, importance ranking, keyword extraction
    restorer.js              # Context restoration within token budget
  db/
    store.js                 # SQLite layer — FTS5, prepared statements, WAL
  hooks/
    common.js                # Shared hook utilities
    pre-compact.js           # Archive before compaction
    session-start.js         # Restore after compaction/start
    user-prompt-submit.js    # Proactive recall per prompt
    session-end.js           # Final archive + cleanup
    subagent-start.js        # Inject context into subagents
    subagent-stop.js         # Archive subagent transcripts
  web/
    server.js                # Dashboard HTTP server + REST API
    index.html               # Single-page dashboard app
tests/
  store.test.js
  archiver.test.js
  restorer.test.js
  scorer.test.js
  transcript-parser.test.js
  install.test.js
  integration.test.js
  hook-contract.test.js
  edge-cases.test.js
  regression.test.js
  stress.test.js
  concurrency.test.js
  real-transcript.test.js
  coverage-gaps.test.js
```

## Requirements

- Node.js >= 20
- Claude Code with hooks support

## Data

Stored in `~/.claude/infinite-context/memories.db`. Survives uninstall. Delete manually if needed:

```bash
rm -rf ~/.claude/infinite-context/
```

## License

MIT
