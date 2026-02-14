import { computeImportance, estimateTokens } from './scorer.js';
import { loadConfig } from './config.js';

export function restoreContext(memories, budget) {
  const cfg = loadConfig();
  const maxTokens = budget ?? cfg.maxRestoreTokens;

  if (!memories || memories.length === 0) return { text: '', ids: [] };

  const now = Date.now();
  const ranked = memories
    .map(m => ({ ...m, importance: computeImportance(m, now) }))
    .sort((a, b) => b.importance - a.importance);

  const groups = {
    architecture: [],
    decision: [],
    error: [],
    finding: [],
    file_change: [],
    note: [],
  };

  let totalTokens = 0;
  const restoredIds = [];
  const headerTokens = estimateTokens('## Prior Context (restored from archive)\n\n');
  totalTokens += headerTokens;
  const seenCategories = new Set();
  const sectionHeaderTokens = estimateTokens('### Category Label\n');

  for (const m of ranked) {
    const cat = groups[m.category] ? m.category : 'note';
    let extra = 0;
    if (!seenCategories.has(cat)) {
      extra = sectionHeaderTokens;
    }
    const lineTokens = estimateTokens(`- ${m.content}\n`);
    if (totalTokens + lineTokens + extra > maxTokens) break;

    if (!seenCategories.has(cat)) {
      seenCategories.add(cat);
      totalTokens += extra;
    }
    groups[cat].push(m);
    totalTokens += lineTokens;
    restoredIds.push(m.id);
  }

  const sections = [];

  const categoryLabels = {
    architecture: 'Architecture & Design',
    decision: 'Key Decisions',
    error: 'Known Issues',
    finding: 'Findings',
    file_change: 'Files Modified',
    note: 'Notes',
  };

  for (const [cat, label] of Object.entries(categoryLabels)) {
    const items = groups[cat];
    if (!items || items.length === 0) continue;
    sections.push(`### ${label}`);
    for (const m of items) {
      sections.push(`- ${m.content}`);
    }
    sections.push('');
  }

  if (sections.length === 0) return { text: '', ids: [] };

  const text = '## Prior Context (restored from archive)\n\n' + sections.join('\n');
  return { text, ids: restoredIds };
}

export function recallForPrompt(searchResults) {
  if (!searchResults || searchResults.length === 0) return { text: '', ids: [] };

  const lines = ['## Relevant prior context'];
  const ids = [];

  for (const m of searchResults) {
    lines.push(`- [${m.category}] ${m.content}`);
    ids.push(m.id);
  }

  return { text: lines.join('\n'), ids };
}
