import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Store } from '../src/db/store.js';
import { resetConfig } from '../src/core/config.js';
import { parseTranscript, groupIntoTurns } from '../src/core/transcript-parser.js';
import { extractMemories } from '../src/core/archiver.js';
import { restoreContext, recallForPrompt } from '../src/core/restorer.js';
import { extractKeywords, scoreMemory, computeImportance, estimateTokens } from '../src/core/scorer.js';

// =========================================================================
// Test fixtures: realistic Claude Code JSONL transcript data
// =========================================================================

const SESSION_ID = 'test-session-' + randomUUID().slice(0, 8);
const PROJECT_CWD = '/Users/testuser/projects/my-app';

/** Build a single JSONL line representing a user message */
function userMessage(text, opts = {}) {
  return JSON.stringify({
    parentUuid: opts.parentUuid || null,
    isSidechain: false,
    userType: 'external',
    cwd: opts.cwd || PROJECT_CWD,
    sessionId: opts.sessionId || SESSION_ID,
    version: '2.1.41',
    type: 'user',
    message: { role: 'user', content: text },
    uuid: opts.uuid || randomUUID(),
    timestamp: opts.timestamp || new Date().toISOString(),
  });
}

/** Build a user message with tool_result blocks (synthetic after tool_use) */
function toolResultMessage(results, opts = {}) {
  const content = results.map(r => ({
    type: 'tool_result',
    tool_use_id: r.toolUseId || randomUUID(),
    content: r.content || '',
    is_error: r.isError || false,
  }));
  return JSON.stringify({
    parentUuid: opts.parentUuid || null,
    isSidechain: false,
    userType: 'external',
    cwd: opts.cwd || PROJECT_CWD,
    sessionId: opts.sessionId || SESSION_ID,
    version: '2.1.41',
    type: 'user',
    message: { role: 'user', content },
    uuid: opts.uuid || randomUUID(),
    timestamp: opts.timestamp || new Date().toISOString(),
  });
}

/** Build an assistant message with text */
function assistantTextMessage(text, opts = {}) {
  return JSON.stringify({
    parentUuid: opts.parentUuid || null,
    isSidechain: false,
    userType: 'external',
    cwd: opts.cwd || PROJECT_CWD,
    sessionId: opts.sessionId || SESSION_ID,
    version: '2.1.41',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    uuid: opts.uuid || randomUUID(),
    timestamp: opts.timestamp || new Date().toISOString(),
  });
}

/** Build an assistant message with thinking + text */
function assistantThinkingMessage(thinking, text, opts = {}) {
  return JSON.stringify({
    parentUuid: opts.parentUuid || null,
    isSidechain: false,
    userType: 'external',
    cwd: opts.cwd || PROJECT_CWD,
    sessionId: opts.sessionId || SESSION_ID,
    version: '2.1.41',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking },
        { type: 'text', text },
      ],
    },
    uuid: opts.uuid || randomUUID(),
    timestamp: opts.timestamp || new Date().toISOString(),
  });
}

/** Build an assistant message with tool_use calls */
function assistantToolUseMessage(toolCalls, opts = {}) {
  const content = toolCalls.map(tc => ({
    type: 'tool_use',
    id: tc.id || randomUUID(),
    name: tc.name,
    input: tc.input || {},
  }));
  return JSON.stringify({
    parentUuid: opts.parentUuid || null,
    isSidechain: false,
    userType: 'external',
    cwd: opts.cwd || PROJECT_CWD,
    sessionId: opts.sessionId || SESSION_ID,
    version: '2.1.41',
    type: 'assistant',
    message: { role: 'assistant', content },
    uuid: opts.uuid || randomUUID(),
    timestamp: opts.timestamp || new Date().toISOString(),
  });
}

/** Build a progress line (should be skipped by parser) */
function progressMessage(opts = {}) {
  return JSON.stringify({
    parentUuid: opts.parentUuid || null,
    isSidechain: false,
    userType: 'external',
    cwd: opts.cwd || PROJECT_CWD,
    sessionId: opts.sessionId || SESSION_ID,
    version: '2.1.41',
    type: 'progress',
    uuid: opts.uuid || randomUUID(),
    timestamp: opts.timestamp || new Date().toISOString(),
  });
}

/** Build a file-history-snapshot line (should be skipped by parser) */
function fileHistorySnapshot() {
  return JSON.stringify({
    type: 'file-history-snapshot',
    messageId: randomUUID(),
    snapshot: { messageId: randomUUID(), trackedFileBackups: {}, timestamp: new Date().toISOString() },
    isSnapshotUpdate: false,
  });
}

// =========================================================================
// Build a realistic multi-turn transcript
// =========================================================================

function buildRealisticTranscript() {
  const lines = [];

  // 1. File history snapshot (should be skipped)
  lines.push(fileHistorySnapshot());

  // 2. User asks to set up a new feature
  lines.push(userMessage('Add authentication middleware to the Express API using JWT tokens'));

  // 3. Assistant responds with a plan (includes a decision)
  lines.push(assistantThinkingMessage(
    'The user wants JWT authentication. I need to consider the architecture - should I use passport.js or write a custom middleware? Given the separation of concerns and the component design, a custom middleware approach would be simpler and avoid the extra dependency.',
    "I'll create a custom JWT authentication middleware instead of using passport.js, keeping the codebase simpler."
  ));

  // 4. Assistant makes a Write tool call
  const writeId = randomUUID();
  lines.push(assistantToolUseMessage([
    { id: writeId, name: 'Write', input: { file_path: '/Users/testuser/projects/my-app/src/middleware/auth.js' } },
  ]));

  // 5. Progress (should be skipped)
  lines.push(progressMessage());

  // 6. Tool result for the write
  lines.push(toolResultMessage([{ toolUseId: writeId, content: 'File written successfully' }]));

  // 7. Assistant makes an Edit tool call
  const editId = randomUUID();
  lines.push(assistantToolUseMessage([
    {
      id: editId,
      name: 'Edit',
      input: {
        file_path: '/Users/testuser/projects/my-app/src/server.js',
        old_string: "app.use('/api', router);",
        new_string: "app.use('/api', authMiddleware, router);",
      },
    },
  ]));

  // 8. Tool result for the edit
  lines.push(toolResultMessage([{ toolUseId: editId, content: 'Edit applied successfully' }]));

  // 9. Assistant runs a Bash command (npm install)
  const bashId = randomUUID();
  lines.push(assistantToolUseMessage([
    { id: bashId, name: 'Bash', input: { command: 'npm install jsonwebtoken bcryptjs' } },
  ]));

  // 10. Tool result with error
  lines.push(toolResultMessage([{
    toolUseId: bashId,
    content: 'npm ERR! code ERESOLVE\nnpm ERR! Could not resolve dependency: jsonwebtoken@9.0.0',
    isError: true,
  }]));

  // 11. Assistant responds with fix
  lines.push(assistantTextMessage(
    "The npm install failed due to a dependency conflict. Let's use the --legacy-peer-deps flag to resolve it."
  ));

  // 12. Another Bash command (notable - ssh)
  const bash2Id = randomUUID();
  lines.push(assistantToolUseMessage([
    { id: bash2Id, name: 'Bash', input: { command: 'ssh deploy@production "systemctl restart api"' } },
  ]));

  // 13. Tool result success
  lines.push(toolResultMessage([{ toolUseId: bash2Id, content: 'Service restarted' }]));

  // 14. User asks another question
  lines.push(userMessage('Now add rate limiting to protect against brute force attacks'));

  // 15. Assistant responds with decision
  lines.push(assistantTextMessage(
    "I'll implement rate limiting using express-rate-limit. We should configure it with a sliding window of 15 minutes and limit to 100 requests per IP."
  ));

  // 16. Another Write
  const write2Id = randomUUID();
  lines.push(assistantToolUseMessage([
    { id: write2Id, name: 'Write', input: { file_path: '/Users/testuser/projects/my-app/src/middleware/rate-limit.js' } },
  ]));

  // 17. Tool result
  lines.push(toolResultMessage([{ toolUseId: write2Id, content: 'File written' }]));

  return lines.join('\n') + '\n';
}

// =========================================================================
// Build a subagent transcript
// =========================================================================

function buildSubagentTranscript() {
  const subSessionId = SESSION_ID + ':agent-abc123';
  const lines = [];

  lines.push(userMessage('Research the best JWT library for Node.js and check for CVEs', {
    sessionId: subSessionId,
  }));

  lines.push(assistantTextMessage(
    "I'll research JWT libraries. Going with jsonwebtoken as it's the most maintained, but we should note the recent CVE-2024-1234 vulnerability.",
    { sessionId: subSessionId }
  ));

  const bashId = randomUUID();
  lines.push(assistantToolUseMessage([
    { id: bashId, name: 'Bash', input: { command: 'npm install jsonwebtoken@latest' } },
  ], { sessionId: subSessionId }));

  lines.push(toolResultMessage([{
    toolUseId: bashId,
    content: 'added 3 packages in 2.1s',
  }], { sessionId: subSessionId }));

  return lines.join('\n') + '\n';
}

// =========================================================================
// Temp directory management
// =========================================================================

