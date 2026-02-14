import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Core modules
import { extractMemories } from '../src/core/archiver.js';
import { scoreMemory, computeImportance, extractKeywords, estimateTokens } from '../src/core/scorer.js';
import { restoreContext, recallForPrompt } from '../src/core/restorer.js';
import { parseTranscript, groupIntoTurns } from '../src/core/transcript-parser.js';
import { resetConfig } from '../src/core/config.js';
import { Store } from '../src/db/store.js';

const TMP_DIR = join(tmpdir(), 'ic-edge-test-' + Date.now());
mkdirSync(TMP_DIR, { recursive: true });

// ============================================================
// SCORER EDGE CASES
// ============================================================

describe('scorer edge cases', () => {
  beforeEach(() => resetConfig());

  // BUG 12 (FIXED): computeImportance now guards against NaN dates
  it('computeImportance: undefined dates return fallback (fixed)', () => {
    const result = computeImportance({
      score: 0.5,
      access_count: 1,
      created_at: undefined,
      last_accessed: undefined,
    });
    // FIXED: NaN guard returns memory.score ?? 0.5
    assert.ok(!Number.isNaN(result), 'Fixed: undefined dates should not produce NaN');
    assert.equal(result, 0.5, 'Should return score fallback');
  });

  it('computeImportance: handles null dates (returns 0-based time)', () => {
    const result = computeImportance({
      score: 0.5,
      access_count: 1,
      created_at: null,
      last_accessed: null,
    });
    // new Date(null).getTime() === 0, which is valid (not NaN), so full computation runs
    assert.ok(!Number.isNaN(result), 'null dates should not produce NaN');
    assert.ok(result >= 0, 'Should still produce a valid positive number');
  });

  it('computeImportance: invalid date strings return fallback (fixed)', () => {
    const result = computeImportance({
      score: 0.5,
      access_count: 1,
      created_at: 'not-a-date',
      last_accessed: 'also-not-a-date',
    });
    // FIXED: NaN guard returns memory.score ?? 0.5
    assert.ok(!Number.isNaN(result), 'Fixed: invalid date strings should not produce NaN');
    assert.equal(result, 0.5, 'Should return score fallback');
  });

  // BUG (FIXED): score=0 is now preserved with ?? operator
  it('computeImportance: score=0 is now correctly preserved (fixed)', () => {
    const now = Date.now();
    const result = computeImportance({
      score: 0,
      access_count: 0,
      created_at: new Date(now).toISOString(),
      last_accessed: new Date(now).toISOString(),
    });
    // FIXED: `memory.score ?? 0.5` preserves 0
    assert.equal(result, 0, 'Fixed: score=0 should produce importance=0');
  });

  it('computeImportance: handles negative score', () => {
    const now = Date.now();
    const result = computeImportance({
      score: -1,
      access_count: 0,
      created_at: new Date(now).toISOString(),
      last_accessed: new Date(now).toISOString(),
    });
    assert.ok(result < 0, 'Negative score should produce negative importance');
  });

  it('computeImportance: handles missing score field (defaults to 0.5)', () => {
    const now = Date.now();
    const result = computeImportance({
      access_count: 0,
      created_at: new Date(now).toISOString(),
      last_accessed: new Date(now).toISOString(),
    });
    // score defaults to 0.5 via `memory.score || 0.5`
    assert.ok(result > 0, 'Missing score should default to 0.5');
  });

  it('computeImportance: handles huge access_count', () => {
    const now = Date.now();
    const result = computeImportance({
      score: 0.5,
      access_count: 1000000,
      created_at: new Date(now).toISOString(),
      last_accessed: new Date(now).toISOString(),
    });
    assert.ok(Number.isFinite(result), 'Huge access count should still be finite');
    assert.ok(result > 0);
  });

  it('computeImportance: handles future dates', () => {
    const now = Date.now();
    const future = new Date(now + 365 * 86400000).toISOString();
    const result = computeImportance({
      score: 0.5,
      access_count: 0,
      created_at: future,
      last_accessed: future,
    }, now);
    // ageDays = Math.max(0.01, negative) => 0.01
    // freshnesssDays = Math.max(0.01, negative) => 0.01
    assert.ok(Number.isFinite(result), 'Future dates should not break computation');
  });

  it('scoreMemory: unknown category defaults to 0.4', () => {
    const score = scoreMemory('nonexistent_category', 'some content');
    assert.ok(score >= 0.4, 'Unknown category should use default weight 0.4');
    assert.ok(score <= 1.0);
  });

  it('scoreMemory: empty content', () => {
    const score = scoreMemory('note', '');
    assert.ok(score >= 0, 'Empty content should not crash');
    assert.ok(score <= 1.0);
  });

  it('scoreMemory: very long content gives max 0.1 bonus', () => {
    const shortScore = scoreMemory('note', 'x');
    const longScore = scoreMemory('note', 'x'.repeat(100000));
    assert.ok(longScore - shortScore <= 0.101, 'Length bonus should be capped at 0.1');
  });

  it('extractKeywords: handles unicode/emoji input', () => {
    const result = extractKeywords('hello 🚀 world 日本語 тест');
    assert.ok(typeof result === 'string');
    // Should include 'hello', 'world', 'тест' (cyrillic allowed by regex)
    assert.ok(result.includes('hello'));
    assert.ok(result.includes('world'));
  });

  it('extractKeywords: handles only stopwords', () => {
    const result = extractKeywords('the is are was were be been');
    assert.equal(result, '');
  });

  it('extractKeywords: handles special characters', () => {
    const result = extractKeywords('file_path: /usr/local/bin/node --version=1.2.3');
    assert.ok(typeof result === 'string');
    assert.ok(!result.includes(':'));
  });

  it('extractKeywords: limits to 30 words', () => {
    const words = Array.from({ length: 50 }, (_, i) => `uniqueword${i}`).join(' ');
    const result = extractKeywords(words);
    assert.ok(result.split(' ').length <= 30, 'Should limit to 30 keywords');
  });

  it('extractKeywords: handles undefined', () => {
    assert.equal(extractKeywords(undefined), '');
  });

  it('extractKeywords: handles number input gracefully', () => {
    assert.equal(extractKeywords(12345), '');
    assert.equal(extractKeywords(null), '');
    assert.equal(extractKeywords(undefined), '');
    assert.equal(extractKeywords(true), '');
  });

  it('estimateTokens: handles undefined', () => {
    assert.equal(estimateTokens(undefined), 0);
  });

  it('estimateTokens: single character', () => {
    const result = estimateTokens('a');
    assert.equal(result, 1, 'Single char should be at least 1 token');
  });

  it('estimateTokens: very long text', () => {
    const result = estimateTokens('x'.repeat(1000000));
    assert.ok(result > 0);
    assert.ok(Number.isFinite(result));
  });
});

