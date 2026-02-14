#!/usr/bin/env node
import { readStdin, openDb, writePlainOutput, log, runHook } from './common.js';
import { parseTranscript, groupIntoTurns } from '../core/transcript-parser.js';
import { extractMemories } from '../core/archiver.js';

runHook('pre-compact', async () => {
  const input = await readStdin();
  if (!input) return;

  const { session_id: sessionId, transcript_path: transcriptPath, cwd, trigger } = input;
  if (!transcriptPath || !sessionId) return;

  const db = openDb();
  if (!db) return;

  try {
    const project = cwd || 'unknown';
    db.upsertSession(sessionId, project);

    const checkpoint = db.getCheckpoint(sessionId, transcriptPath);
    let startLine = checkpoint ? checkpoint.last_line_number : 0;

    let { messages, lastLine } = parseTranscript(transcriptPath, startLine);

    if (messages.length === 0 && lastLine < startLine) {
      log(`pre-compact: transcript rollback detected (checkpoint=${startLine} > transcript=${lastLine}), re-parsing`);
      startLine = 0;
      ({ messages, lastLine } = parseTranscript(transcriptPath, 0));
    }

    if (messages.length === 0) {
      log(`pre-compact: no new messages since line ${startLine}`);
      return;
    }

    const turns = groupIntoTurns(messages);
    const memories = extractMemories(turns, project, sessionId);

    if (memories.length === 0) {
      log('pre-compact: no memories extracted');
      db.saveCheckpoint(sessionId, transcriptPath, lastLine);
      return;
    }

    const inserted = db.insertMany(memories);
    db.saveCheckpoint(sessionId, transcriptPath, lastLine);
    db.incrSessionMemories(sessionId, inserted);
    db.incrSessionCompactions(sessionId);
    db.enforceProjectLimit(project);

    log(`pre-compact: archived ${inserted} memories (${memories.length - inserted} deduped), trigger=${trigger || 'auto'}`);

    const instructions = buildCompactInstructions(memories, inserted, project);
    writePlainOutput(instructions);
  } finally {
    db.close();
  }
});

function buildCompactInstructions(memories, insertedCount, project) {
  const parts = ['CONTEXT ARCHIVE (from infinite-context):'];
  parts.push(`${insertedCount} items archived for project: ${project}`);
  parts.push('After compaction, archived context will be automatically restored.');
  parts.push('');

  const byCategory = {};
  for (const m of memories) {
    if (!byCategory[m.category]) byCategory[m.category] = [];
    byCategory[m.category].push(m);
  }

  if (byCategory.decision?.length) {
    parts.push('KEY DECISIONS to preserve:');
    for (const d of byCategory.decision.slice(0, 5)) {
      parts.push(`  - ${d.content.slice(0, 120)}`);
    }
  }

  if (byCategory.file_change?.length) {
    const files = byCategory.file_change.map(m => m.content.match(/(?:Created\/wrote|Edited) file:\s*(.+)/)?.[1]?.split('\n')[0] || '').filter(Boolean);
    if (files.length) {
      parts.push(`FILES modified: ${[...new Set(files)].slice(0, 10).join(', ')}`);
    }
  }

  if (byCategory.error?.length) {
    parts.push('ERRORS encountered:');
    for (const e of byCategory.error.slice(0, 3)) {
      parts.push(`  - ${e.content.slice(0, 120)}`);
    }
  }

  return parts.join('\n').slice(0, 2000);
}
