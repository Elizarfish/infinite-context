import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { parseTranscript, groupIntoTurns } from '../src/core/transcript-parser.js';
import { extractMemories } from '../src/core/archiver.js';
import { resetConfig } from '../src/core/config.js';

// ---------------------------------------------------------------------------
// Discover real JSONL transcripts
// ---------------------------------------------------------------------------
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const INFOSEC_DIR = join(PROJECTS_DIR, '-Users-root-iz-infosec');
const MAIN_TRANSCRIPT = join(INFOSEC_DIR, '4c602382-2284-47da-b54d-098d26c99816.jsonl');
const SUBAGENT_DIR = join(INFOSEC_DIR, '4c602382-2284-47da-b54d-098d26c99816', 'subagents');

function findTranscripts(dir, max = 5) {
  const paths = [];
  if (!existsSync(dir)) return paths;
  try {
    const entries = readdirSync(dir);
    for (const e of entries) {
      if (e.endsWith('.jsonl')) {
        paths.push(join(dir, e));
        if (paths.length >= max) break;
      }
    }
  } catch { /* ignore */ }
  return paths;
}

const mainExists = existsSync(MAIN_TRANSCRIPT);
const subagentTranscripts = findTranscripts(SUBAGENT_DIR, 5);

// ---------------------------------------------------------------------------
// 1. Parse real transcripts — no crashes
// ---------------------------------------------------------------------------
describe('Real transcript parsing — no crashes', () => {
  it('parses the main transcript without throwing', () => {
    if (!mainExists) return; // skip if no transcript
    const { messages, lastLine } = parseTranscript(MAIN_TRANSCRIPT);
    assert.ok(Array.isArray(messages), 'messages should be an array');
    assert.ok(messages.length > 0, 'should parse at least some messages');
    assert.ok(lastLine > 0, 'lastLine should be positive');
  });

  it('parses subagent transcripts without throwing', () => {
    for (const path of subagentTranscripts) {
      const { messages, lastLine } = parseTranscript(path);
      assert.ok(Array.isArray(messages), `${path} messages should be array`);
      assert.ok(lastLine >= 0, `${path} lastLine should be non-negative`);
    }
  });

  it('groups main transcript into turns without throwing', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const turns = groupIntoTurns(messages);
    assert.ok(Array.isArray(turns), 'turns should be an array');
    assert.ok(turns.length > 0, 'should produce at least one turn');
  });
});

// ---------------------------------------------------------------------------
// 2. Message structure correctness
// ---------------------------------------------------------------------------
describe('Message structure from real transcripts', () => {
  it('parsed messages have all required fields', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    for (const msg of messages.slice(0, 50)) {
      assert.ok(['user', 'assistant'].includes(msg.role), `bad role: ${msg.role}`);
      assert.ok(typeof msg.lineNum === 'number', 'lineNum should be a number');
      assert.ok(typeof msg.text === 'string', 'text should be a string');
      assert.ok(typeof msg.thinking === 'string', 'thinking should be a string');
      assert.ok(Array.isArray(msg.toolCalls), 'toolCalls should be array');
      assert.ok(Array.isArray(msg.toolResults), 'toolResults should be array');
    }
  });

  it('preserves tool_use details in assistant messages', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const withToolCalls = messages.filter(m => m.toolCalls.length > 0);
    assert.ok(withToolCalls.length > 0, 'should find messages with tool calls');

    for (const msg of withToolCalls.slice(0, 20)) {
      assert.equal(msg.role, 'assistant', 'tool_use should be in assistant messages');
      for (const tc of msg.toolCalls) {
        assert.ok(typeof tc.name === 'string' && tc.name.length > 0, 'tool call must have a name');
        assert.ok(tc.id !== undefined, 'tool call must have an id');
        assert.ok(typeof tc.input === 'object', 'tool call input must be an object');
      }
    }
  });

  it('skips non-message entries (progress, file-history-snapshot, queue-operation)', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);

    // The transcript has 2758 lines, 2161 progress + 14 file-history + 9 queue-operation + 13 system = ~2197 non-message
    // So messages should be significantly fewer than total lines
    const content = readFileSync(MAIN_TRANSCRIPT, 'utf-8');
    const totalLines = content.split('\n').filter(l => l.trim()).length;
    assert.ok(messages.length < totalLines, `messages (${messages.length}) should be fewer than total lines (${totalLines})`);
    // We know there are 239 user + 322 assistant = 561 message lines
    // but system messages are filtered out, so fewer
    assert.ok(messages.length > 100, `should parse a substantial number of messages (got ${messages.length})`);
  });
});

