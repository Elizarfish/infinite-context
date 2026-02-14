#!/usr/bin/env node
import { readStdin, openDb, log, runHook } from './common.js';
import { parseTranscript, groupIntoTurns } from '../core/transcript-parser.js';
import { extractMemories } from '../core/archiver.js';

runHook('session-end', async () => {
  const input = await readStdin();
  if (!input) return;

  const { session_id: sessionId, transcript_path: transcriptPath, cwd } = input;
  if (!sessionId) return;

  const db = openDb();
  if (!db) return;

  try {
    const project = cwd || 'unknown';

    if (transcriptPath) {
      const checkpoint = db.getCheckpoint(sessionId, transcriptPath);
      let startLine = checkpoint ? checkpoint.last_line_number : 0;

      let { messages, lastLine } = parseTranscript(transcriptPath, startLine);

      if (messages.length === 0 && lastLine < startLine) {
        log(`session-end: transcript rollback detected (checkpoint=${startLine} > transcript=${lastLine}), re-parsing`);
        startLine = 0;
        ({ messages, lastLine } = parseTranscript(transcriptPath, 0));
      }

      if (messages.length > 0) {
        const turns = groupIntoTurns(messages);
        const memories = extractMemories(turns, project, sessionId);
        if (memories.length > 0) {
          const inserted = db.insertMany(memories);
          db.saveCheckpoint(sessionId, transcriptPath, lastLine);
          db.incrSessionMemories(sessionId, inserted);
          log(`session-end: final archive ${inserted} memories`);
        }
      }
    }

    const pruned = db.decayAndPrune();
    if (pruned > 0) {
      log(`session-end: pruned ${pruned} low-score memories`);
    }

    db.enforceProjectLimit(project);

    db.endSession(sessionId);

    log('session-end: cleanup complete');
  } finally {
    db.close();
  }
});