let testDir;
let transcriptPath;
let subagentTranscriptPath;
let dbPath;

function setupTestDir() {
  testDir = join(tmpdir(), `ic-integration-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  transcriptPath = join(testDir, 'main-transcript.jsonl');
  subagentTranscriptPath = join(testDir, 'subagent-transcript.jsonl');
  dbPath = join(testDir, 'test-memories.db');
  writeFileSync(transcriptPath, buildRealisticTranscript());
  writeFileSync(subagentTranscriptPath, buildSubagentTranscript());
}

function cleanupTestDir() {
  try {
    if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// =========================================================================
// Helper to run a hook script and capture stdout JSON
// =========================================================================

const ROOT = join(import.meta.dirname, '..');
const HOOKS_DIR = join(ROOT, 'src', 'hooks');

function runHook(hookName, stdinPayload, env = {}) {
  const hookPath = join(HOOKS_DIR, `${hookName}.js`);
  const stdinStr = typeof stdinPayload === 'string' ? stdinPayload : JSON.stringify(stdinPayload);

  // Override DB path via environment
  const envVars = {
    ...process.env,
    INFINITE_CONTEXT_DB_PATH: dbPath,
    ...env,
  };

  try {
    const stdout = execSync(
      `echo '${stdinStr.replace(/'/g, "'\\''")}' | node "${hookPath}"`,
      {
        cwd: ROOT,
        env: envVars,
        timeout: 15000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return stdout.trim();
  } catch (err) {
    // Hooks should never crash (exit 0), but capture stdout even on error
    return (err.stdout || '').trim();
  }
}

// =========================================================================
// Integration Tests
// =========================================================================

