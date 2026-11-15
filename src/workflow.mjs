import {
  changesFor, evaluateMembers, mergePrior, notificationsFor, pageLabel, publicationsFor,
  rememberObserved, selectNewNotifications,
} from './domain.mjs';
import { fetchCensus, normalizeTimeout, descriptorKey } from './census.mjs';
import { loadState, nextAttemptNumber, saveState } from './state.mjs';
import { atomicWriteJson, roundMatches } from './util.mjs';
import path from 'node:path';

function pageRanges(page) {
  return page.ranges?.length > 0 ? page.ranges : (page.range ? [page.range] : []);
}

/**
 * Assemble the evidence for this run:
 *
 * - everything readable and fetched now;
 * - for a declared page that is currently offline or unreadable, a copy from
 *   an earlier attempt OF THE SAME ROUND may stand in, because it was
 *   genuinely verified and the round it belongs to has not changed;
 * - pages from other rounds are never used to fill a missing range.
 *
 * Reused pages are labelled as such and keep their original attempt, so an
 * audit can tell when the evidence was obtained. The failed current attempt is
 * preserved too, so an operator still sees which station was unreachable.
 */
function assembleEvidence({ currentPages, previousAttempts, targetRound }) {
  const previousByKey = new Map();
  for (const attempt of previousAttempts) {
    for (const page of attempt.pages ?? []) {
      if (page.status !== 'ok') continue;
      if (!roundMatches(page.round, targetRound)) continue;
      const key = page.targetKey ?? descriptorKey(page.target);
      const existing = previousByKey.get(key);
      if (!existing || (Number(attempt.attempt) || 0) > (Number(existing.evidenceAttempt) || 0)) {
        previousByKey.set(key, { ...page, targetKey: key, origin: 'reused', evidenceAttempt: attempt.attempt });
      }
    }
  }
  return currentPages.map(page => {
    if (page.status === 'ok') return { ...page, origin: page.origin ?? 'current' };
    const key = page.targetKey ?? descriptorKey(page.target);
    const earlier = previousByKey.get(key);
    if (!earlier) return { ...page, origin: page.origin ?? 'current' };
    return {
      ...earlier,
      target: page.target,
      targetKey: key,
      currentAttempt: {
        status: page.status,
        httpStatus: page.httpStatus ?? null,
        error: page.error ?? null,
        fetchedAt: page.fetchedAt ?? null,
        rawFile: page.rawFile ?? null,
      },
    };
  });
}

/**
 * A round previously declared this page and the current index omits it. The
 * receiver must not silently shrink the round: report the page as pending and,
 * if an earlier copy of the same round exists, keep its evidence. A page that
 * is absent from this index is not evidence that the range is empty.
 */
function carryDroppedPages({ currentPages, previousAttempts, targetRound }) {
  if (targetRound === null || targetRound === undefined) return currentPages;
  const seenKeys = new Set(currentPages.map(page => page.targetKey ?? descriptorKey(page.target)));
  const latest = new Map();
  for (const attempt of previousAttempts) {
    for (const page of attempt.pages ?? []) {
      if (page.status !== 'ok' || !roundMatches(page.round, targetRound)) continue;
      const key = page.targetKey ?? descriptorKey(page.target);
      const existing = latest.get(key);
      if (!existing || (Number(attempt.attempt) || 0) > (Number(existing.evidenceAttempt) || 0)) {
        latest.set(key, { ...page, targetKey: key, origin: 'reused', evidenceAttempt: attempt.attempt });
      }
    }
  }
  const carried = [];
  for (const [key, page] of latest) {
    if (seenKeys.has(key)) continue;
    carried.push({
      ...page,
      origin: 'reused',
      droppedFromIndex: true,
      currentAttempt: {
        status: 'offline',
        httpStatus: null,
        error: '本轮清点索引不再列出该页',
        fetchedAt: null,
        rawFile: null,
      },
    });
  }
  return [...currentPages, ...carried];
}

function describePage(page, targetRound) {
  return {
    page: pageLabel(page),
    url: page.url ?? null,
    status: page.status,
    httpStatus: page.httpStatus ?? null,
    round: page.round ?? null,
    inTargetRound: Boolean(roundMatches(page.round, targetRound)),
    ranges: pageRanges(page),
    complete: Boolean(page.complete),
    offline: Boolean(page.offline),
    members: page.memberCount ?? 0,
    fetchedAt: page.fetchedAt ?? null,
    rawFile: page.rawFile ?? null,
    origin: page.origin ?? 'current',
    evidenceAttempt: page.evidenceAttempt ?? null,
    currentAttempt: page.currentAttempt ?? null,
    droppedFromIndex: page.droppedFromIndex === true,
    error: page.error ?? null,
  };
}