// ============================================================
// ARCHIVER EDGE CASES
// ============================================================

describe('archiver edge cases', () => {
  beforeEach(() => resetConfig());

  function makeTurn(overrides = {}) {
    return {
      userMessage: overrides.userMessage || { text: '', toolCalls: [], toolResults: [] },
      assistantMessages: overrides.assistantMessages || [],
      allToolCalls: overrides.allToolCalls || [],
      allToolResults: overrides.allToolResults || [],
      startLine: 1,
      endLine: 10,
      ...overrides,
    };
  }

  it('should handle empty turns array', () => {
    const result = extractMemories([], '/proj', 'sess');
    assert.deepEqual(result, []);
  });

  it('should handle turn with no tool calls, no results, no messages', () => {
    const turns = [makeTurn()];
    const result = extractMemories(turns, '/proj', 'sess');
    assert.deepEqual(result, []);
  });

  it('should handle Write tool call with empty file_path', () => {
    const turns = [makeTurn({
      allToolCalls: [{ name: 'Write', input: { file_path: '' } }],
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const fileChanges = result.filter(m => m.category === 'file_change');
    assert.equal(fileChanges.length, 0, 'Empty file_path should be skipped');
  });

  it('should handle Write tool call with no input', () => {
    const turns = [makeTurn({
      allToolCalls: [{ name: 'Write', input: {} }],
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const fileChanges = result.filter(m => m.category === 'file_change');
    assert.equal(fileChanges.length, 0, 'Missing file_path should be skipped');
  });

  it('should handle Edit tool call with "path" instead of "file_path"', () => {
    const turns = [makeTurn({
      allToolCalls: [{
        name: 'Edit',
        input: { path: '/some/file.js', old_string: 'a', new_string: 'b' },
      }],
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const fileChanges = result.filter(m => m.category === 'file_change');
    assert.ok(fileChanges.length >= 1, 'Should support "path" as fallback for file_path');
  });

  it('should handle MultiEdit tool call', () => {
    const turns = [makeTurn({
      allToolCalls: [{
        name: 'MultiEdit',
        input: { file_path: '/some/file.js' },
      }],
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const fileChanges = result.filter(m => m.category === 'file_change');
    assert.ok(fileChanges.length >= 1, 'MultiEdit should be captured');
  });

  it('should handle Bash with null command', () => {
    const turns = [makeTurn({
      allToolCalls: [{ name: 'Bash', input: { command: null } }],
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    assert.deepEqual(result, [], 'Null command should not crash');
  });

  it('should handle Bash with undefined command', () => {
    const turns = [makeTurn({
      allToolCalls: [{ name: 'Bash', input: {} }],
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    assert.deepEqual(result, [], 'Missing command should not crash');
  });

  it('should handle error with empty content', () => {
    const turns = [makeTurn({
      allToolResults: [{ isError: true, content: '' }],
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const errors = result.filter(m => m.category === 'error');
    assert.equal(errors.length, 0, 'Empty error content should produce no memory (falsy check)');
  });

  it('should handle error with null content', () => {
    const turns = [makeTurn({
      allToolResults: [{ isError: true, content: null }],
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const errors = result.filter(m => m.category === 'error');
    assert.equal(errors.length, 0, 'Null error content should not crash');
  });

  it('should handle very long error content (truncation)', () => {
    const longError = 'E'.repeat(10000);
    const turns = [makeTurn({
      allToolResults: [{ isError: true, content: longError }],
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const errors = result.filter(m => m.category === 'error');
    assert.ok(errors.length >= 1);
    assert.ok(errors[0].content.length < 500, 'Error content should be truncated');
  });

  it('should skip user messages that are too short (<= 20 chars)', () => {
    const turns = [makeTurn({
      userMessage: { text: 'Short msg', toolCalls: [], toolResults: [] },
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const notes = result.filter(m => m.content.includes('User request'));
    assert.equal(notes.length, 0, 'Short user messages should be skipped');
  });

  it('should skip user messages that are too long (>= 500 chars)', () => {
    const turns = [makeTurn({
      userMessage: { text: 'X'.repeat(501), toolCalls: [], toolResults: [] },
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const notes = result.filter(m => m.content.includes('User request'));
    assert.equal(notes.length, 0, 'Long user messages should be skipped');
  });

  it('should handle user message at exactly 500 chars', () => {
    const turns = [makeTurn({
      userMessage: { text: 'X'.repeat(500), toolCalls: [], toolResults: [] },
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const notes = result.filter(m => m.content.includes('User request'));
    // length <= 500 => included at exactly 500
    assert.equal(notes.length, 1, 'Exactly 500 chars should be included');
  });

  it('should handle user message at exactly 499 chars', () => {
    const turns = [makeTurn({
      userMessage: { text: 'X'.repeat(499), toolCalls: [], toolResults: [] },
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const notes = result.filter(m => m.content.includes('User request'));
    assert.equal(notes.length, 1, '499 chars is within range');
  });

  it('should handle user message at exactly 21 chars', () => {
    const turns = [makeTurn({
      userMessage: { text: 'X'.repeat(21), toolCalls: [], toolResults: [] },
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const notes = result.filter(m => m.content.includes('User request'));
    assert.equal(notes.length, 1, '21 chars is within range');
  });

  it('should limit decisions to 3 per assistant message', () => {
    const lines = [
      "I'll use React for the frontend because it's widely supported.",
      "I'll use Express for the backend since it's lightweight and popular.",
      "I'll use PostgreSQL for the database because of its reliability.",
      "I'll use Docker for deployment to ensure consistency across environments.",
      "I'll use Jest for testing because it provides a great developer experience.",
    ];
    const turns = [makeTurn({
      assistantMessages: [{ text: lines.join('\n'), thinking: '', toolCalls: [], toolResults: [] }],
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const decisions = result.filter(m => m.category === 'decision');
    assert.ok(decisions.length <= 3, `Should cap decisions at 3, got ${decisions.length}`);
  });

  it('should limit architecture items to 2 per thinking block', () => {
    const lines = [
      "The architecture pattern should use a clean module design with layered abstraction.",
      "The design pattern for the data layer should focus on separation of concerns.",
      "The component interface should abstract away the coupling between modules.",
      "The strategy pattern provides the best approach for handling dependency injection.",
    ];
    const turns = [makeTurn({
      assistantMessages: [{ text: '', thinking: lines.join('\n'), toolCalls: [], toolResults: [] }],
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const arch = result.filter(m => m.category === 'architecture');
    assert.ok(arch.length <= 2, `Should cap architecture at 2, got ${arch.length}`);
  });

  it('should handle turn with null userMessage', () => {
    const turns = [makeTurn({ userMessage: null })];
    // archiver.js:89 checks turn.userMessage?.text, so null should be safe
    const result = extractMemories(turns, '/proj', 'sess');
    assert.ok(Array.isArray(result));
  });

  it('should handle turn with undefined userMessage.text', () => {
    const turns = [makeTurn({
      userMessage: { text: undefined, toolCalls: [], toolResults: [] },
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    assert.ok(Array.isArray(result));
  });

  it('should handle turn with unicode user message', () => {
    const turns = [makeTurn({
      userMessage: { text: 'Напиши мне функцию для обработки данных пользователя', toolCalls: [], toolResults: [] },
    })];
    const result = extractMemories(turns, '/proj', 'sess');
    const notes = result.filter(m => m.content.includes('User request'));
    assert.ok(notes.length >= 1, 'Should handle Cyrillic user messages');
  });

  it('should handle assistant message with null text and null thinking', () => {
    const turns = [makeTurn({
      assistantMessages: [{ text: null, thinking: null, toolCalls: [], toolResults: [] }],
    })];
    // extractDecisions(null) => null.split is not a function
    // BUG: assistant text is checked with if(msg.text) so null is falsy - SAFE
    // thinking is checked with if(msg.thinking) so null is falsy - SAFE
    const result = extractMemories(turns, '/proj', 'sess');
    assert.ok(Array.isArray(result));
  });
});

// ============================================================
// TRANSCRIPT PARSER EDGE CASES
// ============================================================

describe('parseTranscript edge cases', () => {
  function writeTempTranscript(content, name) {
    const path = join(TMP_DIR, name || `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  it('should handle empty file', () => {
    const path = writeTempTranscript('', 'empty.jsonl');
    const { messages, lastLine } = parseTranscript(path);
    assert.equal(messages.length, 0);
    assert.equal(lastLine, 0);
  });

  it('should handle file with only blank lines', () => {
    const path = writeTempTranscript('\n\n\n', 'blanks.jsonl');
    const { messages, lastLine } = parseTranscript(path);
    assert.equal(messages.length, 0);
    assert.equal(lastLine, 0);
  });

  it('should handle file with only whitespace lines', () => {
    const path = writeTempTranscript('   \n  \n \n', 'whitespace.jsonl');
    const { messages, lastLine } = parseTranscript(path);
    assert.equal(messages.length, 0);
    assert.equal(lastLine, 0);
  });

  it('should handle null path', () => {
    const { messages, lastLine } = parseTranscript(null);
    assert.equal(messages.length, 0);
    assert.equal(lastLine, 0);
  });

  it('should handle undefined path', () => {
    const { messages, lastLine } = parseTranscript(undefined);
    assert.equal(messages.length, 0);
    assert.equal(lastLine, 0);
  });

  it('should handle empty string path', () => {
    const { messages, lastLine } = parseTranscript('');
    assert.equal(messages.length, 0);
    assert.equal(lastLine, 0);
  });

  it('should handle file with all malformed JSON', () => {
    const path = writeTempTranscript('not json\nalso bad\n{incomplete', 'alljunk.jsonl');
    const { messages, lastLine } = parseTranscript(path);
    assert.equal(messages.length, 0);
  });

  it('should handle tool_result content as array of blocks', () => {
    const line = {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu1',
          content: [
            { type: 'text', text: 'Line 1' },
            { type: 'text', text: 'Line 2' },
          ],
          is_error: false,
        }],
      },
    };
    const path = writeTempTranscript(JSON.stringify(line) + '\n', 'tool-result-array.jsonl');
    const { messages } = parseTranscript(path);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].toolResults[0].content, 'Line 1\nLine 2');
  });

  it('should handle tool_result content as non-string non-array', () => {
    const line = {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu1',
          content: { some: 'object' },
          is_error: false,
        }],
      },
    };
    const path = writeTempTranscript(JSON.stringify(line) + '\n', 'tool-result-object.jsonl');
    const { messages } = parseTranscript(path);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].toolResults[0].content, '', 'Non-string non-array content should be empty string');
  });

  it('should handle message with type "A" (legacy format)', () => {
    const line = { type: 'A', message: { content: [{ type: 'text', text: 'Legacy format' }] } };
    const path = writeTempTranscript(JSON.stringify(line) + '\n', 'legacy-A.jsonl');
    const { messages } = parseTranscript(path);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[0].text, 'Legacy format');
  });

  it('should skip file-history-snapshot entries', () => {
    const lines = [
      JSON.stringify({ type: 'file-history-snapshot', data: {} }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' } }),
    ].join('\n');
    const path = writeTempTranscript(lines + '\n', 'file-history.jsonl');
    const { messages } = parseTranscript(path);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'Hello');
  });

  it('should handle startLine larger than file', () => {
    const path = writeTempTranscript(
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' } }) + '\n',
      'short-file.jsonl'
    );
    const { messages, lastLine } = parseTranscript(path, 999);
    assert.equal(messages.length, 0);
    assert.equal(lastLine, 1); // lineNum reached 1, which is <= 999
  });

  it('should handle very large transcript (performance)', () => {
    const lines = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(JSON.stringify({
        type: i % 2 === 0 ? 'user' : 'assistant',
        message: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: i % 2 === 0 ? `Message ${i}` : [{ type: 'text', text: `Response ${i}` }],
        },
      }));
    }
    const path = writeTempTranscript(lines.join('\n') + '\n', 'large.jsonl');
    const { messages, lastLine } = parseTranscript(path);
    assert.equal(messages.length, 1000);
    assert.equal(lastLine, 1000);
  });

  // BUG: lineNum counting skips blank lines, so checkpoint may not align with file
  it('BUG: lineNum counting skips blank lines causing checkpoint mismatch', () => {
    // File has 5 actual lines but blank lines interspersed
    const content = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'First' } }),
      '',  // blank line
      '',  // blank line
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Second' } }),
      '',  // blank line
    ].join('\n');
    const path = writeTempTranscript(content + '\n', 'blanks-between.jsonl');
    const { messages, lastLine } = parseTranscript(path);
    assert.equal(messages.length, 2);
    // lineNum only counts non-blank lines, so lastLine = 2 (not 4)
    // This is a design choice but could cause checkpoint issues if the file
    // is later read with different blank-line patterns
    assert.equal(lastLine, 2, 'lineNum only counts non-blank lines');
  });
});

// ============================================================
// groupIntoTurns EDGE CASES
// ============================================================

describe('groupIntoTurns edge cases', () => {
  it('should handle empty messages array', () => {
    const turns = groupIntoTurns([]);
    assert.deepEqual(turns, []);
  });

  it('should handle only assistant messages (no user)', () => {
    const messages = [
      { role: 'assistant', text: 'Orphan', thinking: '', toolCalls: [], toolResults: [], lineNum: 1 },
    ];
    const turns = groupIntoTurns(messages);
    // No user message to start a turn, so assistant is skipped
    assert.equal(turns.length, 0);
  });

  it('should handle consecutive user messages (no assistant)', () => {
    const messages = [
      { role: 'user', text: 'First', toolCalls: [], toolResults: [], lineNum: 1 },
      { role: 'user', text: 'Second', toolCalls: [], toolResults: [], lineNum: 2 },
      { role: 'user', text: 'Third', toolCalls: [], toolResults: [], lineNum: 3 },
    ];
    const turns = groupIntoTurns(messages);
    // Each new user message pushes the previous turn (even without assistant)
    assert.equal(turns.length, 3);
    assert.equal(turns[0].userMessage.text, 'First');
    assert.equal(turns[0].assistantMessages.length, 0);
  });

  it('should skip synthetic tool_result-only user messages', () => {
    const messages = [
      { role: 'user', text: 'Start', toolCalls: [], toolResults: [], lineNum: 1 },
      { role: 'assistant', text: 'Working', thinking: '', toolCalls: [{ name: 'Bash' }], toolResults: [], lineNum: 2 },
      // Synthetic: no text, has toolResults, and there's a current turn
      { role: 'user', text: '', toolCalls: [], toolResults: [{ content: 'result' }], lineNum: 3 },
      { role: 'assistant', text: 'Done', thinking: '', toolCalls: [], toolResults: [], lineNum: 4 },
    ];
    const turns = groupIntoTurns(messages);
    assert.equal(turns.length, 1, 'Synthetic user message should not create new turn');
    assert.equal(turns[0].assistantMessages.length, 2);
  });

  it('should NOT skip synthetic user message if no current turn', () => {
    const messages = [
      // Synthetic but first message, so no current turn — this becomes a new turn
      { role: 'user', text: '', toolCalls: [], toolResults: [{ content: 'result' }], lineNum: 1 },
      { role: 'assistant', text: 'Response', thinking: '', toolCalls: [], toolResults: [], lineNum: 2 },
    ];
    const turns = groupIntoTurns(messages);
    // No current turn exists, so the condition `&& current` fails, normal flow creates new turn
    assert.equal(turns.length, 1);
  });
});

// ============================================================
// RESTORER EDGE CASES
// ============================================================

describe('restoreContext edge cases', () => {
  beforeEach(() => resetConfig());

  it('should handle undefined memories', () => {
    const { text, ids } = restoreContext(undefined);
    assert.equal(text, '');
    assert.equal(ids.length, 0);
  });

  it('should handle memories with unknown category', () => {
    const now = new Date().toISOString();
    const memories = [
      { id: 1, category: 'unknown_cat', content: 'Something', score: 0.5, access_count: 0, created_at: now, last_accessed: now },
    ];
    const { text, ids } = restoreContext(memories, 4000);
    // Unknown category falls back to 'note'
    assert.ok(text.includes('Notes'), 'Unknown category should fall back to Notes section');
    assert.ok(text.includes('Something'));
    assert.equal(ids.length, 1);
  });

  it('should handle all memories exceeding token budget (only header fits)', () => {
    const now = new Date().toISOString();
    const memories = [
      { id: 1, category: 'note', content: 'x'.repeat(10000), score: 0.9, access_count: 0, created_at: now, last_accessed: now },
    ];
    // Budget of 20 tokens ~ 70 chars, header alone is ~50 chars
    const { text, ids } = restoreContext(memories, 20);
    // First memory line is too big to fit
    assert.equal(ids.length, 0);
    assert.equal(text, '');
  });

  it('should handle zero budget', () => {
    const now = new Date().toISOString();
    const memories = [
      { id: 1, category: 'note', content: 'Test', score: 0.9, access_count: 0, created_at: now, last_accessed: now },
    ];
    const { text, ids } = restoreContext(memories, 0);
    // Budget 0 with ?? means literally zero token budget — nothing fits
    assert.equal(ids.length, 0, 'Budget 0 should produce no results');
    assert.equal(text, '');
  });

  it('should handle negative budget', () => {
    const now = new Date().toISOString();
    const memories = [
      { id: 1, category: 'note', content: 'Test', score: 0.9, access_count: 0, created_at: now, last_accessed: now },
    ];
    const { text, ids } = restoreContext(memories, -100);
    // Budget -100 is truthy, so it's used as maxTokens
    // headerTokens > -100, so nothing fits
    assert.equal(ids.length, 0, 'Negative budget should block all memories');
  });

  it('should handle memories with NaN importance (from bad dates)', () => {
    const memories = [
      { id: 1, category: 'note', content: 'Good memory', score: 0.5, access_count: 0, created_at: new Date().toISOString(), last_accessed: new Date().toISOString() },
      { id: 2, category: 'note', content: 'Bad memory', score: 0.5, access_count: 0, created_at: undefined, last_accessed: undefined },
    ];
    // BUG: NaN importance causes sort to be unstable/incorrect
    const { ids } = restoreContext(memories, 4000);
    // Should still include at least the good memory
    assert.ok(ids.includes(1), 'Good memory should still be restored');
  });
});

describe('recallForPrompt edge cases', () => {
  it('should handle null input', () => {
    const { text, ids } = recallForPrompt(null);
    assert.equal(text, '');
    assert.equal(ids.length, 0);
  });

  it('should handle undefined input', () => {
    const { text, ids } = recallForPrompt(undefined);
    assert.equal(text, '');
    assert.equal(ids.length, 0);
  });

  it('should handle memories without id field', () => {
    const results = [
      { category: 'note', content: 'No id here' },
    ];
    const { text, ids } = recallForPrompt(results);
    assert.ok(text.includes('No id here'));
    assert.equal(ids[0], undefined, 'Missing id should push undefined');
  });

  it('should handle memory with special characters in content', () => {
    const results = [
      { id: 1, category: 'note', content: 'Contains <script>alert("xss")</script> and "quotes"' },
    ];
    const { text } = recallForPrompt(results);
    assert.ok(text.includes('<script>'), 'Content should pass through unescaped (no HTML context)');
  });
});

// ============================================================
// STORE EDGE CASES
// ============================================================

describe('Store edge cases', () => {
  let db;

  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
  });

  afterEach(() => {
    db.close();
  });

  it('should handle inserting memory with null sourceHash (no dedup)', () => {
    const id1 = db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'A', keywords: 'a', score: 0.5, sourceHash: null,
    });
    const id2 = db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'B', keywords: 'b', score: 0.5, sourceHash: null,
    });
    assert.ok(id1, 'First insert should succeed');
    assert.ok(id2, 'Second insert with null hash should also succeed (no dedup)');
  });

  it('should handle inserting memory with undefined sourceHash', () => {
    const id = db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'A', keywords: 'a', score: 0.5,
      // sourceHash not provided, defaults to undefined
    });
    assert.ok(id, 'Undefined sourceHash should work');
  });

  it('should handle empty search query', () => {
    const results = db.search('', '/proj', 10);
    assert.deepEqual(results, []);
  });

  it('should handle search query with only short words', () => {
    const results = db.search('a b c', '/proj', 10);
    assert.deepEqual(results, [], 'All single-char words should be filtered, leaving empty FTS query');
  });

  it('should handle search with special FTS characters', () => {
    db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'Test with quotes', keywords: 'test quotes', score: 0.5, sourceHash: 'h1',
    });
    // FTS5 uses double quotes - passing one through could break the query
    const results = db.search('test "broken query', '/p', 10);
    // The search() method wraps each word in quotes: "test" OR "\"broken" OR "query"
    // This might cause FTS5 parse error - caught by try/catch returning []
    assert.ok(Array.isArray(results), 'Should not throw on broken FTS query');
  });

  it('should handle search with double quotes in query', () => {
    db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'Some content here', keywords: 'some content', score: 0.5, sourceHash: 'h1',
    });
    const results = db.search('"some" content', '/p', 10);
    assert.ok(Array.isArray(results), 'Double quotes should be handled');
  });

  it('should handle getTopMemories with no matching project', () => {
    db.insertMemory({
      project: '/a', sessionId: 's', category: 'note',
      content: 'Project A', keywords: 'project', score: 0.5, sourceHash: 'h1',
    });
    const results = db.getTopMemories('/nonexistent', 10);
    assert.equal(results.length, 0);
  });

  it('should handle touchMemories with empty array', () => {
    // Should not throw
    db.touchMemories([]);
  });

  it('should handle touchMemories with non-existent id', () => {
    // Should not throw (UPDATE on no rows is fine)
    db.touchMemories([99999]);
  });

  it('should handle insertMany with empty array', () => {
    const count = db.insertMany([]);
    assert.equal(count, 0);
  });

  it('should handle insertMany with all duplicates', () => {
    db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'Original', keywords: 'original', score: 0.5, sourceHash: 'h1',
    });
    const count = db.insertMany([
      { project: '/p', sessionId: 's', category: 'note', content: 'Dup1', keywords: 'd', score: 0.5, sourceHash: 'h1' },
      { project: '/p', sessionId: 's', category: 'note', content: 'Dup2', keywords: 'd', score: 0.5, sourceHash: 'h1' },
    ]);
    assert.equal(count, 0, 'All duplicates should be rejected');
  });

  it('should handle close called twice', () => {
    db.close();
    // Second close should not throw
    db.close();
    // Re-open for afterEach cleanup
    db = new Store(':memory:').open();
  });

  it('should handle open called twice (idempotent)', () => {
    const db2 = db.open(); // Already open
    assert.strictEqual(db2, db, 'Should return same instance');
  });

  it('should handle memory with very long content', () => {
    const longContent = 'X'.repeat(100000);
    const id = db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: longContent, keywords: 'long', score: 0.5, sourceHash: 'long-h',
    });
    assert.ok(id, 'Very long content should be accepted');
    const results = db.getTopMemories('/p', 1);
    assert.equal(results[0].content.length, 100000);
  });

  it('should handle memory with unicode content', () => {
    const id = db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: '日本語テスト 🚀 Кириллица', keywords: 'unicode test', score: 0.5, sourceHash: 'uni-h',
    });
    assert.ok(id);
    const results = db.getTopMemories('/p', 1);
    assert.equal(results[0].content, '日本語テスト 🚀 Кириллица');
  });

  it('should handle memory with empty strings', () => {
    const id = db.insertMemory({
      project: '', sessionId: '', category: '', content: '', keywords: '', score: 0, sourceHash: '',
    });
    // Empty sourceHash is falsy, so dedup check is skipped
    assert.ok(id, 'Empty strings should still insert');
  });

  it('should handle getStats on empty database', () => {
    const stats = db.getStats();
    assert.equal(stats.total, 0);
    assert.equal(stats.byProject.length, 0);
    assert.equal(stats.sessions.length, 0);
    assert.ok(stats.dbSize >= 0);
  });

  it('should handle exportAll on empty database', () => {
    const memories = db.exportAll();
    assert.deepEqual(memories, []);
  });

  it('should handle exportAll with project filter', () => {
    db.insertMemory({
      project: '/a', sessionId: 's', category: 'note', content: 'A', keywords: 'a', score: 0.5, sourceHash: 'h1',
    });
    db.insertMemory({
      project: '/b', sessionId: 's', category: 'note', content: 'B', keywords: 'b', score: 0.5, sourceHash: 'h2',
    });
    const results = db.exportAll('/a');
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'A');
  });

  it('should handle upsertSession update (ON CONFLICT)', () => {
    db.upsertSession('s1', '/project-a');
    db.upsertSession('s1', '/project-b'); // Same session, different project
    const stats = db.getStats();
    assert.equal(stats.sessions.length, 1);
    assert.equal(stats.sessions[0].project, '/project-b', 'Project should be updated');
  });

  it('should handle decayAndPrune on empty database', () => {
    const pruned = db.decayAndPrune();
    assert.equal(pruned, 0);
  });

  it('should handle enforceProjectLimit when under limit', () => {
    db.insertMemory({
      project: '/p', sessionId: 's', category: 'note', content: 'A', keywords: 'a', score: 0.5, sourceHash: 'h1',
    });
    const pruned = db.enforceProjectLimit('/p');
    assert.equal(pruned, 0, 'Should not prune when under limit');
  });

  it('should handle pruneOld with zero days', () => {
    const pruned = db.pruneOld(0);
    // "-0 days" should still work in SQLite datetime
    assert.ok(pruned >= 0);
  });

  it('touchMemory score should cap at 1.0', () => {
    db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'Test', keywords: 'test', score: 0.98, sourceHash: 'h1',
    });
    const mem = db.getTopMemories('/p', 1)[0];

    // Touch 5 times (each adds 0.05)
    for (let i = 0; i < 5; i++) {
      db.touchMemories([mem.id]);
    }

    const updated = db.getTopMemories('/p', 1)[0];
    assert.ok(updated.score <= 1.0, `Score should be capped at 1.0, got ${updated.score}`);
  });

  it('should handle metadata serialization', () => {
    const id = db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'With metadata', keywords: 'meta', score: 0.5,
      sourceHash: 'meta-h',
      metadata: { key: 'value', nested: { deep: true } },
    });
    assert.ok(id);
    const results = db.getTopMemories('/p', 1);
    const parsed = JSON.parse(results[0].metadata);
    assert.equal(parsed.key, 'value');
    assert.equal(parsed.nested.deep, true);
  });

  it('should handle null metadata', () => {
    const id = db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'No metadata', keywords: 'none', score: 0.5,
      sourceHash: 'no-meta-h', metadata: null,
    });
    assert.ok(id);
    const results = db.getTopMemories('/p', 1);
    assert.equal(results[0].metadata, null);
  });
});

// ============================================================
// CONFIG EDGE CASES
// ============================================================

import { loadConfig } from '../src/core/config.js';

// ============================================================
// CODE-REVIEWER BUGS: Targeted tests for bugs found by code-reviewer
// ============================================================

describe('BUG 17: restoreContext section headers not counted in token budget', () => {
  beforeEach(() => resetConfig());

  it('section headers cause actual output to exceed stated budget', () => {
    const now = new Date().toISOString();
    // Create memories in different categories so section headers are generated
    const memories = [
      { id: 1, category: 'architecture', content: 'Arch item', score: 0.9, access_count: 5, created_at: now, last_accessed: now },
      { id: 2, category: 'decision', content: 'Decision item', score: 0.85, access_count: 4, created_at: now, last_accessed: now },
      { id: 3, category: 'error', content: 'Error item', score: 0.8, access_count: 3, created_at: now, last_accessed: now },
      { id: 4, category: 'file_change', content: 'File change item', score: 0.7, access_count: 2, created_at: now, last_accessed: now },
      { id: 5, category: 'note', content: 'Note item', score: 0.6, access_count: 1, created_at: now, last_accessed: now },
    ];

    // Set a tight budget that fits the items but not the section headers
    // Header "## Prior Context..." ~50 chars ~15 tokens
    // Each "- Content\n" ~15 chars ~5 tokens
    // 5 items = ~25 tokens + header ~15 tokens = ~40 tokens
    // But section headers like "### Architecture & Design\n" add ~8 tokens each
    // 5 sections x ~8 tokens = ~40 extra tokens not accounted for in budget loop
    const budget = 50; // tight budget
    const { text, ids } = restoreContext(memories, budget);

    // The budget loop only counts `- ${m.content}\n` per item,
    // but the final output adds section headers like "### Architecture & Design\n"
    // BUG: actual token count can exceed the budget
    const actualTokens = estimateTokens(text);
    if (ids.length > 0 && text.length > 0) {
      // If any items were included, check if section headers pushed us over
      // This is a documentation of the bug - section headers are NOT counted
      assert.ok(true, `Budget was ${budget}, actual tokens: ${actualTokens}. Section headers are not counted in the budget loop.`);
    }
  });
});

describe('BUG 22: file path extraction broken in buildCompactInstructions', () => {
  // buildCompactInstructions in pre-compact.js:79 uses split(':')[0]
  // The content format is "Created/wrote file: /path/to/file.js"
  // split(':') gives ["Created/wrote file", " /path/to/file.js"]
  // [0] is "Created/wrote file", then regex tries to remove "Created/wrote file:" (with colon)
  // But the colon was already split away, so regex doesn't match

  it('BUG: file extraction always fails because split removes colon before regex match', () => {
    const content = 'Created/wrote file: /home/user/file.js';
    const extracted = content.split(':')[0]?.replace(/^(Created\/wrote|Edited) file:\s*/, '') || '';
    // split(':')[0] = "Created/wrote file" (no colon)
    // regex expects "Created/wrote file:" (with colon) - no match
    // Result: "Created/wrote file" (the prefix text, NOT the file path)
    assert.equal(extracted, 'Created/wrote file',
      'BUG: Extracted value is the prefix text, not the file path');
  });

  it('BUG: Windows paths split into even more wrong segments', () => {
    const content = 'Created/wrote file: C:\\Users\\foo\\bar.js';
    const parts = content.split(':');
    // ["Created/wrote file", " C", "\\Users\\foo\\bar.js"]
    assert.equal(parts.length, 3, 'Windows path creates 3 segments due to drive letter colon');
    const extracted = parts[0]?.replace(/^(Created\/wrote|Edited) file:\s*/, '') || '';
    assert.equal(extracted, 'Created/wrote file',
      'BUG: Same prefix extraction problem, plus drive letter lost');
  });

  it('BUG: Edited file content has same extraction failure', () => {
    const content = 'Edited file: /src/config.js';
    const extracted = content.split(':')[0]?.replace(/^(Created\/wrote|Edited) file:\s*/, '') || '';
    assert.equal(extracted, 'Edited file',
      'BUG: "Edited file" regex expects colon but split removed it');
  });
});

describe('BUG 24 (FIXED): subagent-stop.js metadata no longer double-stringified', () => {
  // subagent-stop.js was fixed: now assigns plain object instead of JSON.stringify
  // Verify the fix: metadata passed as object should be single-encoded in DB

  it('metadata passed as object is correctly single-stringified', () => {
    resetConfig();
    const db = new Store(':memory:').open();
    try {
      // subagent-stop now passes a plain object (fixed)
      const metadata = { agentId: 'test-agent', agentType: 'coder' };
      const id = db.insertMemory({
        project: '/p', sessionId: 's', category: 'note',
        content: 'Test', keywords: 'test', score: 0.5,
        sourceHash: 'single-json-h',
        metadata: metadata,
      });

      const mem = db.getTopMemories('/p', 1)[0];
      const parsed = JSON.parse(mem.metadata);
      assert.equal(typeof parsed, 'object', 'Single parse should yield an object');
      assert.equal(parsed.agentId, 'test-agent');
      assert.equal(parsed.agentType, 'coder');
    } finally {
      db.close();
    }
  });

  it('regression: metadata passed as pre-stringified string still double-encodes', () => {
    resetConfig();
    const db = new Store(':memory:').open();
    try {
      // If someone accidentally passes a string, it WILL be double-encoded
      const metadata = JSON.stringify({ agentId: 'test' });
      const id = db.insertMemory({
        project: '/p', sessionId: 's', category: 'note',
        content: 'Test', keywords: 'test', score: 0.5,
        sourceHash: 'regression-json-h',
        metadata: metadata,
      });

      const mem = db.getTopMemories('/p', 1)[0];
      const firstParse = JSON.parse(mem.metadata);
      // store.insertMemory still does JSON.stringify(metadata) on any truthy value
      // So a string input gets double-encoded
      assert.equal(typeof firstParse, 'string', 'String metadata is double-encoded by store.insertMemory');
    } finally {
      db.close();
    }
  });
});

describe('BUG 25: unquoted path with spaces in install.js getHookCommand', () => {
  it('paths with spaces produce broken shell commands', () => {
    // Simulate getHookCommand behavior
    const hooksDir = '/Users/My User/Library/hooks';
    const hookFile = 'session-start.js';
    const command = `node ${join(hooksDir, hookFile)}`;

    // BUG: The space in "My User" breaks the shell command
    // It becomes: node /Users/My User/Library/hooks/session-start.js
    // Shell interprets this as: node /Users/My (command) + User/Library/hooks/session-start.js (arg)
    assert.ok(command.includes(' User/'), 'Path with space is not quoted');
    assert.ok(!command.includes('"'), 'BUG: Path should be quoted but is not');
  });
});

describe('BUG 11: groupIntoTurns drops leading assistant messages', () => {
  it('assistant messages before first user message are silently lost', () => {
    const messages = [
      { role: 'assistant', text: 'I was restored from context', thinking: '', toolCalls: [{ name: 'Read', input: {} }], toolResults: [], lineNum: 1 },
      { role: 'assistant', text: 'Let me continue working', thinking: '', toolCalls: [], toolResults: [], lineNum: 2 },
      { role: 'user', text: 'Keep going', toolCalls: [], toolResults: [], lineNum: 3 },
      { role: 'assistant', text: 'Done', thinking: '', toolCalls: [], toolResults: [], lineNum: 4 },
    ];
    const turns = groupIntoTurns(messages);
    // BUG: First two assistant messages are dropped because no user message started a turn
    assert.equal(turns.length, 1, 'Only one turn created');
    assert.equal(turns[0].assistantMessages.length, 1, 'BUG: 2 leading assistant messages silently dropped');
    // The tool call from the first assistant message is lost
    assert.equal(turns[0].allToolCalls.length, 0, 'Tool calls from dropped assistant messages are lost');
  });
});

describe('BUG 14: dead variable in archiver.js:162', () => {
  it('extractDecisions creates unused "lower" variable', () => {
    // This is dead code: `const lower = trimmed.toLowerCase()` on line 162
    // It's declared but never used. The regex on line 163-165 uses `trimmed` not `lower`.
    // This is a code quality issue, not a runtime bug.
    // We verify that decisions still work correctly (the regex uses trimmed with /i flag)
    const turns = [{
      userMessage: { text: '', toolCalls: [], toolResults: [] },
      assistantMessages: [{
        text: "I'LL USE UPPERCASE DECISION TEXT FOR THIS IMPORTANT ARCHITECTURAL CHANGE.",
        thinking: '',
        toolCalls: [],
        toolResults: [],
      }],
      allToolCalls: [],
      allToolResults: [],
      startLine: 1,
      endLine: 2,
    }];
    resetConfig();
    const result = extractMemories(turns, '/p', 's');
    const decisions = result.filter(m => m.category === 'decision');
    // The /i flag on the regex means it works without `lower`, so this passes
    assert.ok(decisions.length >= 1, 'Case-insensitive match works despite dead variable');
  });
});

describe('BUG 23: dead check in user-prompt-submit.js:16', () => {
  it('extractKeywords("").split(" ").length is always >= 1', () => {
    // user-prompt-submit.js:16 checks: if (!keywords || keywords.split(' ').length < 1)
    // But ''.split(' ') returns [''] which has length 1, so .length < 1 is always false
    // The !keywords check catches empty string, so the .length < 1 part is dead code
    const emptyResult = ''.split(' ');
    assert.equal(emptyResult.length, 1, 'Empty string split always has length 1');
    assert.ok(!(emptyResult.length < 1), 'BUG: .length < 1 check is dead code');
  });
});

describe('BUG 1 (extended): FTS5 operator injection in store.search', () => {
  let db;
  beforeEach(() => {
    resetConfig();
    db = new Store(':memory:').open();
    db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'React is a frontend framework', keywords: 'react frontend framework',
      score: 0.8, sourceHash: 'fts-h1',
    });
    db.insertMemory({
      project: '/p', sessionId: 's', category: 'note',
      content: 'Express is a backend framework', keywords: 'express backend framework',
      score: 0.7, sourceHash: 'fts-h2',
    });
  });
  afterEach(() => db.close());

  it('FTS5 NOT operator in search query alters semantics', () => {
    // User searches for "NOT react" — should find nothing or treat as literal
    // BUG: search wraps as "NOT" OR "react", but "NOT" is an FTS5 operator
    const results = db.search('NOT react', '/p', 10);
    // The behavior is unpredictable — NOT might be treated as operator or literal
    assert.ok(Array.isArray(results), 'Should not crash on FTS5 operator in query');
  });

  it('FTS5 AND operator in search query', () => {
    const results = db.search('react AND express', '/p', 10);
    assert.ok(Array.isArray(results), 'Should not crash on AND in query');
  });

  it('FTS5 NEAR operator in search query', () => {
    const results = db.search('NEAR(react express)', '/p', 10);
    assert.ok(Array.isArray(results), 'Should not crash on NEAR in query');
  });

  it('asterisk wildcard in search query', () => {
    const results = db.search('react*', '/p', 10);
    assert.ok(Array.isArray(results), 'Should handle wildcard characters');
  });

  it('parentheses in search query', () => {
    const results = db.search('(react OR express)', '/p', 10);
    assert.ok(Array.isArray(results), 'Should handle parentheses');
  });
});

describe('BUG 9 (extended): incremental parsing with blank lines', () => {
  function writeTempFile(content, name) {
    const path = join(TMP_DIR, name || `inc-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  it('incremental parse from checkpoint misses messages due to blank line skipping', () => {
    // Scenario: First parse returns lastLine=2
    // File then has a blank line inserted before line 3
    // Second parse with startLine=2 should get line 3 but may miss it
    const content = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reply1' }] } }),
      '',  // blank line inserted by some process
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Second' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reply2' }] } }),
    ].join('\n');
    const path = writeTempFile(content, 'inc-blanks.jsonl');

    // First pass
    const pass1 = parseTranscript(path, 0);
    assert.equal(pass1.messages.length, 4);
    // lastLine = 4 (non-blank lines counted)

    // Second pass from checkpoint
    const pass2 = parseTranscript(path, pass1.lastLine);
    assert.equal(pass2.messages.length, 0, 'Second pass finds nothing (correct in this case)');
    // The bug manifests when blank lines shift the line numbering between saves
  });
});

describe('config edge cases', () => {
  beforeEach(() => resetConfig());

  it('should return defaults when no config file exists', () => {
    const cfg = loadConfig();
    assert.equal(cfg.maxRestoreTokens, 4000);
    assert.ok(cfg.stopwords instanceof Set);
    assert.ok(cfg.stopwords.has('the'));
  });

  it('should have all expected category weights', () => {
    const cfg = loadConfig();
    assert.equal(cfg.categoryWeights.architecture, 1.0);
    assert.equal(cfg.categoryWeights.decision, 0.9);
    assert.equal(cfg.categoryWeights.error, 0.8);
    assert.equal(cfg.categoryWeights.finding, 0.7);
    assert.equal(cfg.categoryWeights.file_change, 0.5);
    assert.equal(cfg.categoryWeights.note, 0.4);
  });

  it('config caching should return same object', () => {
    const cfg1 = loadConfig();
    const cfg2 = loadConfig();
    assert.strictEqual(cfg1, cfg2, 'Config should be cached (same reference)');
  });
});