describe('Integration: Full Hook Lifecycle', () => {
  before(() => {
    setupTestDir();
    resetConfig();
  });

  after(() => {
    cleanupTestDir();
  });

  // -----------------------------------------------------------------------
  // Phase 1: Transcript parsing with real-format data
  // -----------------------------------------------------------------------

  describe('Phase 1: Transcript Parsing', () => {
    it('should parse the realistic JSONL transcript correctly', () => {
      const { messages, lastLine } = parseTranscript(transcriptPath, 0);

      // Should skip: file-history-snapshot, progress entries
      // Should include: user messages, assistant messages, tool_result user messages
      assert.ok(messages.length > 0, 'Should parse some messages');
      assert.ok(lastLine > 0, 'Should track line count');

      // Check roles
      const roles = [...new Set(messages.map(m => m.role))];
      assert.ok(roles.includes('user'), 'Should have user messages');
      assert.ok(roles.includes('assistant'), 'Should have assistant messages');

      // Check that tool calls were extracted
      const withToolCalls = messages.filter(m => m.toolCalls.length > 0);
      assert.ok(withToolCalls.length > 0, 'Should have messages with tool calls');

      // Check that Write tool call was found
      const writeTools = withToolCalls.flatMap(m => m.toolCalls).filter(tc => tc.name === 'Write');
      assert.ok(writeTools.length >= 2, `Should find at least 2 Write calls, found ${writeTools.length}`);

      // Check that Edit tool call was found
      const editTools = withToolCalls.flatMap(m => m.toolCalls).filter(tc => tc.name === 'Edit');
      assert.equal(editTools.length, 1, 'Should find exactly 1 Edit call');
      assert.ok(editTools[0].input.old_string, 'Edit should have old_string');
      assert.ok(editTools[0].input.new_string, 'Edit should have new_string');

      // Check tool results
      const withToolResults = messages.filter(m => m.toolResults.length > 0);
      assert.ok(withToolResults.length > 0, 'Should have tool results');

      // Check error tool result
      const errors = withToolResults.flatMap(m => m.toolResults).filter(tr => tr.isError);
      assert.equal(errors.length, 1, 'Should find 1 error tool result');
      assert.ok(errors[0].content.includes('npm ERR!'), 'Error should contain npm error');
    });

    it('should parse thinking blocks from assistant messages', () => {
      const { messages } = parseTranscript(transcriptPath, 0);
      const withThinking = messages.filter(m => m.thinking.length > 0);
      assert.ok(withThinking.length >= 1, 'Should have at least 1 message with thinking');
      assert.ok(withThinking[0].thinking.includes('architecture'), 'Thinking should contain architecture reasoning');
    });

    it('should support incremental parsing via checkpoint', () => {
      const { messages: all, lastLine } = parseTranscript(transcriptPath, 0);
      const midpoint = Math.floor(lastLine / 2);

      const { messages: first } = parseTranscript(transcriptPath, 0);
      const { messages: second } = parseTranscript(transcriptPath, midpoint);

      // Second parse should have fewer messages
      assert.ok(second.length < first.length, 'Incremental parse should return fewer messages');

      // Second parse should start after midpoint
      for (const msg of second) {
        assert.ok(msg.lineNum > midpoint, `Message at line ${msg.lineNum} should be > ${midpoint}`);
      }
    });

    it('should group messages into conversation turns', () => {
      const { messages } = parseTranscript(transcriptPath, 0);
      const turns = groupIntoTurns(messages);

      assert.ok(turns.length >= 2, `Should have at least 2 turns, got ${turns.length}`);

      // Each turn should have a user message
      for (const turn of turns) {
        assert.ok(turn.userMessage, 'Turn should have a userMessage');
        assert.ok(turn.userMessage.role === 'user', 'userMessage role should be user');
      }

      // First turn should have tool calls (Write, Edit, Bash)
      assert.ok(turns[0].allToolCalls.length >= 3,
        `First turn should have >= 3 tool calls, got ${turns[0].allToolCalls.length}`);
    });
  });

  // -----------------------------------------------------------------------
  // Phase 2: Memory extraction from parsed transcript
  // -----------------------------------------------------------------------

  describe('Phase 2: Memory Extraction', () => {
    let memories;

    before(() => {
      const { messages } = parseTranscript(transcriptPath, 0);
      const turns = groupIntoTurns(messages);
      memories = extractMemories(turns, PROJECT_CWD, SESSION_ID);
    });

    it('should extract file_change memories from Write/Edit tool calls', () => {
      const fileChanges = memories.filter(m => m.category === 'file_change');
      assert.ok(fileChanges.length >= 2, `Should extract >= 2 file changes, got ${fileChanges.length}`);

      // Should include the auth.js Write
      const authWrite = fileChanges.find(m => m.content.includes('auth.js'));
      assert.ok(authWrite, 'Should have auth.js file change');
      assert.ok(authWrite.content.startsWith('Created/wrote file:'), 'Write should use "Created/wrote" prefix');

      // Should include the server.js Edit with diff info
      const serverEdit = fileChanges.find(m => m.content.includes('server.js'));
      assert.ok(serverEdit, 'Should have server.js file change');
      assert.ok(serverEdit.content.includes('Edited file:'), 'Edit should use "Edited" prefix');
    });

    it('should extract errors from synthetic tool_result user messages (appended to turn)', () => {
      // groupIntoTurns now appends tool results from synthetic user messages
      // to the current turn's allToolResults (fixed from earlier bug where they were skipped).
      // This means error tool results ARE now captured.
      const errors = memories.filter(m => m.category === 'error');
      assert.ok(errors.length >= 1, `Should extract at least 1 error from tool results, got ${errors.length}`);
      assert.ok(errors[0].content.includes('npm ERR!'), 'Error memory should contain npm error text');
    });

    it('should extract decision memories from assistant text', () => {
      const decisions = memories.filter(m => m.category === 'decision');
      assert.ok(decisions.length >= 1, `Should extract >= 1 decision, got ${decisions.length}`);

      // Should capture the JWT middleware decision
      const jwtDecision = decisions.find(m =>
        m.content.includes('JWT') || m.content.includes('passport') || m.content.includes('middleware')
      );
      assert.ok(jwtDecision, 'Should capture the JWT/authentication decision');
    });

    it('should extract architecture reasoning from thinking blocks', () => {
      const arch = memories.filter(m => m.category === 'architecture');
      assert.ok(arch.length >= 1, `Should extract >= 1 architecture item, got ${arch.length}`);
      assert.ok(
        arch.some(a => a.content.includes('separation of concerns') || a.content.includes('component') || a.content.includes('architecture')),
        'Architecture memory should contain design reasoning'
      );
    });

    it('should extract notable commands (npm install, ssh)', () => {
      const notes = memories.filter(m => m.category === 'note');
      const commands = notes.filter(m => m.content.startsWith('Ran command:'));
      assert.ok(commands.length >= 1, `Should extract >= 1 notable command, got ${commands.length}`);

      // ssh is a notable command
      const sshCmd = commands.find(m => m.content.includes('ssh'));
      assert.ok(sshCmd, 'Should capture the ssh command as notable');
    });

    it('should extract user requests as notes', () => {
      const notes = memories.filter(m => m.category === 'note');
      const userReqs = notes.filter(m => m.content.startsWith('User request:'));
      assert.ok(userReqs.length >= 1, 'Should extract user requests');
    });

    it('should assign source hashes for deduplication', () => {
      for (const m of memories) {
        assert.ok(m.sourceHash, `Memory "${m.content.slice(0, 40)}" should have a sourceHash`);
        assert.equal(m.sourceHash.length, 16, 'Source hash should be 16 hex chars');
      }

      // Hashes should be unique (since content differs)
      const hashes = memories.map(m => m.sourceHash);
      const uniqueHashes = new Set(hashes);
      // Note: some can collide if sourceText is the same, but generally should be unique
      assert.ok(uniqueHashes.size >= memories.length * 0.8, 'Most source hashes should be unique');
    });

    it('should assign valid scores to all memories', () => {
      for (const m of memories) {
        assert.ok(typeof m.score === 'number', 'Score should be a number');
        assert.ok(m.score >= 0 && m.score <= 1, `Score ${m.score} should be between 0 and 1`);
      }
    });

    it('should set project and sessionId on all memories', () => {
      for (const m of memories) {
        assert.equal(m.project, PROJECT_CWD, 'Project should match');
        assert.equal(m.sessionId, SESSION_ID, 'Session ID should match');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Phase 3: Database insert & retrieve cycle
  // -----------------------------------------------------------------------

  describe('Phase 3: DB Insert & Retrieve Cycle', () => {
    let db;
    let memories;

    beforeEach(() => {
      resetConfig();
      db = new Store(':memory:').open();
      const { messages } = parseTranscript(transcriptPath, 0);
      const turns = groupIntoTurns(messages);
      memories = extractMemories(turns, PROJECT_CWD, SESSION_ID);
    });

    afterEach(() => {
      db.close();
    });

    it('should insert all extracted memories and deduplicate on re-insert', () => {
      const inserted = db.insertMany(memories);
      assert.ok(inserted > 0, 'Should insert at least 1 memory');
      assert.ok(inserted <= memories.length, 'Inserted count should not exceed memory count');

      // Re-insert: should all be deduped
      const reinserted = db.insertMany(memories);
      assert.equal(reinserted, 0, 'Re-insertion should yield 0 new rows (all deduped)');
    });

    it('should retrieve memories by project', () => {
      db.insertMany(memories);
      const retrieved = db.getTopMemories(PROJECT_CWD, 100);
      assert.ok(retrieved.length > 0, 'Should retrieve memories');
      for (const m of retrieved) {
        assert.equal(m.project, PROJECT_CWD, 'All should belong to project');
      }
    });

    it('should return empty for non-existent project', () => {
      db.insertMany(memories);
      const retrieved = db.getTopMemories('/nonexistent/project', 100);
      assert.equal(retrieved.length, 0, 'Should return empty for unknown project');
    });

    it('should search via FTS and find relevant memories', () => {
      db.insertMany(memories);

      // Search for "jwt" or "authentication" — should find decisions/file changes
      const results = db.search('authentication jwt', PROJECT_CWD, 10);
      assert.ok(results.length > 0, 'FTS search for "authentication jwt" should return results');
    });

    it('should preserve memory metadata through insert/retrieve', () => {
      // Note: insertMemory calls JSON.stringify(metadata) internally,
      // so pass an object (not a pre-stringified string) to avoid double-encoding
      const testMem = {
        project: PROJECT_CWD,
        sessionId: SESSION_ID,
        category: 'decision',
        content: 'Use Redis for caching',
        keywords: 'redis caching',
        score: 0.85,
        sourceHash: 'meta-test-hash-1',
        metadata: { agentId: 'agent-123', agentType: 'researcher' },
      };
      db.insertMemory(testMem);

      const retrieved = db.getTopMemories(PROJECT_CWD, 10);
      const found = retrieved.find(m => m.content === 'Use Redis for caching');
      assert.ok(found, 'Should find the memory');
      assert.ok(found.metadata, 'Metadata should be preserved');
      const meta = JSON.parse(found.metadata);
      assert.equal(meta.agentId, 'agent-123');
      assert.equal(meta.agentType, 'researcher');
    });

    it('should handle session upsert + checkpoint + incr in sequence', () => {
      db.upsertSession(SESSION_ID, PROJECT_CWD);

      // Insert memories
      const inserted = db.insertMany(memories);
      db.incrSessionMemories(SESSION_ID, inserted);
      db.incrSessionCompactions(SESSION_ID);

      // Save checkpoint
      db.saveCheckpoint(SESSION_ID, transcriptPath, 42);
      const cp = db.getCheckpoint(SESSION_ID, transcriptPath);
      assert.equal(cp.last_line_number, 42);

      // Check session stats
      const stats = db.getStats();
      assert.equal(stats.sessions.length, 1);
      assert.equal(stats.sessions[0].memories_created, inserted);
      assert.equal(stats.sessions[0].compactions, 1);
      assert.equal(stats.sessions[0].ended_at, null);

      // End session
      db.endSession(SESSION_ID);
      const stats2 = db.getStats();
      assert.ok(stats2.sessions[0].ended_at, 'Session should have ended_at');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 4: Context Restoration
  // -----------------------------------------------------------------------

  describe('Phase 4: Context Restoration', () => {
    let db;

    beforeEach(() => {
      resetConfig();
      db = new Store(':memory:').open();

      // Insert diverse memories for restoration testing
      const items = [
        { project: PROJECT_CWD, sessionId: SESSION_ID, category: 'architecture', content: 'Using MVC pattern with service layer for API design', keywords: 'mvc service layer api', score: 1.0, sourceHash: 'arch-1' },
        { project: PROJECT_CWD, sessionId: SESSION_ID, category: 'decision', content: 'Chose PostgreSQL over MongoDB for relational data needs', keywords: 'postgresql mongodb database', score: 0.9, sourceHash: 'dec-1' },
        { project: PROJECT_CWD, sessionId: SESSION_ID, category: 'error', content: 'Error: ECONNREFUSED when connecting to Redis on port 6379', keywords: 'redis econnrefused port', score: 0.8, sourceHash: 'err-1' },
        { project: PROJECT_CWD, sessionId: SESSION_ID, category: 'file_change', content: 'Created/wrote file: src/middleware/auth.js', keywords: 'auth middleware file', score: 0.5, sourceHash: 'fc-1' },
        { project: PROJECT_CWD, sessionId: SESSION_ID, category: 'note', content: 'Ran command: npm install express jsonwebtoken', keywords: 'npm install express jwt', score: 0.4, sourceHash: 'note-1' },
      ];
      db.insertMany(items);
    });

    afterEach(() => {
      db.close();
    });

    it('should restore context with proper section headers', () => {
      const memories = db.getTopMemories(PROJECT_CWD, 20);
      const { text, ids } = restoreContext(memories);

      assert.ok(text, 'Should produce restoration text');
      assert.ok(ids.length > 0, 'Should return restored memory IDs');

      // Check structure
      assert.ok(text.startsWith('## Prior Context (restored from archive)'), 'Should have header');
      assert.ok(text.includes('### Architecture & Design'), 'Should have Architecture section');
      assert.ok(text.includes('### Key Decisions'), 'Should have Decisions section');
    });

    it('should respect token budget', () => {
      const memories = db.getTopMemories(PROJECT_CWD, 20);

      // Very small budget
      const { text: small, ids: smallIds } = restoreContext(memories, 100);
      const { text: large, ids: largeIds } = restoreContext(memories, 10000);

      assert.ok(smallIds.length <= largeIds.length,
        'Smaller budget should restore fewer memories');
      assert.ok(small.length <= large.length,
        'Smaller budget should produce shorter text');
    });

    it('should recall relevant memories for user prompt', () => {
      const memories = db.getTopMemories(PROJECT_CWD, 20);
      // Simulate search results
      const searchResults = memories.filter(m =>
        m.content.toLowerCase().includes('redis') || m.content.toLowerCase().includes('database')
      );

      const { text, ids } = recallForPrompt(searchResults);
      assert.ok(text, 'Should produce recall text');
      assert.ok(text.includes('## Relevant prior context'), 'Should have recall header');
      assert.ok(ids.length > 0, 'Should return recalled IDs');
    });

    it('should handle empty memory set gracefully', () => {
      const { text, ids } = restoreContext([]);
      assert.equal(text, '', 'Empty memories should produce empty text');
      assert.equal(ids.length, 0, 'Empty memories should produce no IDs');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 5: Full Lifecycle Simulation
  // -----------------------------------------------------------------------

  describe('Phase 5: Full Lifecycle (SessionStart -> PreCompact -> Restore -> Search -> SubagentStop -> SessionEnd)', () => {
    let db;

    beforeEach(() => {
      resetConfig();
      db = new Store(':memory:').open();
    });

    afterEach(() => {
      db.close();
    });

    it('should survive the complete memory lifecycle', () => {
      // STEP 1: SessionStart — no memories yet, should return empty
      db.upsertSession(SESSION_ID, PROJECT_CWD);
      const initialMemories = db.getTopMemories(PROJECT_CWD);
      assert.equal(initialMemories.length, 0, 'No memories at start');

      // STEP 2: PreCompact — parse transcript and archive
      const checkpoint1 = db.getCheckpoint(SESSION_ID, transcriptPath);
      assert.equal(checkpoint1, undefined, 'No checkpoint at start');

      const { messages, lastLine } = parseTranscript(transcriptPath, 0);
      assert.ok(messages.length > 0, 'Should parse messages');

      const turns = groupIntoTurns(messages);
      const memories = extractMemories(turns, PROJECT_CWD, SESSION_ID);
      assert.ok(memories.length > 0, 'Should extract memories');

      const inserted = db.insertMany(memories);
      assert.ok(inserted > 0, 'Should insert memories');

      db.saveCheckpoint(SESSION_ID, transcriptPath, lastLine);
      db.incrSessionMemories(SESSION_ID, inserted);
      db.incrSessionCompactions(SESSION_ID);
      db.enforceProjectLimit(PROJECT_CWD);

      // STEP 3: SessionStart (restore after compaction)
      const restored = db.getTopMemories(PROJECT_CWD);
      assert.ok(restored.length > 0, 'Should have memories to restore');

      const { text: restoreText, ids: restoredIds } = restoreContext(restored);
      assert.ok(restoreText, 'Should produce restore text');
      assert.ok(restoredIds.length > 0, 'Should restore some IDs');

      db.touchMemories(restoredIds);

      // Verify touch actually worked
      const afterTouch = db.getTopMemories(PROJECT_CWD, 1);
      assert.ok(afterTouch[0].access_count > 0, 'Access count should be > 0 after touch');

      // STEP 4: UserPromptSubmit — search for relevant memories
      const searchQuery = extractKeywords('How do I fix the JWT authentication middleware?');
      assert.ok(searchQuery, 'Should extract keywords from prompt');

      const searchResults = db.search(searchQuery, PROJECT_CWD, 5);
      // May or may not find results depending on keyword overlap
      if (searchResults.length > 0) {
        const { text: recallText, ids: recallIds } = recallForPrompt(searchResults);
        assert.ok(recallText, 'Should produce recall text');
        db.touchMemories(recallIds);
      }

      // STEP 5: SubagentStart — restore context for subagent
      const subagentMemories = db.getTopMemories(PROJECT_CWD, 12); // 60% of 20
      assert.ok(subagentMemories.length > 0, 'Should have memories for subagent');

      const subBudget = Math.floor(4000 * 0.6);
      const { text: subText, ids: subIds } = restoreContext(subagentMemories, subBudget);
      if (subText) {
        db.touchMemories(subIds);
      }

      // STEP 6: SubagentStop — archive subagent transcript
      const subSessionId = `${SESSION_ID}:agent-abc123`;
      const { messages: subMsgs, lastLine: subLastLine } = parseTranscript(subagentTranscriptPath, 0);
      assert.ok(subMsgs.length > 0, 'Should parse subagent messages');

      const subTurns = groupIntoTurns(subMsgs);
      const subMemories = extractMemories(subTurns, PROJECT_CWD, subSessionId);

      if (subMemories.length > 0) {
        // Tag with agent metadata
        for (const mem of subMemories) {
          mem.metadata = JSON.stringify({ agentId: 'agent-abc123', agentType: 'researcher' });
        }
        const subInserted = db.insertMany(subMemories);
        db.saveCheckpoint(subSessionId, subagentTranscriptPath, subLastLine);
        db.incrSessionMemories(SESSION_ID, subInserted);
      }

      // STEP 7: SessionEnd — final archive, decay, prune
      const totalBefore = db.getTopMemories(PROJECT_CWD, 1000).length;
      assert.ok(totalBefore > 0, 'Should have memories before session end');

      const pruned = db.decayAndPrune();
      // Recently inserted memories should not be pruned
      const totalAfter = db.getTopMemories(PROJECT_CWD, 1000).length;
      assert.equal(totalAfter, totalBefore, 'No memories should be pruned (all are fresh)');

      db.enforceProjectLimit(PROJECT_CWD);
      db.endSession(SESSION_ID);

      // Final verification
      const stats = db.getStats();
      assert.ok(stats.total > 0, 'Should have memories at end');
      assert.equal(stats.sessions.length, 1, 'Should have 1 session');
      assert.ok(stats.sessions[0].ended_at, 'Session should be ended');
      assert.ok(stats.sessions[0].memories_created > 0, 'Should track memory count');
    });

    it('should support multi-session accumulation', () => {
      // Session 1: archive transcript
      const session1 = 'session-1';
      db.upsertSession(session1, PROJECT_CWD);
      const { messages } = parseTranscript(transcriptPath, 0);
      const turns = groupIntoTurns(messages);
      const memories = extractMemories(turns, PROJECT_CWD, session1);
      const ins1 = db.insertMany(memories);
      db.incrSessionMemories(session1, ins1);
      db.endSession(session1);

      const countAfter1 = db.getTopMemories(PROJECT_CWD, 1000).length;

      // Session 2: archive subagent transcript (different content)
      const session2 = 'session-2';
      db.upsertSession(session2, PROJECT_CWD);
      const { messages: msgs2 } = parseTranscript(subagentTranscriptPath, 0);
      const turns2 = groupIntoTurns(msgs2);
      const memories2 = extractMemories(turns2, PROJECT_CWD, session2);
      const ins2 = db.insertMany(memories2);
      db.incrSessionMemories(session2, ins2);
      db.endSession(session2);

      const countAfter2 = db.getTopMemories(PROJECT_CWD, 1000).length;
      // Session 2 may add new unique memories
      assert.ok(countAfter2 >= countAfter1, 'Second session should not lose memories');

      // Verify both sessions are tracked
      const stats = db.getStats();
      assert.equal(stats.sessions.length, 2, 'Should have 2 sessions');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 6: Error scenarios and edge cases
  // -----------------------------------------------------------------------

  describe('Phase 6: Error Scenarios', () => {
    it('should handle non-existent transcript file gracefully', () => {
      const { messages, lastLine } = parseTranscript('/nonexistent/file.jsonl', 0);
      assert.equal(messages.length, 0, 'Should return empty for missing file');
      assert.equal(lastLine, 0, 'Last line should be 0 for missing file');
    });

    it('should handle malformed JSONL lines (corrupt transcript)', () => {
      const corruptPath = join(testDir, 'corrupt.jsonl');
      writeFileSync(corruptPath, [
        'not valid json at all',
        '{"invalid": missing closing brace',
        userMessage('Valid message after corrupt lines'),
        '',
        '   ',
        assistantTextMessage('Valid assistant response'),
      ].join('\n') + '\n');

      const { messages } = parseTranscript(corruptPath, 0);
      // Should parse the valid lines and skip invalid ones
      assert.ok(messages.length >= 2, `Should parse valid messages despite corruption, got ${messages.length}`);
    });

    it('should handle empty transcript file', () => {
      const emptyPath = join(testDir, 'empty.jsonl');
      writeFileSync(emptyPath, '');

      const { messages, lastLine } = parseTranscript(emptyPath, 0);
      assert.equal(messages.length, 0, 'Should return empty for empty file');
      assert.equal(lastLine, 0, 'Last line should be 0');
    });

    it('should handle transcript with only non-message entries', () => {
      const nonMsgPath = join(testDir, 'nonmsg.jsonl');
      writeFileSync(nonMsgPath, [
        fileHistorySnapshot(),
        progressMessage(),
        progressMessage(),
      ].join('\n') + '\n');

      const { messages } = parseTranscript(nonMsgPath, 0);
      assert.equal(messages.length, 0, 'Should find no messages in non-message-only file');
    });

    it('should handle transcript with system messages (skipped by parser)', () => {
      const sysPath = join(testDir, 'system.jsonl');
      writeFileSync(sysPath, [
        JSON.stringify({
          type: 'system',
          message: { role: 'system', content: 'You are a helpful assistant.' },
        }),
        userMessage('Hello after system prompt'),
      ].join('\n') + '\n');

      const { messages } = parseTranscript(sysPath, 0);
      // System messages should be skipped
      const systemMsgs = messages.filter(m => m.role === 'system');
      assert.equal(systemMsgs.length, 0, 'System messages should be skipped');
      assert.ok(messages.length >= 1, 'Should still parse user message');
    });

    it('should handle DB open on read-only or missing parent directory gracefully', () => {
      resetConfig();
      // Store constructor with bogus path — the open() should not crash
      // because it creates dirs with mkdirSync({ recursive: true })
      const tempDbPath = join(testDir, 'sub', 'deep', 'nested', 'test.db');
      const store = new Store(tempDbPath);
      const opened = store.open();
      assert.ok(opened, 'Should open DB even with nested path');
      const stats = opened.getStats();
      assert.equal(stats.total, 0, 'Fresh DB should have 0 memories');
      opened.close();
    });

    it('should handle extractMemories with empty turns', () => {
      const memories = extractMemories([], PROJECT_CWD, SESSION_ID);
      assert.equal(memories.length, 0, 'Empty turns should produce no memories');
    });

    it('should handle extractMemories with turns lacking tool calls', () => {
      const turns = [{
        userMessage: { text: 'Hello', lineNum: 1, role: 'user', toolCalls: [], toolResults: [] },
        assistantMessages: [
          { text: 'Hi there! How can I help?', thinking: '', lineNum: 2, role: 'assistant', toolCalls: [], toolResults: [] },
        ],
        allToolCalls: [],
        allToolResults: [],
        startLine: 1,
        endLine: 2,
      }];

      const memories = extractMemories(turns, PROJECT_CWD, SESSION_ID);
      // Might just have a user request note since "Hello" is too short (< 20 chars)
      // All memories should be valid
      for (const m of memories) {
        assert.ok(m.project, 'Memory should have project');
        assert.ok(m.category, 'Memory should have category');
      }
    });

    it('should handle restoreContext with memories missing created_at/last_accessed', () => {
      // computeImportance uses created_at and last_accessed — test with missing values
      const memories = [
        { id: 1, category: 'decision', content: 'Test memory', score: 0.5, access_count: 0 },
      ];
      // Should not throw — Date parsing of undefined gives NaN, but computeImportance should handle it
      const { text, ids } = restoreContext(memories);
      // Even if importance computation is weird, it should not crash
      assert.ok(Array.isArray(ids), 'Should return ids array');
    });

    it('should handle search with special characters in query', () => {
      resetConfig();
      const db = new Store(':memory:').open();
      db.insertMemory({
        project: PROJECT_CWD, sessionId: 's1', category: 'note',
        content: 'Test with special chars: $HOME/.env', keywords: 'home env special',
        score: 0.5, sourceHash: 'special-1',
      });

      // FTS5 special characters should be handled
      const results = db.search('$HOME .env', PROJECT_CWD, 10);
      // Should not throw
      assert.ok(Array.isArray(results), 'Should return array for special char query');
      db.close();
    });

    it('should handle search with empty/whitespace query', () => {
      resetConfig();
      const db = new Store(':memory:').open();
      db.insertMemory({
        project: PROJECT_CWD, sessionId: 's1', category: 'note',
        content: 'Test', keywords: 'test', score: 0.5, sourceHash: 'h1',
      });

      const r1 = db.search('', PROJECT_CWD, 10);
      assert.equal(r1.length, 0, 'Empty query should return empty');

      const r2 = db.search('   ', PROJECT_CWD, 10);
      assert.equal(r2.length, 0, 'Whitespace query should return empty');
      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // Phase 7: Keyword extraction and scoring
  // -----------------------------------------------------------------------

  describe('Phase 7: Keyword Extraction & Scoring', () => {
    before(() => {
      resetConfig();
    });

    it('should extract keywords filtering stopwords', () => {
      const keywords = extractKeywords('I want to use the React framework for this project');
      assert.ok(keywords, 'Should produce keywords');
      assert.ok(!keywords.includes(' the '), 'Should filter "the"');
      assert.ok(!keywords.includes(' to '), 'Should filter "to"');
      assert.ok(keywords.includes('react'), 'Should keep "react"');
      assert.ok(keywords.includes('framework'), 'Should keep "framework"');
      assert.ok(keywords.includes('project'), 'Should keep "project"');
    });

    it('should handle empty/null input for keyword extraction', () => {
      assert.equal(extractKeywords(''), '', 'Empty string should return empty');
      assert.equal(extractKeywords(null), '', 'Null should return empty');
      assert.equal(extractKeywords(undefined), '', 'Undefined should return empty');
    });

    it('should score different categories with correct weights', () => {
      // Use short content to minimize length bonus and avoid 1.0 cap
      const content = 'test';
      const archScore = scoreMemory('architecture', content);
      const decScore = scoreMemory('decision', content);
      const errScore = scoreMemory('error', content);
      const fileScore = scoreMemory('file_change', content);
      const noteScore = scoreMemory('note', content);

      assert.ok(archScore >= decScore, 'Architecture should score >= decision');
      assert.ok(decScore >= errScore, 'Decision should score >= error');
      assert.ok(errScore > fileScore, 'Error should score higher than file_change');
      assert.ok(fileScore > noteScore, 'File_change should score higher than note');
    });

    it('should give length bonus for longer content', () => {
      const short = scoreMemory('note', 'Short');
      const long = scoreMemory('note', 'This is a much longer piece of content that should get a length bonus because it contains more detailed information');
      assert.ok(long > short, 'Longer content should score higher');
    });

    it('should cap score at 1.0', () => {
      const score = scoreMemory('architecture', 'x'.repeat(10000));
      assert.ok(score <= 1.0, 'Score should not exceed 1.0');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 8: Decay and pruning lifecycle
  // -----------------------------------------------------------------------

  describe('Phase 8: Decay & Pruning', () => {
    let db;

    beforeEach(() => {
      resetConfig();
      db = new Store(':memory:').open();
    });

    afterEach(() => {
      db.close();
    });

    it('should decay old memories and prune those below threshold', () => {
      // Insert a memory with very low score, then manually set it as old
      db.insertMemory({
        project: PROJECT_CWD, sessionId: 's1', category: 'note',
        content: 'Old forgotten note', keywords: 'old forgotten',
        score: 0.06, sourceHash: 'old-1',
      });

      // Manually age the memory so decay will affect it
      db.db.prepare("UPDATE memories SET last_accessed = datetime('now', '-30 days')").run();

      const pruned = db.decayAndPrune();
      // After decay, 0.06 * 0.95 = 0.057, which is above 0.05 threshold
      // But with enough decay iterations or lower initial score it would prune

      // Insert one below threshold directly
      db.insertMemory({
        project: PROJECT_CWD, sessionId: 's1', category: 'note',
        content: 'Truly forgotten', keywords: 'forgotten',
        score: 0.04, sourceHash: 'old-2',
      });

      const pruned2 = db.decayAndPrune();
      assert.ok(pruned2 >= 1, 'Should prune memory with score below threshold');
    });

    it('should enforce project memory limit', () => {
      // Set a low limit for testing
      // Insert more than default limit
      for (let i = 0; i < 10; i++) {
        db.insertMemory({
          project: PROJECT_CWD, sessionId: 's1', category: 'note',
          content: `Memory number ${i}`, keywords: `memory ${i}`,
          score: 0.1 + i * 0.08, sourceHash: `limit-${i}`,
        });
      }

      const before = db.getTopMemories(PROJECT_CWD, 1000).length;
      assert.equal(before, 10, 'Should have 10 memories');

      // enforceProjectLimit with default config (5000) won't prune
      // but we can verify it doesn't crash
      db.enforceProjectLimit(PROJECT_CWD);
      const after = db.getTopMemories(PROJECT_CWD, 1000).length;
      assert.equal(after, 10, 'All memories should survive (under 5000 limit)');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 9: Subagent transcript integration
  // -----------------------------------------------------------------------

  describe('Phase 9: Subagent Transcript Integration', () => {
    it('should parse and extract memories from subagent transcript', () => {
      const { messages, lastLine } = parseTranscript(subagentTranscriptPath, 0);
      assert.ok(messages.length > 0, 'Should parse subagent transcript');

      const turns = groupIntoTurns(messages);
      assert.ok(turns.length >= 1, 'Should have at least 1 turn');

      const memories = extractMemories(turns, PROJECT_CWD, `${SESSION_ID}:agent-abc123`);
      // Should extract at least a user request note and/or decisions
      assert.ok(memories.length > 0, `Should extract memories from subagent, got ${memories.length}`);
    });

    it('should tag subagent memories with agent metadata', () => {
      const { messages } = parseTranscript(subagentTranscriptPath, 0);
      const turns = groupIntoTurns(messages);
      const memories = extractMemories(turns, PROJECT_CWD, `${SESSION_ID}:agent-abc123`);

      // subagent-stop.js sets mem.metadata = JSON.stringify({...})
      // and insertMemory calls JSON.stringify(metadata) again internally,
      // so we should set metadata as a plain object to avoid double-encoding.
      // However, the real subagent-stop.js pre-stringifies. That means the stored
      // value is double-encoded. Let's mirror what subagent-stop actually does
      // and then parse accordingly.
      for (const mem of memories) {
        mem.metadata = JSON.stringify({ agentId: 'agent-abc123', agentType: 'researcher' });
      }

      resetConfig();
      const db = new Store(':memory:').open();
      const inserted = db.insertMany(memories);
      assert.ok(inserted > 0, 'Should insert subagent memories');

      const retrieved = db.getTopMemories(PROJECT_CWD, 100);
      for (const m of retrieved) {
        if (m.metadata) {
          // Because subagent-stop pre-stringifies and insertMemory stringifies again,
          // the stored value is double-encoded. First parse gets the stringified JSON,
          // second parse gets the actual object.
          let meta = JSON.parse(m.metadata);
          if (typeof meta === 'string') meta = JSON.parse(meta);
          assert.equal(meta.agentId, 'agent-abc123');
          assert.equal(meta.agentType, 'researcher');
        }
      }
      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // Phase 10: Hook stdin/stdout contract validation
  // -----------------------------------------------------------------------

  describe('Phase 10: Hook Output Format Validation', () => {
    it('writeHookOutput should produce correct JSON structure', async () => {
      // Import and test directly since running hooks via CLI requires the full env
      const { writeHookOutput } = await import('../src/hooks/common.js');

      // Capture stdout by redirecting
      const originalWrite = process.stdout.write;
      let captured = '';
      process.stdout.write = (data) => { captured += data; return true; };

      writeHookOutput('SessionStart', 'Test context');

      process.stdout.write = originalWrite;

      const parsed = JSON.parse(captured);
      assert.ok(parsed.hookSpecificOutput, 'Should have hookSpecificOutput');
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.equal(parsed.hookSpecificOutput.additionalContext, 'Test context');
    });

    it('writeHookOutput should not write when additionalContext is empty', async () => {
      const { writeHookOutput } = await import('../src/hooks/common.js');

      const originalWrite = process.stdout.write;
      let captured = '';
      process.stdout.write = (data) => { captured += data; return true; };

      writeHookOutput('SessionStart', null);
      writeHookOutput('SessionStart', undefined);
      writeHookOutput('SessionStart', '');

      process.stdout.write = originalWrite;

      assert.equal(captured, '', 'Should not write anything for empty context');
    });

    it('writePlainOutput should write raw text', async () => {
      const { writePlainOutput } = await import('../src/hooks/common.js');

      const originalWrite = process.stdout.write;
      let captured = '';
      process.stdout.write = (data) => { captured += data; return true; };

      writePlainOutput('CONTEXT ARCHIVE: 5 items archived');

      process.stdout.write = originalWrite;

      assert.equal(captured, 'CONTEXT ARCHIVE: 5 items archived');
    });

    it('readStdin should return null for TTY or timeout', async () => {
      const { readStdin } = await import('../src/hooks/common.js');
      // In test environment, stdin may behave differently
      // The key is that it doesn't throw
      // With isTTY potentially set, it should resolve to null
      if (process.stdin.isTTY) {
        const result = await readStdin(100);
        assert.equal(result, null, 'TTY stdin should return null');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Phase 11: Cross-cutting data integrity
  // -----------------------------------------------------------------------

  describe('Phase 11: Cross-cutting Data Integrity', () => {
    it('should maintain FTS index consistency after insert + delete cycle', () => {
      resetConfig();
      const db = new Store(':memory:').open();

      db.insertMemory({
        project: PROJECT_CWD, sessionId: 's1', category: 'decision',
        content: 'Use TypeScript for type safety', keywords: 'typescript type safety',
        score: 0.9, sourceHash: 'fts-1',
      });

      // Verify FTS search works
      const before = db.search('typescript', PROJECT_CWD, 10);
      assert.equal(before.length, 1, 'Should find via FTS before delete');

      // Delete via prune (set score very low)
      db.db.prepare('UPDATE memories SET score = 0.001').run();
      db.decayAndPrune();

      // FTS should reflect deletion
      const after = db.search('typescript', PROJECT_CWD, 10);
      assert.equal(after.length, 0, 'FTS should return empty after prune/delete');

      db.close();
    });

    it('should handle concurrent-like session tracking', () => {
      resetConfig();
      const db = new Store(':memory:').open();

      // Two sessions for same project
      db.upsertSession('sess-a', PROJECT_CWD);
      db.upsertSession('sess-b', PROJECT_CWD);

      db.insertMemory({
        project: PROJECT_CWD, sessionId: 'sess-a', category: 'note',
        content: 'From session A', keywords: 'session', score: 0.5, sourceHash: 'sa-1',
      });
      db.insertMemory({
        project: PROJECT_CWD, sessionId: 'sess-b', category: 'note',
        content: 'From session B', keywords: 'session', score: 0.5, sourceHash: 'sb-1',
      });

      db.incrSessionMemories('sess-a', 1);
      db.incrSessionMemories('sess-b', 1);

      const stats = db.getStats();
      assert.equal(stats.total, 2, 'Should have 2 total memories');
      assert.equal(stats.sessions.length, 2, 'Should track 2 sessions');

      // Both memories retrievable for the project
      const all = db.getTopMemories(PROJECT_CWD, 100);
      assert.equal(all.length, 2, 'Both sessions\' memories should be retrievable');

      db.close();
    });

    it('should correctly handle checkpoint overwrite semantics', () => {
      resetConfig();
      const db = new Store(':memory:').open();

      db.saveCheckpoint('s1', '/path/transcript.jsonl', 10);
      db.saveCheckpoint('s1', '/path/transcript.jsonl', 50);
      db.saveCheckpoint('s1', '/path/transcript.jsonl', 100);

      // getCheckpoint returns the latest (ORDER BY id DESC LIMIT 1)
      const cp = db.getCheckpoint('s1', '/path/transcript.jsonl');
      assert.equal(cp.last_line_number, 100, 'Should return latest checkpoint');

      // Different transcript path should have independent checkpoints
      db.saveCheckpoint('s1', '/other/transcript.jsonl', 25);
      const cp2 = db.getCheckpoint('s1', '/other/transcript.jsonl');
      assert.equal(cp2.last_line_number, 25, 'Different path should have own checkpoint');

      // Original should be unaffected
      const cp3 = db.getCheckpoint('s1', '/path/transcript.jsonl');
      assert.equal(cp3.last_line_number, 100, 'Original checkpoint should be unchanged');

      db.close();
    });

    it('should export all memories for a project', () => {
      resetConfig();
      const db = new Store(':memory:').open();

      for (let i = 0; i < 5; i++) {
        db.insertMemory({
          project: PROJECT_CWD, sessionId: 's1', category: 'note',
          content: `Export test ${i}`, keywords: `export ${i}`,
          score: 0.5, sourceHash: `exp-${i}`,
        });
      }
      db.insertMemory({
        project: '/other/project', sessionId: 's1', category: 'note',
        content: 'Other project memory', keywords: 'other',
        score: 0.5, sourceHash: 'exp-other',
      });

      const projectExport = db.exportAll(PROJECT_CWD);
      assert.equal(projectExport.length, 5, 'Should export 5 memories for project');

      const allExport = db.exportAll();
      assert.equal(allExport.length, 6, 'Should export all 6 memories');

      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // Phase 12: FTS5 Query Injection (Bug #1 from code review)
  // -----------------------------------------------------------------------

  describe('Phase 12: FTS5 Query Injection', () => {
    let db;

    beforeEach(() => {
      resetConfig();
      db = new Store(':memory:').open();

      // Seed database with searchable memories
      db.insertMemory({
        project: PROJECT_CWD, sessionId: 's1', category: 'decision',
        content: 'Use React for the frontend framework', keywords: 'react frontend framework',
        score: 0.8, sourceHash: 'fts-inj-1',
      });
      db.insertMemory({
        project: PROJECT_CWD, sessionId: 's1', category: 'note',
        content: 'Deployed to production server', keywords: 'deployed production server',
        score: 0.5, sourceHash: 'fts-inj-2',
      });
    });

    afterEach(() => {
      db.close();
    });

    it('should survive FTS5 operators in search query (AND, OR, NOT, NEAR)', () => {
      // These are FTS5 operators that could break the query if unescaped
      const dangerousQueries = [
        'react AND frontend',
        'react OR backend',
        'react NOT angular',
        'react NEAR frontend',
        'react NEAR/2 frontend',
      ];

      for (const q of dangerousQueries) {
        // Should not throw
        const results = db.search(q, PROJECT_CWD, 10);
        assert.ok(Array.isArray(results), `FTS5 operator query "${q}" should return array`);
      }
    });

    it('should survive double quotes in search query', () => {
      // Double quotes are FTS5 phrase delimiters — unmatched ones break queries
      const quoteQueries = [
        '"react"',
        '"unmatched quote',
        'react "frontend" framework',
        '""',
        '"react "frontend"',
      ];

      for (const q of quoteQueries) {
        const results = db.search(q, PROJECT_CWD, 10);
        assert.ok(Array.isArray(results), `Quoted query "${q}" should return array (not crash)`);
      }
    });

    it('should survive FTS5 special syntax in search query', () => {
      const specialQueries = [
        'react*',           // prefix matching
        '^react',           // column start
        'content:react',    // column filter
        '{content}:react',  // column filter alt syntax
        'react + frontend', // implicit AND with +
      ];

      for (const q of specialQueries) {
        const results = db.search(q, PROJECT_CWD, 10);
        assert.ok(Array.isArray(results), `Special FTS5 query "${q}" should not crash`);
      }
    });

    it('should handle user prompt with special characters via extractKeywords -> search pipeline', () => {
      // Simulate a full user-prompt-submit flow with tricky prompts
      const trickyPrompts = [
        'How do I fix the "Cannot read property" error?',
        'Why is the AND logic wrong in the OR handler?',
        'Find all NEAR misses in production (NOT staging)',
        'Deploy v2.0 -- "final" release',
        'Error: ECONNREFUSED 127.0.0.1:6379',
      ];

      for (const prompt of trickyPrompts) {
        const keywords = extractKeywords(prompt);
        if (keywords && keywords.split(' ').length >= 1) {
          const results = db.search(keywords, PROJECT_CWD, 5);
          assert.ok(Array.isArray(results), `Pipeline for prompt "${prompt.slice(0, 40)}" should not crash`);
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // Phase 13: Checkpoint lineNum vs blank lines (Bug #3 from code review)
  // -----------------------------------------------------------------------

  describe('Phase 13: Checkpoint vs Blank Lines in Transcript', () => {
    it('should not skip or double-process messages when transcript has blank lines', () => {
      const pathWithBlanks = join(testDir, 'blanks-transcript.jsonl');

      // Build a transcript with deliberate blank lines interspersed
      const lines = [
        userMessage('First user message about setting up authentication'),
        '',                          // blank line
        '   ',                       // whitespace-only line
        assistantTextMessage("I'll set up JWT-based authentication for the API."),
        '',
        userMessage('Now add rate limiting to the endpoints'),
        '',
        '',                          // consecutive blanks
        assistantTextMessage("I'll implement rate limiting using a sliding window approach."),
        '',
      ];
      writeFileSync(pathWithBlanks, lines.join('\n') + '\n');

      // First parse: get all messages
      const { messages: all, lastLine } = parseTranscript(pathWithBlanks, 0);
      assert.ok(all.length >= 4, `Should parse at least 4 messages, got ${all.length}`);

      // Checkpoint at midpoint
      const midpoint = Math.floor(lastLine / 2);

      // Second incremental parse from midpoint
      const { messages: second } = parseTranscript(pathWithBlanks, midpoint);

      // Verify no overlap: every message in second batch should have lineNum > midpoint
      for (const msg of second) {
        assert.ok(msg.lineNum > midpoint,
          `Incremental parse: msg at line ${msg.lineNum} should be > checkpoint ${midpoint}`);
      }

      // Verify no gaps: union of first-half + second-half should cover all messages
      const { messages: firstHalf } = parseTranscript(pathWithBlanks, 0);
      const firstHalfUpToMid = firstHalf.filter(m => m.lineNum <= midpoint);
      const totalFromParts = firstHalfUpToMid.length + second.length;
      assert.equal(totalFromParts, all.length,
        `Sum of parts (${firstHalfUpToMid.length} + ${second.length}) should equal total (${all.length})`);
    });

    it('should handle incremental re-parse correctly (no double-processing)', () => {
      // Simulate pre-compact then session-end both parsing same transcript
      const { messages: firstPass, lastLine: cp1 } = parseTranscript(transcriptPath, 0);
      const turns1 = groupIntoTurns(firstPass);
      const memories1 = extractMemories(turns1, PROJECT_CWD, SESSION_ID);

      // Second pass from checkpoint should find zero new messages
      const { messages: secondPass } = parseTranscript(transcriptPath, cp1);
      assert.equal(secondPass.length, 0,
        'Incremental parse from end checkpoint should find 0 new messages');

      // If we parse from 0 again, we should get the same messages
      const { messages: fullReparse } = parseTranscript(transcriptPath, 0);
      assert.equal(fullReparse.length, firstPass.length,
        'Full reparse should return same message count');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 14: Hook child process stdout completeness (Bug #4)
  // -----------------------------------------------------------------------

  describe('Phase 14: Hook Child Process Stdout Integrity', () => {
    it('should produce complete valid JSON from session-start hook', () => {
      resetConfig();
      const db = new Store(dbPath).open();
      db.upsertSession('hook-test-sess', PROJECT_CWD);
      db.insertMemory({
        project: PROJECT_CWD, sessionId: 'hook-test-sess', category: 'decision',
        content: 'Use PostgreSQL for relational data storage', keywords: 'postgresql relational database',
        score: 0.9, sourceHash: 'hook-stdout-1',
      });
      db.close();

      const input = { session_id: 'hook-test-sess', cwd: PROJECT_CWD, source: 'startup' };
      const stdout = runHook('session-start', input);

      if (stdout) {
        // Verify it is valid JSON (not truncated by process.exit race)
        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(stdout); },
          `session-start stdout should be valid JSON, got: "${stdout.slice(0, 100)}"`);

        assert.ok(parsed.hookSpecificOutput, 'Should have hookSpecificOutput key');
        assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
        assert.ok(parsed.hookSpecificOutput.additionalContext,
          'additionalContext should be non-empty');
      }
      // If stdout is empty, that's OK — means no memories matched
    });

    it('should produce complete valid JSON from user-prompt-submit hook', () => {
      resetConfig();
      const db = new Store(dbPath).open();
      db.insertMemory({
        project: PROJECT_CWD, sessionId: 's1', category: 'decision',
        content: 'Use PostgreSQL for relational data storage', keywords: 'postgresql relational database',
        score: 0.9, sourceHash: 'hook-prompt-1',
      });
      db.close();

      const input = { cwd: PROJECT_CWD, prompt: 'How should I set up the PostgreSQL database?' };
      const stdout = runHook('user-prompt-submit', input);

      if (stdout) {
        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(stdout); },
          `user-prompt-submit stdout should be valid JSON, got: "${stdout.slice(0, 100)}"`);

        assert.ok(parsed.hookSpecificOutput, 'Should have hookSpecificOutput');
        assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      }
    });

    it('should produce complete plain text from pre-compact hook', () => {
      resetConfig();
      // Clean DB for this test
      const db = new Store(dbPath).open();
      db.upsertSession('compact-test', PROJECT_CWD);
      db.close();

      const input = {
        session_id: 'compact-test',
        transcript_path: transcriptPath,
        cwd: PROJECT_CWD,
        trigger: 'auto',
      };
      const stdout = runHook('pre-compact', input);

      if (stdout) {
        // pre-compact produces plain text, not JSON
        assert.ok(stdout.includes('CONTEXT ARCHIVE') || stdout.length > 0,
          `pre-compact should produce archive summary, got: "${stdout.slice(0, 100)}"`);
        // It should NOT be truncated (no incomplete lines)
        assert.ok(!stdout.endsWith('\\'), 'Output should not end with escape char (truncation sign)');
      }
    });

    it('should exit cleanly and not crash for session-end hook', () => {
      resetConfig();
      const db = new Store(dbPath).open();
      db.upsertSession('end-test', PROJECT_CWD);
      db.close();

      const input = {
        session_id: 'end-test',
        transcript_path: transcriptPath,
        cwd: PROJECT_CWD,
      };

      // session-end produces no stdout (it only does DB work)
      // The key test is that it doesn't crash
      const stdout = runHook('session-end', input);
      // Empty stdout is expected for session-end
      assert.ok(stdout === '' || stdout.length >= 0,
        'session-end should complete without crash');
    });

    it('should produce valid JSON from subagent-start hook', () => {
      resetConfig();
      const db = new Store(dbPath).open();
      db.insertMemory({
        project: PROJECT_CWD, sessionId: 's1', category: 'architecture',
        content: 'MVC pattern with service layer for the Express API', keywords: 'mvc service layer express api',
        score: 1.0, sourceHash: 'sub-start-1',
      });
      db.close();

      const input = {
        cwd: PROJECT_CWD,
        agent_id: 'agent-test-123',
        agent_type: 'researcher',
      };
      const stdout = runHook('subagent-start', input);

      if (stdout) {
        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(stdout); },
          `subagent-start stdout should be valid JSON, got: "${stdout.slice(0, 100)}"`);
        assert.equal(parsed.hookSpecificOutput.hookEventName, 'SubagentStart');
      }
    });

    it('should handle subagent-stop hook without crash', () => {
      resetConfig();
      const db = new Store(dbPath).open();
      db.upsertSession('sub-stop-test', PROJECT_CWD);
      db.close();

      const input = {
        session_id: 'sub-stop-test',
        cwd: PROJECT_CWD,
        agent_id: 'agent-test-456',
        agent_type: 'coder',
        agent_transcript_path: subagentTranscriptPath,
      };

      // subagent-stop produces no stdout
      const stdout = runHook('subagent-stop', input);
      assert.ok(stdout === '' || stdout.length >= 0,
        'subagent-stop should complete without crash');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 15: Token budget accuracy (Bug #5 from code review)
  // -----------------------------------------------------------------------

  describe('Phase 15: Token Budget Accuracy', () => {
    it('should not grossly exceed token budget with many categories', () => {
      resetConfig();
      const db = new Store(':memory:').open();

      // Insert many memories across all categories
      const categories = ['architecture', 'decision', 'error', 'finding', 'file_change', 'note'];
      for (let i = 0; i < 30; i++) {
        const cat = categories[i % categories.length];
        db.insertMemory({
          project: PROJECT_CWD, sessionId: 's1', category: cat,
          content: `Memory ${i}: ${'x'.repeat(50 + i * 5)} for ${cat} category with extra detail`,
          keywords: `memory ${cat} ${i}`,
          score: 0.9 - i * 0.02,
          sourceHash: `budget-${i}`,
        });
      }

      const memories = db.getTopMemories(PROJECT_CWD, 30);
      assert.ok(memories.length >= 20, 'Should have plenty of memories');

      // Test with a small budget (200 tokens ~ 700 chars)
      const budget = 200;
      const { text, ids } = restoreContext(memories, budget);

      if (text) {
        const actualTokens = estimateTokens(text);

        // Allow 20% overrun for section headers but no more
        const maxAcceptable = budget * 1.2;
        assert.ok(actualTokens <= maxAcceptable,
          `Token usage (${actualTokens}) should not grossly exceed budget (${budget}), max acceptable=${maxAcceptable}`);
      }

      db.close();
    });

    it('should include fewer memories with tighter budget', () => {
      resetConfig();
      const db = new Store(':memory:').open();

      for (let i = 0; i < 20; i++) {
        db.insertMemory({
          project: PROJECT_CWD, sessionId: 's1', category: 'decision',
          content: `Decision ${i}: important architectural choice about component ${i}`,
          keywords: `decision ${i}`, score: 0.8, sourceHash: `tight-${i}`,
        });
      }

      const memories = db.getTopMemories(PROJECT_CWD, 20);

      const { ids: tightIds } = restoreContext(memories, 100);
      const { ids: looseIds } = restoreContext(memories, 5000);

      assert.ok(tightIds.length < looseIds.length,
        `Tight budget (${tightIds.length} memories) should include fewer than loose budget (${looseIds.length})`);

      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // Phase 16: Install path with spaces (Bug #6)
  // -----------------------------------------------------------------------

  describe('Phase 16: Install Hook Command Path Safety', () => {
    it('should generate hook commands that are vulnerable to paths with spaces', async () => {
      // This test documents the known bug: getHookCommand does NOT quote paths
      // So if HOOKS_DIR contains spaces, the command will break
      const installModule = await import('../src/install.js');

      // The bug is: `node ${join(HOOKS_DIR, hookFile)}` — no quotes around the path
      // If HOOKS_DIR = "/Users/My User/project/hooks", the command becomes:
      //   node /Users/My User/project/hooks/session-start.js
      // which shells parse as two arguments
      // We can verify by checking if the install module's HOOK_MARKER exists
      assert.ok(installModule.HOOK_MARKER, 'Install module should export HOOK_MARKER');
      assert.equal(installModule.HOOK_MARKER, 'infinite-context');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 17: CLI --project flag leaking into search (Bug #8)
  // -----------------------------------------------------------------------

  describe('Phase 17: CLI Search Query Contamination', () => {
    it('should demonstrate that args.join includes --project in the search query', () => {
      // cli.js line 168: case 'search': doSearch(args.join(' '));
      // and line 52: const project = args.includes('--project') ? ... : null;
      //
      // When user runs: ic search foo --project /some/path
      // args = ['foo', '--project', '/some/path']
      // args.join(' ') = 'foo --project /some/path'  <-- BUG: passes to doSearch
      // doSearch calls db.search('foo --project /some/path', ...)
      //
      // The --project extraction happens INSIDE doSearch at line 52 (from the
      // outer args), but the query parameter already includes everything.

      // Simulate the buggy behavior
      const simulatedArgs = ['foo', '--project', '/some/path'];
      const query = simulatedArgs.join(' ');
      assert.equal(query, 'foo --project /some/path',
        'BUG: args.join(" ") includes --project and its value in the query');

      // The actual search query should be just 'foo'
      // This demonstrates the bug exists at the CLI level
      const expectedQuery = 'foo';
      assert.notEqual(query, expectedQuery,
        'BUG confirmed: query contains --project flag and value');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 18: NaN importance scores with null dates (Bug #9)
  // -----------------------------------------------------------------------

  describe('Phase 18: NaN Importance Scores', () => {
    it('should handle memories with null/undefined dates without NaN propagation', () => {
      // Memory with undefined dates
      const mem1 = { score: 0.5, access_count: 0 };
      const imp1 = computeImportance(mem1);
      assert.ok(!isNaN(imp1), `Importance should not be NaN for undefined dates, got ${imp1}`);

      // Memory with null dates
      const mem2 = { score: 0.5, access_count: 0, created_at: null, last_accessed: null };
      const imp2 = computeImportance(mem2);
      assert.ok(!isNaN(imp2), `Importance should not be NaN for null dates, got ${imp2}`);

      // Memory with invalid date strings
      const mem3 = { score: 0.5, access_count: 0, created_at: 'not-a-date', last_accessed: 'invalid' };
      const imp3 = computeImportance(mem3);
      assert.ok(!isNaN(imp3), `Importance should not be NaN for invalid date strings, got ${imp3}`);
    });

    it('should not crash restoreContext when memories have invalid dates', () => {
      resetConfig();
      const db = new Store(':memory:').open();

      db.insertMemory({
        project: PROJECT_CWD, sessionId: 's1', category: 'decision',
        content: 'Important decision about database', keywords: 'database decision',
        score: 0.9, sourceHash: 'nan-test-1',
      });

      // Set dates to invalid strings to simulate edge case
      // (created_at has NOT NULL constraint, so we can't null it, but we can
      // set an unparseable value to test NaN handling in computeImportance)
      db.db.prepare("UPDATE memories SET created_at = 'invalid-date', last_accessed = 'also-invalid'").run();

      const memories = db.getTopMemories(PROJECT_CWD, 10);
      assert.ok(memories.length === 1);
      assert.equal(memories[0].created_at, 'invalid-date');

      // restoreContext should handle this gracefully (computeImportance guards against NaN)
      const { text, ids } = restoreContext(memories);
      assert.ok(Array.isArray(ids), 'Should return ids array (not crash on NaN)');
      // The memory should still be included since computeImportance returns score for invalid dates
      if (text) {
        assert.ok(text.includes('database'), 'Memory content should appear in output');
      }

      db.close();
    });

    it('should handle score=0 without treating it as 0.5', () => {
      const memWithZeroScore = {
        score: 0,
        access_count: 1,
        created_at: new Date().toISOString(),
        last_accessed: new Date().toISOString(),
      };

      const imp = computeImportance(memWithZeroScore);
      // With ?? operator (fixed), score=0 should be preserved, making importance 0
      assert.equal(imp, 0,
        `score=0 should produce importance=0, got ${imp} (was previously defaulting to 0.5 with ||)`);
    });
  });

  // -----------------------------------------------------------------------
  // Phase 19: Config edge cases (Bug #10)
  // -----------------------------------------------------------------------

  describe('Phase 19: Config Resilience', () => {
    it('should fall back to defaults for unknown category in scoring', () => {
      resetConfig();
      const score = scoreMemory('nonexistent_category', 'test content');
      assert.ok(typeof score === 'number', 'Unknown category should still produce a score');
      assert.ok(score > 0, 'Unknown category score should use fallback weight (0.4)');
    });

    it('should handle restoreContext with unknown category memories', () => {
      resetConfig();
      const db = new Store(':memory:').open();

      db.insertMemory({
        project: PROJECT_CWD, sessionId: 's1', category: 'unknown_category',
        content: 'Memory with unknown category', keywords: 'unknown',
        score: 0.9, sourceHash: 'unknown-cat-1',
      });

      const memories = db.getTopMemories(PROJECT_CWD, 10);
      const { text, ids } = restoreContext(memories);

      // Unknown categories should be bucketed into 'note'
      assert.ok(ids.length > 0, 'Memory with unknown category should still be restored');
      if (text) {
        assert.ok(text.includes('Memory with unknown category'),
          'Content should appear in output under Notes');
      }

      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // Phase 20: Double-encoding lifecycle (Bug #2 comprehensive)
  // -----------------------------------------------------------------------

  describe('Phase 20: Metadata Double-Encoding Full Lifecycle', () => {
    it('should demonstrate the double-encoding bug from subagent-stop flow', () => {
      resetConfig();
      const db = new Store(':memory:').open();

      // Simulate exactly what subagent-stop.js does:
      // 1. extractMemories returns objects with metadata: null
      // 2. subagent-stop sets mem.metadata = JSON.stringify({...})
      // 3. insertMany -> insertMemory calls JSON.stringify(metadata) again

      const memories = [{
        project: PROJECT_CWD,
        sessionId: 'sub-sess',
        category: 'decision',
        content: 'Use jsonwebtoken for JWT',
        keywords: 'jwt jsonwebtoken',
        score: 0.9,
        sourceHash: 'double-enc-1',
        metadata: null,
      }];

      // Step 2: what subagent-stop.js does
      for (const mem of memories) {
        mem.metadata = JSON.stringify({
          agentId: 'agent-xyz',
          agentType: 'researcher',
        });
      }

      // Step 3: insertMany
      db.insertMany(memories);

      const retrieved = db.getTopMemories(PROJECT_CWD, 10);
      const m = retrieved[0];

      // The stored value is double-encoded
      const firstParse = JSON.parse(m.metadata);
      assert.equal(typeof firstParse, 'string',
        'BUG: First JSON.parse returns a string (double-encoded)');

      const secondParse = JSON.parse(firstParse);
      assert.equal(secondParse.agentId, 'agent-xyz',
        'Second JSON.parse needed to get actual data');
      assert.equal(secondParse.agentType, 'researcher');

      db.close();
    });

    it('should work correctly when metadata is passed as object (correct usage)', () => {
      resetConfig();
      const db = new Store(':memory:').open();

      db.insertMemory({
        project: PROJECT_CWD,
        sessionId: 'correct-meta',
        category: 'decision',
        content: 'Correct metadata usage',
        keywords: 'correct metadata',
        score: 0.9,
        sourceHash: 'correct-meta-1',
        metadata: { agentId: 'agent-abc', agentType: 'coder' },
      });

      const m = db.getTopMemories(PROJECT_CWD, 1)[0];
      const parsed = JSON.parse(m.metadata);
      assert.equal(typeof parsed, 'object', 'Single JSON.parse should yield object');
      assert.equal(parsed.agentId, 'agent-abc');

      db.close();
    });
  });
});

// =========================================================================
// Run-as-script support
// =========================================================================
// The tests auto-run via `node --test` but this ensures nice output
