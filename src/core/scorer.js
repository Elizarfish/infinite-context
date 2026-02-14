import { loadConfig } from './config.js';

export function scoreMemory(category, content) {
  const cfg = loadConfig();
  const baseScore = cfg.categoryWeights[category] || 0.4;

  const lengthBonus = Math.min(content.length / 500, 0.1);

  return Math.min(baseScore + lengthBonus, 1.0);
}

export function computeImportance(memory, now = Date.now()) {
  const createdAt = new Date(memory.created_at).getTime();
  const lastAccessed = new Date(memory.last_accessed).getTime();

  if (isNaN(createdAt) || isNaN(lastAccessed)) return memory.score ?? 0.5;

  const freshnessDays = Math.max(0.01, (now - lastAccessed) / 86400000);

  const recency = Math.exp(-0.693 * freshnessDays / 7);

  const frequency = Math.log2((memory.access_count || 0) + 1) + 1;

  const base = memory.score ?? 0.5;

  return base * recency * frequency;
}

export function extractKeywords(text) {
  if (!text || typeof text !== 'string') return '';
  const cfg = loadConfig();

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s_\-./]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !cfg.stopwords.has(w));

  return [...new Set(words)].slice(0, 30).join(' ');
}

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}
