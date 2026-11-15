import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function asKey(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

export function validRange(range) {
  if (!Array.isArray(range) || range.length !== 2) return null;
  const start = asKey(range[0]);
  const end = asKey(range[1]);
  if (start === null || end === null || start > end) return null;
  return [start, end];
}

export function rangeContains(range, key) {
  if (!Array.isArray(range) || range.length !== 2) return false;
  const point = asKey(key);
  if (point === null) return false;
  // The contract defines key ranges as half-open: [start, end).
  return point >= range[0] && point < range[1];
}

export function roundMatches(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (typeof left === 'object' || typeof right === 'object') return false;
  return String(left) === String(right);
}

export function safeSlug(value) {
  const text = String(value);
  const readable = text.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'page';
  return readable + '-' + createHash('sha256').update(text).digest('hex').slice(0, 10);
}

export async function readJsonIfExists(file) {
  try {
    return { missing: false, value: JSON.parse(await readFile(file, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true, value: null };
    return { missing: false, value: null, error };
  }
}

export async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

export async function moveAsideCorrupt(file) {
  const moved = `${file}.corrupt-${Date.now()}`;
  try { await rename(file, moved); return moved; } catch { return null; }
}

export async function removeTemporaryFiles(file) {
  const directory = path.dirname(file);
  const prefix = path.basename(file) + '.tmp-';
  try {
    for (const entry of await readdir(directory)) {
      if (entry.startsWith(prefix)) await rm(path.join(directory, entry), { force: true });
    }
  } catch { /* best effort */ }
}

export async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run);
  await Promise.all(workers);
  return results;
}
