import { createHash } from 'crypto';
import { extractKeywords } from './scorer.js';
import { loadConfig } from './config.js';

const SYSTEM_PROMPT = `You are a context extraction assistant for a coding tool called "Infinite Context". Your job is to analyze a conversation transcript from a coding session and extract ONLY the most important information that should be remembered across sessions.

Extract these categories:
- "architecture": Architectural decisions, design patterns chosen, system design reasoning
- "decision": Key technical choices WITH reasoning (not trivial "I'll do X")
- "error": Important errors encountered and their solutions/workarounds
- "finding": Discoveries about the codebase, gotchas, non-obvious behavior
- "file_change": HIGH-LEVEL summary of what files were changed and why (group related changes)
- "note": Important context that doesn't fit other categories

Rules:
- Extract ONLY genuinely important information worth remembering
- Decisions must include REASONING, not just "I'll use X"
- Skip routine actions: reading files, running status, "let me check"
- Skip system notifications, XML tags, task-notification blocks
- Skip trivial/repetitive information
- Content should be self-contained (understandable without the full conversation)
- 50-300 characters per item
- Maximum 15 items total

Respond with a JSON array ONLY, no other text:
[{"category":"...","content":"...","importance":0.0}]

importance is 0.0-1.0 where 1.0 = critical architectural decision, 0.1 = minor note.`;

export async function extractMemoriesLLM(turns, project, sessionId) {
  const cfg = loadConfig();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot use LLM extraction');
  }

  const transcript = formatTurns(turns, cfg.llmMaxTranscriptChars);
  if (!transcript || transcript.length < 50) {
    return [];
  }

  const text = await callClaude(apiKey, cfg.llmModel, transcript);
  return parseResponse(text, project, sessionId, cfg.llmModel);
}

function formatTurns(turns, maxChars) {
  const parts = [];
  let total = 0;

  for (const turn of turns) {
    if (total >= maxChars) break;

    if (turn.userMessage?.text) {
      const cleaned = turn.userMessage.text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '').trim();
      if (cleaned && cleaned.length > 5 && !/^<[a-z]/i.test(cleaned)) {
        const line = `USER: ${cleaned.slice(0, 500)}`;
        parts.push(line);
        total += line.length;
      }
    }

    for (const msg of turn.assistantMessages || []) {
      if (total >= maxChars) break;
      if (msg.thinking) {
        const line = `THINKING: ${msg.thinking.slice(0, 800)}`;
        parts.push(line);
        total += line.length;
      }
      if (msg.text) {
        const line = `ASSISTANT: ${msg.text.slice(0, 1000)}`;
        parts.push(line);
        total += line.length;
      }
    }

    for (const tc of turn.allToolCalls || []) {
      if (total >= maxChars) break;
      const input = typeof tc.input === 'object' ? JSON.stringify(tc.input).slice(0, 200) : String(tc.input).slice(0, 200);
      const line = `TOOL[${tc.name}]: ${input}`;
      parts.push(line);
      total += line.length;
    }

    for (const tr of turn.allToolResults || []) {
      if (total >= maxChars) break;
      if (tr.isError && tr.content) {
        const line = `ERROR: ${tr.content.slice(0, 300)}`;
        parts.push(line);
        total += line.length;
      }
    }
  }

  return parts.join('\n');
}

async function callClaude(apiKey, model, transcript) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: transcript }],
        system: SYSTEM_PROMPT,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Claude API ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = await resp.json();
    return data.content?.[0]?.text || '';
  } finally {
    clearTimeout(timeout);
  }
}

function parseResponse(text, project, sessionId, model) {
  let items;
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    items = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(items)) return [];

  const validCategories = new Set(['architecture', 'decision', 'error', 'finding', 'file_change', 'note']);

  return items
    .filter(item =>
      item &&
      typeof item.content === 'string' &&
      item.content.length >= 10 &&
      validCategories.has(item.category)
    )
    .slice(0, 15)
    .map(item => ({
      project,
      sessionId,
      category: item.category,
      content: item.content.slice(0, 500),
      keywords: extractKeywords(item.content),
      score: typeof item.importance === 'number'
        ? Math.min(Math.max(item.importance, 0.1), 1.0)
        : 0.5,
      sourceHash: hashText(item.content),
      metadata: { source: 'llm', model },
    }));
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
