import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { atomicWriteJson, moveAsideCorrupt, readJsonIfExists, removeTemporaryFiles } from './util.mjs';
import { normalizePage, pageFilename } from './contract.mjs';
import { descriptorKey } from './census.mjs';

export const STATE_VERSION = 1;

function emptyState() {
  return {
    version: STATE_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    nextAttempt: 1,
    prior: [],
    attempts: [],
    notifications: {},
  };
}

export async function loadState(stateDir) {
  const file = path.join(stateDir, 'state.json');
  const loaded = await readJsonIfExists(file);
  let state = null;
  let recovered = false;
  if (loaded.value && typeof loaded.value === 'object' && Array.isArray(loaded.value.attempts)) {
    state = loaded.value;
  } else if (!loaded.missing) {
    await moveAsideCorrupt(file);
    recovered = true;
  }
  if (!state) state = emptyState();
  if (!Array.isArray(state.attempts)) state.attempts = [];
  if (!Array.isArray(state.prior)) state.prior = [];
  if (!state.notifications || typeof state.notifications !== 'object' || Array.isArray(state.notifications)) {
    state.notifications = {};
  }
  if (!Number.isInteger(state.nextAttempt) || state.nextAttempt < 1) {
    state.nextAttempt = Math.max(0, ...state.attempts.map(item => Number(item.attempt) || 0)) + 1;
  }
  const recovery = await recoverFromRawPages(stateDir, state);
  if (recovery.changed) recovered = true;
  await removeTemporaryFiles(file);
  return { state, recovered };
}

/**
 * Raw page copies are the primary evidence. If state.json was lost, or a
 * crash happened after a copy was written but before state.json was updated,
 * rebuild the page metadata from those copies instead of silently forgetting
 * verified work. Only complete copies whose filename matches the descriptor
 * they contain are trusted.
 */
async function recoverFromRawPages(stateDir, state) {
  const root = path.join(stateDir, 'pages');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return { changed: false }; }
  const known = new Set();
  for (const attempt of state.attempts) {
    for (const page of attempt.pages ?? []) {
      known.add(`${attempt.attempt}|${page.targetKey ?? descriptorKey(page.target)}`);
    }
  }
  let changed = false;  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('attempt-')) continue;
    const attemptNumber = Number(entry.name.slice('attempt-'.length));
    if (!Number.isInteger(attemptNumber) || attemptNumber < 1) continue;
    let files;
    try { files = await readdir(path.join(root, entry.name)); } catch { continue; }
    let attempt = state.attempts.find(item => Number(item.attempt) === attemptNumber);
    for (const file of files) {
      if (!file.endsWith('.json') || file.includes('.tmp-')) continue;
      let raw;
      try { raw = JSON.parse(await readFile(path.join(root, entry.name, file), 'utf8')); }
      catch { continue; }
      if (raw.target === undefined || raw.target === null) continue;
      // A copy whose filename does not match its descriptor is not traceable
      // evidence and must not be promoted to a verified page.
      if (pageFilename(raw.target) + '.json' !== file) continue;
      if (raw.attempt !== undefined && Number(raw.attempt) !== attemptNumber) continue;
      const key = `${attemptNumber}|${descriptorKey(raw.target)}`;
      if (known.has(key)) continue;
      if (!attempt) {
        attempt = {
          attempt: attemptNumber,
          startedAt: raw.fetchedAt ?? null,
          finishedAt: null,
          status: 'recovered',
          recovered: true,
          index: { status: 'recovered', round: null, targets: null, error: null },
          pages: [],
          summary: null,
        };
        state.attempts.push(attempt);
      }
      const parsed = recoverPage(raw, entry.name, file, attemptNumber);
      if (!parsed) continue;
      attempt.pages.push(parsed);
      known.add(key);
      changed = true;
    }
  }
  state.attempts.sort((a, b) => (Number(a.attempt) || 0) - (Number(b.attempt) || 0));
  return { changed };
}

function recoverPage(raw, directory, file, attemptNumber) {
  const base = {
    targetKey: descriptorKey(raw.target),
    target: raw.target,
    url: raw.url ?? null,
    status: 'invalid',
    httpStatus: raw.httpStatus ?? null,
    round: null,
    range: null,
    ranges: [],
    complete: false,
    hasMembers: false,
    offline: false,
    members: [],
    memberCount: 0,
    fetchedAt: raw.fetchedAt ?? null,
    rawFile: path.posix.join('pages', directory, file),
    inline: false,
    evidenceAttempt: attemptNumber,
    origin: 'recovered',
    error: null,
  };
  if (raw.fetchError) {
    return { ...base, status: 'offline', offline: true, error: String(raw.fetchError) };
  }
  if (raw.httpStatus !== undefined && raw.httpStatus !== null && (raw.httpStatus < 200 || raw.httpStatus >= 300)) {
    return { ...base, status: 'offline', offline: true, error: '来源返回 ' + raw.httpStatus };
  }
  if (!raw.body || typeof raw.body !== 'object' || Array.isArray(raw.body)) {
    return { ...base, error: '恢复时没有可解析的页面内容' };
  }
  try {
    const normalized = normalizePage(raw.body);
    return {
      ...base,
      status: normalized.offline ? 'offline' : 'ok',
      // The page's own round only. If it never stated one, the copy still
      // cannot support an absence conclusion for any round.
      round: normalized.round,
      range: normalized.range,
      ranges: normalized.ranges,
      complete: normalized.complete && !normalized.offline,
      hasMembers: normalized.hasMembers,
      offline: normalized.offline,
      members: normalized.members,
      memberCount: normalized.members.length,
      error: normalized.offline ? '页面声明自身离线' : null,
    };
  } catch (error) {
    return { ...base, error: '恢复时无法解析页面：' + error.message };
  }
}

export async function saveState(stateDir, state) {
  state.updatedAt = new Date().toISOString();
  await atomicWriteJson(path.join(stateDir, 'state.json'), state);
}

export function nextAttemptNumber(state) {
  const fromAttempts = Math.max(0, ...state.attempts.map(item => Number(item.attempt) || 0));
  const number = Math.max(state.nextAttempt ?? 1, fromAttempts + 1);
  state.nextAttempt = number + 1;
  return number;
}