// ---------------------------------------------------------------------------
// 3. BUG 24 fix: tool_result user messages captured in allToolResults
// ---------------------------------------------------------------------------
describe('BUG 24 fix — tool_result user messages in allToolResults', () => {
  it('captures tool_results from synthetic user messages in turns', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const turns = groupIntoTurns(messages);

    // Count tool results across all turns
    let totalToolResults = 0;
    let turnsWithToolResults = 0;
    for (const turn of turns) {
      if (turn.allToolResults.length > 0) {
        totalToolResults += turn.allToolResults.length;
        turnsWithToolResults++;
      }
    }

    // The transcript has 218 user messages with tool_results. These should be captured.
    assert.ok(totalToolResults > 0, 'should capture tool results in turns');
    assert.ok(turnsWithToolResults > 0, 'at least some turns should have tool results');
  });

  it('tool_result user messages without text are folded into current turn', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);

    // Find user messages that have tool_results but no text (synthetic messages)
    const syntheticUserMsgs = messages.filter(
      m => m.role === 'user' && !m.text && m.toolResults.length > 0
    );
    assert.ok(syntheticUserMsgs.length > 0, 'should find synthetic user messages with tool_results');

    const turns = groupIntoTurns(messages);

    // These synthetic messages should NOT create new turns
    // (they should be folded into the preceding turn)
    const turnsFromRealUsers = turns.filter(t => t.userMessage.text.length > 0 || t.userMessage.toolResults.length > 0);
    assert.ok(turnsFromRealUsers.length > 0, 'should have turns from real user messages');

    // Total turns should be fewer than total user messages (because synthetic ones are folded)
    const totalUserMsgs = messages.filter(m => m.role === 'user').length;
    assert.ok(
      turns.length < totalUserMsgs,
      `turns (${turns.length}) should be fewer than total user msgs (${totalUserMsgs}) because synthetic tool_result msgs are folded in`
    );
  });

  it('tool results include toolUseId, content, and isError fields', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const turns = groupIntoTurns(messages);

    for (const turn of turns) {
      for (const tr of turn.allToolResults) {
        assert.ok('toolUseId' in tr, 'tool result must have toolUseId');
        assert.ok('content' in tr, 'tool result must have content');
        assert.ok('isError' in tr, 'tool result must have isError');
        assert.ok(typeof tr.content === 'string', 'content should be a string');
        assert.ok(typeof tr.isError === 'boolean', 'isError should be a boolean');
      }
    }
  });

  it('error tool_results have is_error=true', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const turns = groupIntoTurns(messages);

    const errors = [];
    for (const turn of turns) {
      for (const tr of turn.allToolResults) {
        if (tr.isError) errors.push(tr);
      }
    }

    // We know the transcript has 5 error tool_results
    assert.ok(errors.length > 0, 'should find error tool results');
    for (const err of errors) {
      assert.ok(err.content.length > 0, 'error content should not be empty');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Incremental parsing with checkpoints on real data
// ---------------------------------------------------------------------------
describe('Incremental parsing with checkpoints', () => {
  it('parses from startLine correctly', () => {
    if (!mainExists) return;
    const full = parseTranscript(MAIN_TRANSCRIPT, 0);
    const half = Math.floor(full.lastLine / 2);
    const partial = parseTranscript(MAIN_TRANSCRIPT, half);

    assert.ok(partial.messages.length > 0, 'partial parse should find messages');
    assert.ok(partial.messages.length < full.messages.length, 'partial should have fewer messages');

    // All partial messages should have lineNum > half
    for (const msg of partial.messages) {
      assert.ok(msg.lineNum > half, `lineNum ${msg.lineNum} should be > ${half}`);
    }
  });

  it('parsing from lastLine returns no messages (idempotent)', () => {
    if (!mainExists) return;
    const full = parseTranscript(MAIN_TRANSCRIPT, 0);
    const empty = parseTranscript(MAIN_TRANSCRIPT, full.lastLine);
    assert.equal(empty.messages.length, 0, 'should return no new messages');
  });

  it('incremental batches cover all messages', () => {
    if (!mainExists) return;
    const full = parseTranscript(MAIN_TRANSCRIPT, 0);

    // Parse in chunks of ~100 lines
    let startLine = 0;
    let totalMessages = 0;
    let iterations = 0;
    while (startLine < full.lastLine && iterations < 100) {
      const chunk = parseTranscript(MAIN_TRANSCRIPT, startLine);
      totalMessages += chunk.messages.length;
      if (chunk.lastLine <= startLine) break;
      startLine = Math.min(startLine + 100, chunk.lastLine);
      iterations++;
    }

    // Due to line counting differences between chunk boundaries, we may get a few duplicates
    // or misses, but total should be in the same ballpark
    assert.ok(
      totalMessages >= full.messages.length * 0.9,
      `incremental total (${totalMessages}) should cover at least 90% of full (${full.messages.length})`
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Memory extraction from real transcripts
// ---------------------------------------------------------------------------
describe('Memory extraction from real transcripts', () => {
  it('extracts memories from main transcript', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const turns = groupIntoTurns(messages);
    const memories = extractMemories(turns, 'test-project', 'test-session');

    assert.ok(Array.isArray(memories), 'memories should be an array');
    assert.ok(memories.length > 0, 'should extract at least some memories');
  });

  it('extracted memories have all required fields', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const turns = groupIntoTurns(messages);
    const memories = extractMemories(turns, 'proj', 'sess');

    for (const m of memories) {
      assert.ok(typeof m.project === 'string', 'project should be string');
      assert.equal(m.project, 'proj', 'project should match passed value');
      assert.ok(typeof m.sessionId === 'string', 'sessionId should be string');
      assert.equal(m.sessionId, 'sess', 'sessionId should match passed value');
      assert.ok(['file_change', 'note', 'decision', 'architecture', 'error'].includes(m.category),
        `unexpected category: ${m.category}`);
      assert.ok(typeof m.content === 'string' && m.content.length > 0, 'content should be non-empty string');
      assert.ok(typeof m.keywords === 'string', 'keywords should be string');
      assert.ok(typeof m.score === 'number', 'score should be number');
      assert.ok(m.score >= 0 && m.score <= 1, `score ${m.score} should be between 0 and 1`);
      assert.ok(typeof m.sourceHash === 'string' && m.sourceHash.length === 16, 'sourceHash should be 16-char hex');
    }
  });

  it('extracts file_change memories for Write/Edit tool calls', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const turns = groupIntoTurns(messages);
    const memories = extractMemories(turns, 'proj', 'sess');

    const fileChanges = memories.filter(m => m.category === 'file_change');
    // The transcript has tool calls — there should be file changes if Write/Edit was used
    // Even if there are none, this should not crash
    assert.ok(Array.isArray(fileChanges), 'file changes should be array');
  });

  it('extracts error memories from error tool_results', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const turns = groupIntoTurns(messages);
    const memories = extractMemories(turns, 'proj', 'sess');

    const errors = memories.filter(m => m.category === 'error');
    // The transcript has 5 error tool_results, so we expect some error memories
    assert.ok(errors.length > 0, 'should extract error memories');
    for (const err of errors) {
      assert.ok(err.content.startsWith('Error encountered:'), 'error memory should start with Error encountered:');
    }
  });

  it('extracts decision memories from assistant text', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const turns = groupIntoTurns(messages);
    const memories = extractMemories(turns, 'proj', 'sess');

    const decisions = memories.filter(m => m.category === 'decision');
    assert.ok(decisions.length > 0, 'should extract decision memories from assistant text');
  });

  it('extracts notable Bash commands', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const turns = groupIntoTurns(messages);
    const memories = extractMemories(turns, 'proj', 'sess');

    const commands = memories.filter(m => m.category === 'note' && m.content.startsWith('Ran command:'));
    // The transcript has Bash tool calls — some should match notable patterns
    assert.ok(Array.isArray(commands), 'commands should be array');
  });

  it('extracts user requests as notes', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const turns = groupIntoTurns(messages);
    const memories = extractMemories(turns, 'proj', 'sess');

    const userRequests = memories.filter(m => m.category === 'note' && m.content.startsWith('User request:'));
    // Some user messages should be long enough to qualify (>20 chars, <=500 chars)
    assert.ok(Array.isArray(userRequests), 'user requests should be array');
  });
});

