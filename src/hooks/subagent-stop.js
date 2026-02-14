#!/usr/bin/env node
import { readStdin, openDb, log, runHook } from './common.js';
import { parseTranscript, groupIntoTurns } from '../core/transcript-parser.js';
import { extractMemories } from '../core/archiver.js';

runHook('subagent-stop', async () => {
  const input = await readStdin();
  if (!input) return;

  const {
    session_id: sessionId,
    cwd,
    agent_id: agentId,
    agent_type: agentType,
    agent_transcript_path: agentTranscriptPath,
  } = input;

  if (!agentTranscriptPath || !sessionId) return;

  const db = openDb();
  if (!db) return;

  try {
    const project = cwd || 'unknown';
    const agentSessionId = agentId ? `${sessionId}:${agentId}` : sessionId;

    const checkpoint = db.getCheckpoint(agentSessionId, agentTranscriptPath);
    let startLine = checkpoint ? checkpoint.last_line_number : 0;

    let { messages, lastLine } = parseTranscript(agentTranscriptPath, startLine);
    if (messages.length === 0 && lastLine < startLine) {
      log(`subagent-stop: transcript rollback detected (checkpoint=${startLine} > transcript=${lastLine}), re-parsing`);
      startLine = 0;
      ({ messages, lastLine } = parseTranscript(agentTranscriptPath, 0));
    }
    if (messages.length === 0) {
      log(`subagent-stop: no messages in ${agentType || 'unknown'} agent transcript`);
      return;
    }

    const turns = groupIntoTurns(messages);
    const memories = extractMemories(turns, project, agentSessionId);

    if (memories.length === 0) {
      log(`subagent-stop: no memories from ${agentType || 'unknown'} agent`);
      db.saveCheckpoint(agentSessionId, agentTranscriptPath, lastLine);
      return;
    }

    for (const mem of memories) {
      mem.metadata = {
        agentId: agentId || null,
        agentType: agentType || null,
        ...(mem.metadata && typeof mem.metadata === 'object' ? mem.metadata : {}),
      };
    }

    const inserted = db.insertMany(memories);
    db.saveCheckpoint(agentSessionId, agentTranscriptPath, lastLine);
    db.incrSessionMemories(sessionId, inserted);

    log(`subagent-stop: archived ${inserted} memories from ${agentType || 'unknown'} agent (${agentId || 'no-id'}), ${memories.length - inserted} deduped`);
  } finally {
    db.close();
  }
});
