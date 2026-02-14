import { Store } from '../db/store.js';

export function readStdin(timeoutMs = 500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    let data = '';
    let resolved = false;
    const done = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      try { done(data ? JSON.parse(data) : null); }
      catch { done(null); }
    }, timeoutMs);

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { done(data ? JSON.parse(data) : null); }
      catch { done(null); }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    process.stdin.resume();
  });
}

export function openDb() {
  try {
    return new Store().open();
  } catch (err) {
    log(`DB open failed: ${err.message}`);
    return null;
  }
}

export function writeHookOutput(eventName, additionalContext) {
  if (!additionalContext) return;
  const output = {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

export function writePlainOutput(text) {
  if (text) process.stdout.write(text);
}

export function log(msg) {
  process.stderr.write(`[infinite-context] ${msg}\n`);
}

export async function runHook(name, fn) {
  try {
    await fn();
  } catch (err) {
    log(`${name} error (non-critical): ${err.message}`);
  }
  process.exitCode = 0;
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(0));
    setTimeout(() => process.exit(0), 200);
  }
}