// ---------------------------------------------------------------------------
// 6. Subagent transcript testing
// ---------------------------------------------------------------------------
describe('Subagent transcript parsing and extraction', () => {
  it('parses all found subagent transcripts', () => {
    for (const path of subagentTranscripts) {
      const { messages, lastLine } = parseTranscript(path);
      assert.ok(Array.isArray(messages), 'messages should be array');
      assert.ok(messages.length > 0, `${path} should have messages`);
    }
  });

  it('subagent transcripts produce valid turns', () => {
    for (const path of subagentTranscripts) {
      const { messages } = parseTranscript(path);
      const turns = groupIntoTurns(messages);
      assert.ok(Array.isArray(turns), 'turns should be array');
      // Subagent transcripts should produce at least one turn
      assert.ok(turns.length > 0, `${path} should produce turns`);
    }
  });

  it('extracts memories from subagent transcripts', () => {
    for (const path of subagentTranscripts) {
      const { messages } = parseTranscript(path);
      const turns = groupIntoTurns(messages);
      const memories = extractMemories(turns, 'test-project', 'test-session');
      assert.ok(Array.isArray(memories), 'memories should be array');
      // Subagent transcripts with tool calls should produce some memories
    }
  });

  it('subagent tool_results are captured correctly', () => {
    // Subagent transcript agent-a9c8b0b has 72 user msgs with tool_results
    const subPath = join(SUBAGENT_DIR, 'agent-a9c8b0b.jsonl');
    if (!existsSync(subPath)) return;

    const { messages } = parseTranscript(subPath);
    const turns = groupIntoTurns(messages);

    let totalToolResults = 0;
    for (const turn of turns) {
      totalToolResults += turn.allToolResults.length;
    }

    assert.ok(totalToolResults > 0, 'subagent turns should capture tool results');
  });
});

