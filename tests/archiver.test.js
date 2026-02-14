import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractMemories } from '../src/core/archiver.js';

const PROJECT = '/test/project';
const SESSION = 'test-session';

function makeTurn({ userText, assistantText, thinking, toolCalls, toolResults }) {
  return {
    userMessage: { text: userText || '', toolCalls: [], toolResults: [] },
    assistantMessages: [{
      text: assistantText || '',
      thinking: thinking || '',
      toolCalls: toolCalls || [],
      toolResults: [],
    }],
    allToolCalls: toolCalls || [],
    allToolResults: toolResults || [],
    startLine: 1,
    endLine: 10,
  };
}

describe('extractMemories', () => {
  it('should extract file changes from Write tool calls', () => {
    const turns = [makeTurn({
      toolCalls: [{
        name: 'Write',
        input: { file_path: '/test/project/src/index.js' },
      }],
    })];

    const memories = extractMemories(turns, PROJECT, SESSION);
    const fileChanges = memories.filter(m => m.category === 'file_change');
    assert.ok(fileChanges.length >= 1);
    assert.ok(fileChanges[0].content.includes('src/index.js'));
  });

  it('should extract file changes from Edit tool calls', () => {
    const turns = [makeTurn({
      toolCalls: [{
        name: 'Edit',
        input: {
          file_path: '/test/project/src/config.js',
          old_string: 'const port = 3000',
          new_string: 'const port = process.env.PORT || 3000',
        },
      }],
    })];

    const memories = extractMemories(turns, PROJECT, SESSION);
    const fileChanges = memories.filter(m => m.category === 'file_change');
    assert.ok(fileChanges.length >= 1);
    assert.ok(fileChanges[0].content.includes('config.js'));
    assert.ok(fileChanges[0].content.includes('port'));
  });

  it('should extract notable Bash commands', () => {
    const turns = [makeTurn({
      toolCalls: [{
        name: 'Bash',
        input: { command: 'npm install express cors helmet' },
      }],
    })];

    const memories = extractMemories(turns, PROJECT, SESSION);
    const notes = memories.filter(m => m.category === 'note' && m.content.includes('npm'));
    assert.ok(notes.length >= 1);
  });

  it('should ignore trivial Bash commands', () => {
    const turns = [makeTurn({
      toolCalls: [{
        name: 'Bash',
        input: { command: 'ls -la' },
      }],
    })];

    const memories = extractMemories(turns, PROJECT, SESSION);
    const bashNotes = memories.filter(m => m.content.includes('ls'));
    assert.equal(bashNotes.length, 0);
  });

  it('should extract errors from tool results', () => {
    const turns = [makeTurn({
      toolResults: [{
        isError: true,
        content: 'Error: Cannot find module express',
      }],
    })];

    const memories = extractMemories(turns, PROJECT, SESSION);
    const errors = memories.filter(m => m.category === 'error');
    assert.ok(errors.length >= 1);
    assert.ok(errors[0].content.includes('Cannot find module'));
  });

  it('should extract decisions from assistant text', () => {
    const turns = [makeTurn({
      assistantText: "I'll use SQLite instead of PostgreSQL for simplicity and zero-config deployment.",
    })];

    const memories = extractMemories(turns, PROJECT, SESSION);
    const decisions = memories.filter(m => m.category === 'decision');
    assert.ok(decisions.length >= 1);
    assert.ok(decisions[0].content.includes('SQLite'));
  });

  it('should not extract trivial assistant phrases as decisions', () => {
    const turns = [makeTurn({
      assistantText: "Let me read the file first.",
    })];

    const memories = extractMemories(turns, PROJECT, SESSION);
    const decisions = memories.filter(m => m.category === 'decision');
    assert.equal(decisions.length, 0);
  });

  it('should extract architecture from thinking blocks', () => {
    const turns = [makeTurn({
      thinking: "The architecture should use a clean separation of concerns with the database layer abstracted behind a store interface.",
    })];

    const memories = extractMemories(turns, PROJECT, SESSION);
    const arch = memories.filter(m => m.category === 'architecture');
    assert.ok(arch.length >= 1);
  });

  it('should extract user requests as notes', () => {
    const turns = [makeTurn({
      userText: 'Create an API endpoint for user authentication with JWT tokens',
    })];

    const memories = extractMemories(turns, PROJECT, SESSION);
    const notes = memories.filter(m => m.content.includes('User request'));
    assert.ok(notes.length >= 1);
  });

  it('should generate unique source hashes for dedup', () => {
    const turns = [
      makeTurn({ toolCalls: [{ name: 'Write', input: { file_path: '/a/b.js' } }] }),
      makeTurn({ toolCalls: [{ name: 'Write', input: { file_path: '/a/c.js' } }] }),
    ];

    const memories = extractMemories(turns, PROJECT, SESSION);
    const hashes = memories.filter(m => m.sourceHash).map(m => m.sourceHash);
    const unique = new Set(hashes);
    assert.equal(hashes.length, unique.size, 'All hashes should be unique');
  });
});