function describeIndex(index) {
  return {
    status: index.status,
    url: index.url ?? null,
    httpStatus: index.httpStatus ?? null,
    round: index.round ?? null,
    pagesDeclared: Array.isArray(index.targets) ? index.targets.length : 0,
    resumedFromAttempt: index.resumedFromAttempt ?? null,
    error: index.error ?? null,
  };
}

function notificationMessage(notification) {
  const round = notification.round === null || notification.round === undefined ? '轮次未知' : '轮次 ' + notification.round;
  const where = notification.pages?.length
    ? notification.pages.map(item => {
      const ranges = item.ranges?.length ? item.ranges : (item.range ? [item.range] : []);
      return item.page + ranges.map(range => ' [' + range[0] + ',' + range[1] + ')').join('');
    }).join('、')
    : '';
  const part = [round, where].filter(Boolean).join('，');
  switch (notification.state) {
    case 'present':
      return '成员 ' + notification.id + ' 存在'
        + (notification.newMember ? '（新发现的成员）' : '') + '：' + part;
    case 'renamed': {
      const base = '成员 ' + notification.id + ' 改名，成员身份不变：'
        + (notification.from?.name ?? '未命名') + ' → ' + notification.to?.name + '；' + part;
      if (notification.contentChange) {
        return base + '；同时内容变化 ' + notification.contentChange.from.digest
          + ' → ' + notification.contentChange.to.digest;
      }
      return base;
    }
    case 'content-changed':
      return '成员 ' + notification.id + ' 内容变化：'
        + (notification.contentChange?.from?.digest ?? notification.from?.digest ?? '未知')
        + ' → ' + (notification.contentChange?.to?.digest ?? notification.digest) + '；' + part;
    case 'missing':
      return '成员 ' + notification.id + ' 明确缺失：轮次 ' + (notification.round ?? '未知')
        + ' 的完整范围 '
        + (notification.coveredBy?.range
          ? '[' + notification.coveredBy.range[0] + ',' + notification.coveredBy.range[1] + ')'
          : '未知')
        + ' 已完整清点但没有该成员（依据 ' + (notification.coveredBy?.page ?? '完整页') + '）';
    case 'unchecked':
      return '成员 ' + notification.id + ' 尚未清点：' + (notification.reason ?? '缺少同一轮次的完整范围');
    default:
      return '成员 ' + notification.id + '：' + notification.state;
  }
}

function summarize({ pages, members, index, targetRound, publications }) {
  const readable = pages.filter(page => page.status === 'ok');
  const failedNow = pages.filter(page => page.currentAttempt || page.status !== 'ok');
  return {
    round: targetRound ?? null,
    indexStatus: index.status,
    pagesRead: readable.length,
    pagesOffline: failedNow.filter(page => (page.currentAttempt ?? page).status === 'offline').length,
    pagesUnreadable: failedNow.filter(page => (page.currentAttempt ?? page).status === 'invalid').length,
    pagesServedFromEarlier: pages.filter(page => page.origin === 'reused').length,
    absenceCheckedPages: publications.filter(item => item.absenceChecked).length,
    present: members.filter(member => ['present', 'renamed', 'content-changed'].includes(member.state)).length,
    missing: members.filter(member => member.state === 'missing').length,
    unchecked: members.filter(member => member.state === 'unchecked').length,
    renamedOrChanged: members.filter(member => member.renamed || member.contentChanged).length,
    // True when this run could not read every declared page now. Callers must
    // not read that as "the directory is complete".
    partial: failedNow.length > 0 || index.status !== 'ok',
  };
}

