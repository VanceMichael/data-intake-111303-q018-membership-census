import path from 'node:path';
import { normalizePage, rawPageRelative, saveRawPage } from './contract.mjs';
import { asKey, mapPool } from './util.mjs';

const DEFAULT_TIMEOUT = 3000;
const CONCURRENCY = 6;

function baseUrl(source) {
  const text = String(source);
  return text.endsWith('/') ? text : text + '/';
}

export function descriptorLabel(descriptor) {
  if (typeof descriptor === 'string') return descriptor;
  if (descriptor && typeof descriptor === 'object') {
    return descriptor.href ?? descriptor.url ?? descriptor.path ?? descriptor.page ?? JSON.stringify(descriptor);
  }
  return String(descriptor);
}

export function descriptorKey(descriptor) {
  // Use the descriptor exactly as the supplier declared it. Resolving it
  // against a base URL is only for fetching; the identity of the page in
  // evidence should stay traceable to what the supplier wrote.
  return 'page:' + descriptorLabel(descriptor);
}

function isInlinePage(descriptor) {
  return descriptor !== null && typeof descriptor === 'object'
    && !Array.isArray(descriptor)
    && (Array.isArray(descriptor.range) || Array.isArray(descriptor.members) || Array.isArray(descriptor.ranges));
}

export function pageUrl(descriptor, censusUrl) {
  if (isInlinePage(descriptor)) return null;
  try { return new URL(descriptorLabel(descriptor), censusUrl).toString(); }
  catch { return null; }
}

async function requestJson(url, timeoutMs) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    let body = null;
    let parseError = null;
    try { body = JSON.parse(text); } catch (error) { parseError = error; }
    return { ok: response.ok, status: response.status, text, body, parseError };
  } catch (error) {
    return { error };
  }
}