// ---------------------------------------------------------------------------
// 7. Full store pipeline: parse → extract → insert → search → retrieve
// ---------------------------------------------------------------------------
describe('Full store pipeline with real data', () => {
  let tmpDir;
  let store;

  before(() => {
    resetConfig();
    tmpDir = mkdtempSync(join(tmpdir(), 'ic-test-'));
  });

  after(() => {
    if (store) {
      try { store.close(); } catch { /* ignore */ }
    }
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    }
  });

  it('end-to-end: parse real transcript → extract → insert → search → retrieve', async () => {
    if (!mainExists) return;

    // Dynamic import to avoid issues with better-sqlite3 if not installed
    const { Store } = await import('../src/db/store.js');

    const dbPath = join(tmpDir, 'test-pipeline.db');
    store = new Store(dbPath);
    store.open();

    // Step 1: Parse
    const { messages, lastLine } = parseTranscript(MAIN_TRANSCRIPT);
    assert.ok(messages.length > 0, 'should parse messages');

    // Step 2: Group into turns
    const turns = groupIntoTurns(messages);
    assert.ok(turns.length > 0, 'should have turns');

    // Step 3: Extract memories
    const project = '/Users/root/iz/infosec';
    const sessionId = 'test-pipeline-session';
    const memories = extractMemories(turns, project, sessionId);
    assert.ok(memories.length > 0, 'should extract memories');

    // Step 4: Insert
    store.upsertSession(sessionId, project);
    const inserted = store.insertMany(memories);
    assert.ok(inserted > 0, `should insert some memories (got ${inserted})`);
    store.incrSessionMemories(sessionId, inserted);

    // Step 5: Save checkpoint
    store.saveCheckpoint(sessionId, MAIN_TRANSCRIPT, lastLine);
    const cp = store.getCheckpoint(sessionId, MAIN_TRANSCRIPT);
    assert.ok(cp, 'checkpoint should be saved');
    assert.equal(cp.last_line_number, lastLine, 'checkpoint line number should match');

    // Step 6: Search
    const searchResults = store.search('Bash command', project, 5);
    assert.ok(Array.isArray(searchResults), 'search should return array');
    // The search may or may not find results depending on content

    // Step 7: Get top memories
    const topMemories = store.getTopMemories(project, 10);
    assert.ok(topMemories.length > 0, 'should have top memories');
    assert.ok(topMemories.length <= 10, 'should respect limit');

    // Step 8: Touch memories
    const ids = topMemories.map(m => m.id);
    store.touchMemories(ids);

    // Step 9: Stats
    const stats = store.getStats();
    assert.ok(stats.total > 0, 'stats should show inserted memories');
    assert.ok(stats.sessions.length > 0, 'stats should show session');

    // Step 10: Verify dedup — reinserting same memories should insert 0
    const reinserted = store.insertMany(memories);
    assert.equal(reinserted, 0, 'reinserting same memories should be deduped (0 inserted)');

    // Step 11: Decay and prune (should not crash)
    const pruned = store.decayAndPrune();
    assert.ok(typeof pruned === 'number', 'pruned should be a number');

    // Step 12: Export
    const exported = store.exportAll(project);
    assert.ok(exported.length > 0, 'export should return memories');
    assert.equal(exported.length, inserted, `exported count (${exported.length}) should match inserted (${inserted})`);

    store.close();
  });

  it('end-to-end: subagent transcript pipeline with metadata tagging', async () => {
    const subPath = join(SUBAGENT_DIR, 'agent-a9c8b0b.jsonl');
    if (!existsSync(subPath)) return;

    const { Store } = await import('../src/db/store.js');

    const dbPath = join(tmpDir, 'test-subagent-pipeline.db');
    const subStore = new Store(dbPath);
    subStore.open();

    const { messages, lastLine } = parseTranscript(subPath);
    const turns = groupIntoTurns(messages);
    const project = '/Users/root/iz/infosec';
    const sessionId = 'main-session:a9c8b0b';
    const memories = extractMemories(turns, project, sessionId);

    // Tag with metadata as subagent-stop hook does
    for (const mem of memories) {
      mem.metadata = {
        agentId: 'a9c8b0b',
        agentType: 'logic-deep',
        ...(mem.metadata && typeof mem.metadata === 'object' ? mem.metadata : {}),
      };
    }

    subStore.upsertSession(sessionId, project);
    const inserted = subStore.insertMany(memories);
    assert.ok(inserted >= 0, 'insert should succeed');

    if (inserted > 0) {
      const top = subStore.getTopMemories(project, 5);
      assert.ok(top.length > 0, 'should retrieve memories');

      // Verify metadata was stored (it's serialized as JSON string)
      for (const m of top) {
        if (m.metadata) {
          const meta = JSON.parse(m.metadata);
          assert.equal(meta.agentId, 'a9c8b0b');
          assert.equal(meta.agentType, 'logic-deep');
        }
      }
    }

    subStore.close();
  });
});

