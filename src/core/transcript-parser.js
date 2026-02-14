import { existsSync, readFileSync } from 'fs';

export function parseTranscript(transcriptPath, startLine = 0) {
  if (!transcriptPath || !existsSync(transcriptPath)) return { messages: [], lastLine: startLine };

  const content = readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n');
  const messages = [];
  let lineNum = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    lineNum++;
    if (lineNum <= startLine) continue;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const msg = parsed.message || parsed;
    const role = msg.role || parsed.type;
    if (!role || role === 'system') continue;

    if (parsed.type && !['user', 'assistant', 'A'].includes(parsed.type) && !msg.role) continue;

    const entry = {
      lineNum,
      role: role === 'A' ? 'assistant' : role,
      uuid: parsed.uuid || parsed.parentUuid || null,
      sessionId: parsed.sessionId || null,
      timestamp: parsed.timestamp || null,
      text: '',
      thinking: '',
      toolCalls: [],
      toolResults: [],
    };

    if (typeof msg.content === 'string') {
      entry.text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          entry.text += (entry.text ? '\n' : '') + (block.text || '');
        } else if (block.type === 'thinking') {
          entry.thinking += (entry.thinking ? '\n' : '') + (block.thinking || '');
        } else if (block.type === 'tool_use') {
          entry.toolCalls.push({
            name: block.name || 'unknown',
            id: block.id || null,
            input: block.input || {},
          });
        } else if (block.type === 'tool_result') {
          entry.toolResults.push({
            toolUseId: block.tool_use_id || null,
            content: typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map(b => b.text || '').join('\n')
                : '',
            isError: block.is_error || false,
          });
        }
      }
    }

    messages.push(entry);
  }

  return { messages, lastLine: lineNum };
}

export function groupIntoTurns(messages) {
  const turns = [];
  let current = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (!msg.text && msg.toolResults.length > 0 && current) {
        current.allToolResults.push(...msg.toolResults);
        current.endLine = msg.lineNum;
        continue;
      }

      if (current) turns.push(current);
      current = {
        userMessage: msg,
        assistantMessages: [],
        allToolCalls: [],
        allToolResults: [],
        startLine: msg.lineNum,
        endLine: msg.lineNum,
      };
    } else if (msg.role === 'assistant' && current) {
      current.assistantMessages.push(msg);
      current.allToolCalls.push(...msg.toolCalls);
      current.allToolResults.push(...msg.toolResults);
      current.endLine = msg.lineNum;
    }
  }

  if (current) turns.push(current);
  return turns;
}