function safeParse(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}
function dedupeTargets(targets) {
  const seen = new Set();
  const unique = [];
  for (const target of targets) {
    const key = descriptorKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

function makePage(fields) {
  return {
    targetKey: fields.targetKey ?? null,
    target: fields.target ?? null,
    url: fields.url ?? null,
    status: fields.status ?? 'invalid',
    httpStatus: fields.httpStatus ?? null,
    round: fields.round ?? null,
    range: fields.range ?? null,
    ranges: fields.ranges ?? [],
    complete: fields.complete === true,
    hasMembers: fields.hasMembers === true,
    offline: fields.offline === true,
    members: fields.members ?? [],
    memberCount: (fields.members ?? []).length,
    fetchedAt: fields.fetchedAt ?? new Date().toISOString(),
    rawFile: fields.rawFile ?? null,
    inline: fields.inline === true,
    evidenceAttempt: fields.evidenceAttempt ?? null,
    origin: fields.origin ?? 'current',
    error: fields.error ?? null,
  };
}

function fromNormalized(descriptor, normalized, extras) {
  const offline = normalized.offline;
  return makePage({
    targetKey: descriptorKey(descriptor),
    target: descriptor,
    status: offline ? 'offline' : 'ok',
    round: normalized.round,
    range: normalized.range,
    ranges: normalized.ranges,
    complete: normalized.complete && !offline,
    hasMembers: normalized.hasMembers,
    offline,
    members: normalized.members,
    error: offline ? '页面声明自身离线' : null,
    ...extras,
  });
}

/**
 * Fetch the census index and every page it names.
 *
 * Each page copy is written raw before it is interpreted, so a later run can
 * trace exactly what the supplier said and can fall back to a still-valid
 * copy of the same round. A failed page becomes `offline`, never an empty
 * page.
 *
 * `refresh` (optional) is a callback receiving the parsed index body; it lets
 * the caller learn the round before pages are fetched. It must not change
 * what is read.
 */
export async function fetchCensus({ source, stateDir, state = { attempts: [] }, attemptNumber, timeoutMs = DEFAULT_TIMEOUT, refresh = null }) {
  if (!stateDir) throw new Error('fetchCensus 需要 stateDir 以保存原始页副本');
  const censusUrl = new URL('census', baseUrl(source)).toString();
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 15000) : DEFAULT_TIMEOUT;
  const fetchedAt = new Date().toISOString();
  const result = await requestJson(censusUrl, timeout);
  let index;

  if (result.error) {
    index = {
      status: 'offline', url: censusUrl, httpStatus: null, round: null, targets: [],
      error: '清点索引读取失败：' + (result.error.message ?? result.error), fetchedAt,
    };
  } else if (!result.ok) {
    index = {
      status: 'offline', url: censusUrl, httpStatus: result.status, round: null, targets: [],
      error: '清点索引返回 ' + result.status, fetchedAt,
    };
  } else if (result.parseError) {
    index = {
      status: 'invalid', url: censusUrl, httpStatus: result.status, round: null, targets: [],
      error: '清点索引无法解析：' + result.parseError.message, fetchedAt,
    };
  } else if (!Array.isArray(result.body?.pages)) {
    index = {
      status: 'invalid', url: censusUrl, httpStatus: result.status, round: null, targets: [],
      error: '清点索引缺少 pages', fetchedAt,
    };
  } else {
    index = {
      status: 'ok',
      url: censusUrl,
      httpStatus: result.status,
      round: result.body.round ?? null,
      targets: dedupeTargets(result.body.pages),
      error: null,
      fetchedAt,
    };
  }

  // A failed index request must not throw away known work. Reuse the most
  // recent index that was actually read, but carry its round with it: pages
  // obtained now still only count for that round.
  if (index.status !== 'ok') {
    const previous = [...(state.attempts ?? [])].reverse().find(item =>
      (item.index?.status === 'ok' || item.index?.status === 'reused')
      && item.index.round !== null && item.index.round !== undefined
      && Array.isArray(item.index.targets) && item.index.targets.length > 0);
    if (previous) {
      index = {
        ...index,
        status: 'reused',
        round: previous.index.round,
        targets: previous.index.targets,
        resumedFromAttempt: previous.attempt,
        error: (index.error ? index.error + '；' : '') + '沿用第 ' + previous.attempt + ' 次执行读到的页清单',
      };
    }
  }
  if (typeof refresh === 'function') refresh(index);

  const rawDir = path.join(stateDir, 'pages', 'attempt-' + attemptNumber);
  const rawRelative = 'pages/attempt-' + attemptNumber;
  const pages = await mapPool(dedupeTargets(index.targets), CONCURRENCY, async descriptor => {
    if (isInlinePage(descriptor)) {
      try {
        return fromNormalized(descriptor, normalizePage(descriptor), {
          inline: true, fetchedAt: new Date().toISOString(),
        });
      } catch (error) {
        return makePage({
          targetKey: descriptorKey(descriptor), target: descriptor, status: 'invalid',
          error: '清点页结构无效：' + error.message,
        });
      }
    }

    const url = pageUrl(descriptor, index.url);
    if (!url) {
      return makePage({
        targetKey: descriptorKey(descriptor), target: descriptor, status: 'invalid',
        error: '无法解析页地址',
      });
    }
    const pageResult = await requestJson(url, timeout);
    const pageFetchedAt = new Date().toISOString();
    const rawRelativeFile = rawPageRelative(rawRelative, descriptor);
    await saveRawPage(rawDir, descriptor, {
      target: descriptor,
      url,
      httpStatus: pageResult.status ?? null,
      fetchedAt: pageFetchedAt,
      indexRound: index.round,
      attempt: attemptNumber,
      fetchError: pageResult.error ? String(pageResult.error.message ?? pageResult.error) : null,
      rawText: pageResult.body === null && typeof pageResult.text === 'string' ? pageResult.text : undefined,
      body: pageResult.body,
    });
    const evidence = { rawFile: rawRelativeFile };
    if (pageResult.error) {
      return makePage({
        targetKey: descriptorKey(descriptor), target: descriptor, url,
        status: 'offline', offline: true, fetchedAt: pageFetchedAt, ...evidence,
        error: '读取失败：' + (pageResult.error.message ?? pageResult.error),
      });
    }
    if (!pageResult.ok) {
      return makePage({
        targetKey: descriptorKey(descriptor), target: descriptor, url,
        httpStatus: pageResult.status,
        status: 'offline', offline: true, fetchedAt: pageFetchedAt, ...evidence,
        error: '来源返回 ' + pageResult.status,
      });
    }
    if (pageResult.parseError) {
      return makePage({
        targetKey: descriptorKey(descriptor), target: descriptor, url,
        httpStatus: pageResult.status, status: 'invalid',
        fetchedAt: pageFetchedAt, ...evidence, error: '页面不是有效 JSON',
      });
    }
    try {
      return fromNormalized(descriptor, normalizePage(pageResult.body), {
        url, httpStatus: pageResult.status, fetchedAt: pageFetchedAt, ...evidence,
      });
    } catch (error) {
      return makePage({
        targetKey: descriptorKey(descriptor), target: descriptor, url,
        httpStatus: pageResult.status, status: 'invalid',
        fetchedAt: pageFetchedAt, ...evidence,
        error: '清点页结构无效：' + error.message,
      });
    }
  });

  return { index, pages, rawDir: rawRelative };
}

export function normalizeTimeout(value) {
  const numeric = asKey(value);
  return numeric === null ? DEFAULT_TIMEOUT : Math.min(Math.max(numeric, 100), 15000);
}