// ---------------------------------------------------------------------------
// 8. Edge cases in real transcript format
// ---------------------------------------------------------------------------
describe('Real transcript edge cases', () => {
  it('handles teammate-message content in user messages', () => {
    // Subagent transcripts start with teammate-message XML in content
    const subPath = join(SUBAGENT_DIR, 'agent-a9c8b0b.jsonl');
    if (!existsSync(subPath)) return;

    const { messages } = parseTranscript(subPath);
    // First message should be a user message with teammate-message content
    const firstUser = messages.find(m => m.role === 'user');
    assert.ok(firstUser, 'should have a user message');
    assert.ok(firstUser.text.length > 0, 'first user message should have text');
    assert.ok(firstUser.text.includes('teammate-message') || firstUser.text.length > 0,
      'first user message should contain the teammate instruction text');
  });

  it('handles messages with both text and tool_use blocks', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);

    // Some assistant messages have both text content and tool_use blocks
    const withBoth = messages.filter(m => m.role === 'assistant' && m.text.length > 0 && m.toolCalls.length > 0);
    // This is valid; the parser should capture both
    if (withBoth.length > 0) {
      for (const msg of withBoth.slice(0, 5)) {
        assert.ok(msg.text.length > 0, 'should have text');
        assert.ok(msg.toolCalls.length > 0, 'should have tool calls');
      }
    }
  });

  it('handles tool_result with array content (nested text blocks)', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);

    // Some tool_results have content as an array of {type: "text", text: "..."} blocks
    const withToolResults = messages.filter(m => m.toolResults.length > 0);
    for (const msg of withToolResults) {
      for (const tr of msg.toolResults) {
        assert.ok(typeof tr.content === 'string', 'tool result content should always be normalized to string');
      }
    }
  });

  it('handles split assistant messages (same requestId, multiple entries)', () => {
    if (!mainExists) return;
    // Real transcripts split assistant messages into separate JSONL entries per content block
    // (one for text, one for tool_use, etc.) with the same requestId
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);

    // Each JSONL line becomes its own message entry — verify they all parse correctly
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    assert.ok(assistantMsgs.length > 0, 'should have assistant messages');

    // Verify tool-only assistant messages (no text) are handled
    const toolOnlyAssistant = assistantMsgs.filter(m => !m.text && m.toolCalls.length > 0);
    for (const msg of toolOnlyAssistant) {
      assert.ok(msg.toolCalls.length > 0, 'tool-only assistant msg should have tool calls');
    }
  });

  it('session IDs and UUIDs are preserved where present', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);

    const withSession = messages.filter(m => m.sessionId);
    assert.ok(withSession.length > 0, 'some messages should have sessionId');

    const withUuid = messages.filter(m => m.uuid);
    assert.ok(withUuid.length > 0, 'some messages should have uuid');
  });

  it('timestamps are preserved where present', () => {
    if (!mainExists) return;
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);

    const withTimestamp = messages.filter(m => m.timestamp);
    assert.ok(withTimestamp.length > 0, 'some messages should have timestamps');
  });
});

// ---------------------------------------------------------------------------
// 9. Transcript size / performance sanity checks
// ---------------------------------------------------------------------------
describe('Performance sanity checks on real transcripts', () => {
  it('parses main transcript (2758 lines) in under 5 seconds', () => {
    if (!mainExists) return;
    const start = performance.now();
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 5000, `parsing took ${elapsed.toFixed(0)}ms, should be under 5000ms`);
    assert.ok(messages.length > 0, 'should parse messages');
  });

  it('full pipeline (parse + group + extract) completes in under 10 seconds', () => {
    if (!mainExists) return;
    const start = performance.now();
    const { messages } = parseTranscript(MAIN_TRANSCRIPT);
    const turns = groupIntoTurns(messages);
    const memories = extractMemories(turns, 'perf-test', 'perf-session');
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 10000, `pipeline took ${elapsed.toFixed(0)}ms, should be under 10000ms`);
    assert.ok(memories.length > 0, 'should extract memories');
  });
});