function pendingFor({ pages, targetRound, publications }) {
  const currentFailure = page => page.currentAttempt ?? (page.status !== 'ok' ? page : null);
  return {
    offline: pages.filter(page => currentFailure(page)?.status === 'offline').map(page => ({
      page: pageLabel(page),
      url: page.url ?? null,
      httpStatus: currentFailure(page).httpStatus ?? null,
      error: currentFailure(page).error ?? null,
      servedFromEarlierAttempt: page.origin === 'reused' ? page.evidenceAttempt : null,
    })),
    otherRound: pages.filter(page => page.status === 'ok' && !roundMatches(page.round, targetRound)
      && page.round !== null && page.round !== undefined).map(page => ({
        page: pageLabel(page),
        round: page.round,
        ranges: pageRanges(page),
        reason: '页面声明属于另一清点轮次，不能支持本轮缺失结论',
      })),
    undeclaredRound: pages.filter(page => page.status === 'ok'
      && (page.round === null || page.round === undefined)).map(page => ({
        page: pageLabel(page),
        ranges: pageRanges(page),
        reason: '页面没有声明清点轮次，不能支持缺失结论',
      })),
    incomplete: pages.filter(page => page.status === 'ok' && page.round !== null && page.round !== undefined
      && roundMatches(page.round, targetRound) && !page.complete).map(page => ({
        page: pageLabel(page),
        round: page.round,
        ranges: pageRanges(page),
        reason: '页面声明范围未完整检查',
      })),
    unreadable: pages.filter(page => currentFailure(page)?.status === 'invalid').map(page => ({
      page: pageLabel(page),
      error: currentFailure(page).error ?? null,
      servedFromEarlierAttempt: page.origin === 'reused' ? page.evidenceAttempt : null,
    })),
    absencePossible: publications.some(item => item.absenceChecked),
  };
}

/**
 * Business entry point.
 *
 * Persistence order inside stateDir:
 *   1. pages/attempt-N/<page>.json   raw supplier copies (written first)
 *   2. state.json                    interpreted metadata + notification registry
 *   3. result.json                   published result
 * A crash between 1 and 2 is recovered from the raw copies on the next run.
 */
export async function run({ source, stateDir, input = {} } = {}) {
  if (!source) throw new Error('缺少 source（本地资料源地址）');
  if (!stateDir) throw new Error('缺少 stateDir（跨次执行状态目录）');
  const directory = path.resolve(stateDir);
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const { state, recovered } = await loadState(directory);
  state.prior = mergePrior(state.prior, input.prior);
  state.notifications = state.notifications && typeof state.notifications === 'object' && !Array.isArray(state.notifications)
    ? state.notifications
    : {};

  const attemptNumber = nextAttemptNumber(state);
  const previousAttempts = state.attempts.filter(item => item.attempt !== attemptNumber);
  const attempt = {
    attempt: attemptNumber,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    index: null,
    pages: [],
    summary: null,
  };
  state.attempts.push(attempt);

  const fetched = await fetchCensus({
    source, stateDir: directory, state: { attempts: previousAttempts }, attemptNumber, timeoutMs,
  });
  attempt.index = fetched.index;
  attempt.pages = fetched.pages;
  // Persist interpreted page metadata before judging: a crash after this point
  // must not turn already-verified pages back into "never seen".
  await saveState(directory, state);

  const targetRound = fetched.index.round ?? null;
  const carriedPages = carryDroppedPages({
    currentPages: fetched.pages, previousAttempts, targetRound,
  });
  const pages = assembleEvidence({ currentPages: carriedPages, previousAttempts, targetRound });
  const evaluated = evaluateMembers({ prior: state.prior, targetRound, pages });
  // Discovered members become part of the durable baseline, so the next round
  // can legitimately conclude they went missing instead of treating them as
  // never seen.
  state.prior = rememberObserved(state.prior, evaluated.members);
  const publications = publicationsFor({ pages, targetRound, attempt: attemptNumber });
  const announced = notificationsFor(evaluated.members, targetRound);
  const fresh = selectNewNotifications(announced, state.notifications);
  state.notifications = fresh.registry;
  const notifications = fresh.notifications.map(notification => ({
    ...notification,
    message: notificationMessage(notification),
  }));

  const result = {
    attempt: attemptNumber,
    round: targetRound,
    index: describeIndex(fetched.index),
    states: evaluated.states,
    members: evaluated.members,
    contents: evaluated.contents,
    changes: changesFor(evaluated.members),
    notifications,
    publications,
    coverage: evaluated.coverage,
    pages: pages.map(page => describePage(page, targetRound)),
    pending: pendingFor({ pages, targetRound, publications }),
    memberCount: evaluated.memberCount,
    contentCount: evaluated.contentCount,
    summary: summarize({ pages, members: evaluated.members, index: fetched.index, targetRound, publications }),
    recoveredState: recovered,
    verifiedAt: new Date().toISOString(),
  };

  attempt.finishedAt = new Date().toISOString();
  attempt.status = 'finished';
  attempt.summary = result.summary;
  await saveState(directory, state);
  await atomicWriteJson(path.join(directory, 'result.json'), result);
  return result;
}
