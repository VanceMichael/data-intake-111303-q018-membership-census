// 对账判定：把历史成员（prior）、本轮观察证据和已完整覆盖的范围合成成员状态。
//
// 关键纪律：
// - 只有同一清点轮次且 complete=true 的页面范围才能推出 missing；
//   部分页（complete=false）、离线/失败页、另一轮的页都不能拼出缺失结论。
// - 成员身份按供方 id 对齐：改名不换 id 仍是同一成员。
// - digest 相同的两个不同成员各自独立，绝不按摘要合并（合表发生在 contents，成员表不去重）。
import { rangesCover, rangeContains } from './range.mjs';

// 从已落盘的页面证据中，取出某一轮“完整覆盖”的范围集合。
export function completeRangesForRound(pageRecords, round) {
  return pageRecords
    .filter(record => record.status === 'ok' && record.round === round && record.complete === true)
    .map(record => record.range);
}

// 本轮（与清单声明同轮）实际确认存在的成员 id 集合，另一轮页面的观察不计入本轮。
export function observedIdsForRound(pageRecords, round) {
  const ids = new Set();
  for (const record of pageRecords) {
    if (record.status !== 'ok' || record.round !== round) continue;
    for (const member of record.members ?? []) ids.add(member.id);
  }
  return ids;
}

function explainUnchecked(prior, pageRecords, round) {
  // 说明“尚未清点”的具体原因，让通知可以区分部分页、离线页、另一轮页或根本未覆盖。
  const covering = pageRecords.filter(record => record.range && rangeContains(record.range, prior.key));
  const reasons = [];
  for (const record of covering) {
    if (record.status !== 'ok') reasons.push({ page: record.ref, reason: 'page-offline', detail: record.error ?? '页面读取失败' });
    else if (record.round !== round) reasons.push({ page: record.ref, reason: 'different-round', detail: '页面属于另一清点轮次 ' + record.round });
    else if (record.complete !== true) reasons.push({ page: record.ref, reason: 'partial-page', detail: '页面声明不完整，不能据此确认缺失' });
  }
  if (reasons.length === 0) reasons.push({ reason: 'out-of-any-fetched-range', detail: '没有任何已读取范围覆盖该键' });
  return reasons;
}

// 返回 { states, changes, evidence, memberCount, contentCount }
export function reconcile({ prior, memberIndex, contentIndex, pageRecords, round }) {
  const completeRanges = completeRangesForRound(pageRecords, round);
  const observedIds = observedIdsForRound(pageRecords, round);
  const priorIds = new Set(prior.map(member => member.id));
  const allIds = new Set([...priorIds, ...observedIds]);

  const states = {};
  const changes = [];
  const evidence = {};

  for (const id of allIds) {
    const previous = prior.find(member => member.id === id);
    const stored = memberIndex.get(id);
    const presentThisRound = observedIds.has(id);

    if (presentThisRound) {
      // 本轮确认存在：取本轮页面中该成员的最新观察作为现状。
      const observation = latestObservation(stored, round);
      const nameChanged = previous ? previous.name !== observation.name : false;
      const contentChanged = previous ? previous.digest !== observation.digest : false;
      let state;
      if (previous === undefined) {
        state = 'present'; // 历史没有、本轮新出现的成员
      } else if (contentChanged) {
        state = 'content-changed'; // 内容变化优先于改名，两个变化同时记入 changes
      } else if (nameChanged) {
        state = 'renamed';
      } else {
        state = 'present';
      }
      states[id] = state;
      evidence[id] = {
        confirmedInRound: round,
        observations: stored.observations.filter(item => item.round === round),
      };
      if (previous && (nameChanged || contentChanged)) {
        changes.push({
          id,
          from: { key: previous.key, name: previous.name, digest: previous.digest },
          to: { key: observation.key, name: observation.name, digest: observation.digest },
          nameChanged,
          contentChanged,
        });
      }
      continue;
    }

    // 本轮未观察到。只有同轮完整页覆盖其键，才能形成明确缺失。
    if (previous && rangesCover(completeRanges, previous.key)) {
      states[id] = 'missing';
      evidence[id] = {
        completeRanges: completeRanges.filter(range => rangeContains(range, previous.key)),
        confirmedInRound: round,
      };
    } else {
      states[id] = 'unchecked';
      evidence[id] = { reasons: explainUnchecked(previous ?? { id, key: stored?.current?.key }, pageRecords, round) };
    }
  }

  return {
    states,
    changes,
    evidence,
    memberCount: allIds.size,
    contentCount: contentIndex.size,
    completeRanges,
  };
}

function latestObservation(stored, round) {
  const inRound = stored.observations.filter(item => item.round === round);
  return inRound[inRound.length - 1] ?? stored.current;
}

// 状态到通知理由的映射，通知需要说明是存在、改名、内容变化、明确缺失还是尚未清点。
export function notificationReason(state) {
  switch (state) {
    case 'present': return 'present';
    case 'renamed': return 'renamed';
    case 'content-changed': return 'content-changed';
    case 'missing': return 'confirmed-missing';
    case 'unchecked': return 'not-yet-censused';
    default: return state;
  }
}
