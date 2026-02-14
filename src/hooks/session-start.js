#!/usr/bin/env node
import { readStdin, openDb, writeHookOutput, log, runHook } from './common.js';
import { restoreContext } from '../core/restorer.js';

runHook('session-start', async () => {
  const input = await readStdin();
  if (!input) return;

  const { session_id: sessionId, cwd, source } = input;
  if (!cwd) return;

  if (source && !['compact', 'clear', 'resume', 'startup'].includes(source)) return;

  const db = openDb();
  if (!db) return;

  try {
    if (sessionId) {
      db.upsertSession(sessionId, cwd);
    }

    const memories = db.getTopMemories(cwd);
    if (!memories || memories.length === 0) {
      log('session-start: no memories for this project');
      return;
    }

    const { text, ids } = restoreContext(memories);
    if (!text) return;

    db.touchMemories(ids);

    log(`session-start: restored ${ids.length} memories for ${cwd} (source=${source || 'unknown'})`);
    writeHookOutput('SessionStart', text);
  } finally {
    db.close();
  }
});
