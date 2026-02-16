import { createHash } from 'crypto';
import { scoreMemory, extractKeywords } from './scorer.js';

export function extractMemories(turns, project, sessionId) {
  const memories = [];

  for (const turn of turns) {
    for (const tc of turn.allToolCalls) {
      if (tc.name === 'Write' || tc.name === 'Edit' || tc.name === 'MultiEdit') {
        const filePath = tc.input.file_path || tc.input.path || '';
        if (!filePath) continue;

        const desc = tc.name === 'Write'
          ? `Created/wrote file: ${filePath}`
          : `Edited file: ${filePath}`;

        const detail = tc.name === 'Edit' && tc.input.old_string
          ? `\n  Changed: "${truncate(tc.input.old_string, 80)}" → "${truncate(tc.input.new_string, 80)}"`
          : '';

        memories.push(buildMemory({
          project, sessionId, category: 'file_change',
          content: desc + detail,
          keywords: extractKeywords(filePath + ' ' + desc),
          sourceText: desc + filePath,
        }));
      }

      if (tc.name === 'Bash') {
        const cmd = tc.input.command || '';
        if (isNotableCommand(cmd)) {
          memories.push(buildMemory({
            project, sessionId, category: 'note',
            content: `Ran command: ${truncate(cmd, 200)}`,
            keywords: extractKeywords(cmd),
            sourceText: cmd,
          }));
        }
      }
    }

    for (const tr of turn.allToolResults) {
      if (tr.isError && tr.content) {
        memories.push(buildMemory({
          project, sessionId, category: 'error',
          content: `Error encountered: ${truncate(tr.content, 300)}`,
          keywords: extractKeywords(tr.content),
          sourceText: tr.content,
        }));
      }
    }

    for (const msg of turn.assistantMessages) {
      if (msg.text) {
        const decisions = extractDecisions(msg.text);
        for (const d of decisions) {
          memories.push(buildMemory({
            project, sessionId, category: 'decision',
            content: d,
            keywords: extractKeywords(d),
            sourceText: d,
          }));
        }
      }

      if (msg.thinking) {
        const archItems = extractArchitecture(msg.thinking);
        for (const a of archItems) {
          memories.push(buildMemory({
            project, sessionId, category: 'architecture',
            content: a,
            keywords: extractKeywords(a),
            sourceText: a,
          }));
        }
      }
    }

    if (turn.userMessage?.text) {
      const userText = turn.userMessage.text;
      if (userText.length > 20 && userText.length <= 500 && isUserMessageWorthSaving(userText)) {
        memories.push(buildMemory({
          project, sessionId, category: 'note',
          content: `User request: ${truncate(userText, 200)}`,
          keywords: extractKeywords(userText),
          sourceText: userText,
          scoreOverride: 0.35,
        }));
      }
    }
  }

  return memories;
}

function buildMemory({ project, sessionId, category, content, keywords, sourceText, scoreOverride }) {
  return {
    project,
    sessionId,
    category,
    content,
    keywords,
    score: scoreOverride ?? scoreMemory(category, content),
    sourceHash: hashText(sourceText || content),
    metadata: null,
  };
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function truncate(s, max) {
  if (!s) return '';
  s = s.replace(/\n/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function isNotableCommand(cmd) {
  if (!cmd || cmd.length < 5) return false;
  const patterns = [
    /npm\s+(install|uninstall|init|run|test)/,
    /pip\s+(install|uninstall)/,
    /git\s+(init|clone|checkout|merge|rebase|tag)/,
    /docker\s+(build|run|compose|push|pull)/,
    /cargo\s+(build|run|test|add)/,
    /make\b/,
    /createdb|dropdb|psql|mysql|mongo/,
    /curl\s+.*(-X|--request)\s+(POST|PUT|DELETE|PATCH)/,
    /mkdir\s+-p/,
    /chmod|chown/,
    /systemctl|service/,
    /ssh\s+/,
  ];
  return patterns.some(p => p.test(cmd));
}

const DECISION_NOISE = [
  /^now\s+(let|i)/i,
  /^(good|great|perfect|alright|ok|excellent|nice|sure)\b/i,
  /^(here|this|that|these|those)\s+(is|are|shows|looks|seems)/i,
  /^no\s+action\s+needed/i,
  /^all\s+\d+\s+tests?\s+pass/i,
  /task\s+(as\s+)?(completed|done|finished)/i,
  /let\s+me\s+(mark|share|send|notify|report|acknowledge|respond|quick)/i,
  /^i('ll|'m\s+going\s+to)\s+(start|begin|continue|proceed|move\s+on|now)\b/i,
  /^i\s+have\s+(a\s+thorough|all|now|the)\b/i,
  /^(let me|i'll)\s+(create|write|build|implement|add|make|run|execute|generate)\s+(the|this|that|it)\b/i,
];

function extractDecisions(text) {
  const decisions = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 20 || trimmed.length > 300) continue;

    const isDecision =
      /\b(i'll|i will|let's|let me|we should|we'll|the approach|instead of|rather than|decided to|choosing|going with|opted for)\b/i.test(trimmed) &&
      !/\b(i'll read|i'll check|let me read|let me look|let me search|let me check)\b/i.test(trimmed) &&
      !DECISION_NOISE.some(p => p.test(trimmed));

    if (isDecision) {
      decisions.push(trimmed);
    }
  }

  return decisions.slice(0, 3);
}

function isUserMessageWorthSaving(text) {
  const trimmed = text.trim();
  if (/<task-notification>/i.test(trimmed)) return false;
  if (/^<[a-z]/i.test(trimmed)) return false;
  if ((trimmed.match(/<[^>]+>/g) || []).length > 3) return false;
  if (/^\s*\{/.test(trimmed) && trimmed.length > 200) return false;
  return true;
}

function extractArchitecture(thinking) {
  const items = [];
  const lines = thinking.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 30 || trimmed.length > 400) continue;

    const isArch =
      /\b(architecture|design pattern|module structure|interface design|abstraction layer|separation of concerns|dependency injection|coupling|cohesion|trade.?off|strategy pattern|refactor(ing)?|migration plan|schema design|database design|api design|data model|state management|caching strategy|message queue|middleware|microservice|monolith|event.?driven|pub.?sub|clean architecture|domain.?driven|bounded context|service layer|repository pattern)\b/i.test(trimmed);

    if (isArch) {
      items.push(trimmed);
    }
  }

  return items.slice(0, 3);
}
