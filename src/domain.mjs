import { asKey, rangeContains, roundMatches } from './util.mjs';

const PRESENT_STATES = new Set(['present', 'renamed', 'content-changed']);
const STATE_ORDER = { present: 0, renamed: 1, 'content-changed': 2, missing: 3, unchecked: 4 };

export function normalizePrior(raw) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || item.id === undefined || item.id === null) continue;
    const id = String(item.id);
    byId.set(id, {
      id,
      key: asKey(item.key),
      name: item.name === undefined || item.name === null ? null : String(item.name),
      digest: item.digest === undefined || item.digest === null ? null : String(item.digest),
    });
  }
  return [...byId.values()];
}

/**
 * The caller's historical list is authoritative for the ids it supplies:
 * its states are reported on every run, so two identical runs are stable.
 * Members the receiver discovered itself and the caller never listed are
 * remembered, so they cannot silently fall out of the census.
 */
export function mergePrior(stored, incoming) {
  const byId = new Map();
  for (const item of normalizePrior(stored)) byId.set(item.id, { ...item, origin: item.origin ?? 'state' });
  if (Array.isArray(incoming)) {
    for (const item of normalizePrior(incoming)) byId.set(item.id, { ...item, origin: 'input' });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Remember members the receiver actually saw, so a member discovered in one
 * round is still a historical member in the next: if a later round completely
 * covers its key and no longer lists it, that is a real absence rather than a
 * first sighting. Members the caller supplied keep the caller's baseline.
 */
export function rememberObserved(statePrior, members) {
  const byId = new Map(statePrior.map(item => [item.id, item]));
  for (const member of members) {
    if (!PRESENT_STATES.has(member.state)) continue;
    const existing = byId.get(member.id);
    // The caller's baseline for an id stays authoritative; entries this
    // receiver discovered itself track the latest confirmed reading.
    if (existing && existing.origin !== 'observed') continue;
    byId.set(member.id, {
      id: member.id,
      key: member.key,
      name: member.name,
      digest: member.digest,
      origin: 'observed',
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function pageRanges(page) {
  return page.ranges?.length > 0 ? page.ranges : (page.range ? [page.range] : []);
}

export function pageLabel(page) {
  return page.targetKey ?? 'page:' + (typeof page.target === 'string' ? page.target : JSON.stringify(page.target));
}

/**
 * Union of declared ranges from pages that are readable, complete AND from
 * the target round. This union is the only thing that may support an absence
 * conclusion. Incomplete, offline, invalid and other-round pages never
 * contribute.
 */
export function completeCoverage(pages, targetRound) {
  const intervals = [];
  for (const page of pages) {
    if (page.status !== 'ok' || page.offline) continue;
    if (!page.complete || !page.hasMembers) continue;
    if (!roundMatches(page.round, targetRound)) continue;
    for (const range of pageRanges(page)) {
      if (range[1] > range[0]) intervals.push([...range]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function coverageFor(coverage, key) {
  if (key === null || key === undefined) return null;
  for (const range of coverage) {
    if (rangeContains(range, key)) return range;
  }
  return null;
}

function observationList(page) {
  if (page.status !== 'ok') return [];
  return page.members.map(member => ({
    id: member.id,
    key: member.key,
    name: member.name,
    digest: member.digest,
    round: page.round ?? null,
    range: page.range ?? null,
    ranges: pageRanges(page),
    complete: Boolean(page.complete),
    inTargetRound: false,
    pageTarget: pageLabel(page),
    pageUrl: page.url ?? null,
    attempt: page.evidenceAttempt ?? null,
    fetchedAt: page.fetchedAt ?? null,
    origin: page.origin ?? 'current',
  }));
}

function latestObservation(observations) {
  if (observations.length === 0) return null;
  return [...observations].sort((a, b) => {
    const left = Date.parse(a.fetchedAt ?? '') || 0;
    const right = Date.parse(b.fetchedAt ?? '') || 0;
    if (left !== right) return right - left;
    return String(a.pageTarget).localeCompare(String(b.pageTarget));
  })[0];
}

function confirmationFingerprint(observation) {
  return JSON.stringify([
    observation.round, observation.range, observation.pageTarget,
    observation.name, observation.key, observation.digest,
  ]);
}

/**
 * One confirmation per (round, page, range, member attributes). Seeing the
 * same member in two overlapping ranges yields two confirmations; seeing it
 * twice on the same page/range yields one. The round in which it was
 * confirmed is never discarded.
 */
function confirmationsFor(observations) {
  const seen = new Set();
  const confirmations = [];
  for (const observation of observations) {
    const fingerprint = confirmationFingerprint(observation);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    confirmations.push({
      round: observation.round,
      range: observation.range,
      ranges: observation.ranges,
      complete: observation.complete,
      inTargetRound: observation.inTargetRound,
      page: observation.pageTarget,
      url: observation.pageUrl,
      attempt: observation.attempt,
      fetchedAt: observation.fetchedAt,
      origin: observation.origin,
    });
  }
  confirmations.sort((a, b) => String(a.round ?? '').localeCompare(String(b.round ?? ''))
    || String(a.page).localeCompare(String(b.page)));
  return confirmations;
}

/**
 * Decide each member against the historical baseline.
 *
 * - `missing` requires all of: a historical member exists, its key lies
 *   inside the complete coverage union of the target round, and no page of
 *   that same round lists it. Evidence from other rounds (or from partial
 *   pages) can never fill the gap, but it is preserved as a confirmation.
 * - Presence, rename and content change are derived from target-round
 *   evidence; a member seen only in another round stays `unchecked` for this
 *   round.
 * - Identity is the supplier id only. Equal digests never merge members, and
 *   a changed name with the same id is the same member renamed.
 */
export function evaluateMembers({ prior, targetRound, pages }) {
  const coverage = completeCoverage(pages, targetRound);
  const observationsById = new Map();
  const seen = new Set();
  for (const page of pages) {
    for (const observation of observationList(page)) {
      observation.inTargetRound = roundMatches(observation.round, targetRound);
      const fingerprint = JSON.stringify([observation.id, confirmationFingerprint(observation), observation.origin]);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      const list = observationsById.get(observation.id) ?? [];
      list.push(observation);
      observationsById.set(observation.id, list);
    }
  }

  const priorById = new Map(prior.map(item => [item.id, item]));
  const ids = [...new Set([...priorById.keys(), ...observationsById.keys()])].sort();
  const states = {};
  const members = [];

  for (const id of ids) {
    const previous = priorById.get(id) ?? null;
    const observations = observationsById.get(id) ?? [];
    const targetObservations = observations.filter(item => item.inTargetRound);
    const otherObservations = observations.filter(item => !item.inTargetRound);
    const coveredRange = previous ? coverageFor(coverage, previous.key) : null;
    const primary = latestObservation(targetObservations);

    let state;
    if (previous && coveredRange && !primary) {
      state = 'missing';
    } else if (primary) {
      const renamed = Boolean(previous && previous.name !== null && primary.name !== null
        && previous.name !== primary.name);
      const contentChanged = Boolean(previous && previous.digest !== null && primary.digest !== null
        && previous.digest !== primary.digest);
      state = renamed ? 'renamed' : (contentChanged ? 'content-changed' : 'present');
    } else {
      state = 'unchecked';
    }
    states[id] = state;

    const member = {
      id,
      state,
      key: primary?.key ?? previous?.key ?? null,
      name: primary?.name ?? previous?.name ?? null,
      digest: primary?.digest ?? previous?.digest ?? null,
      previous: previous ? { key: previous.key, name: previous.name, digest: previous.digest } : null,
      rounds: [...new Set(observations.map(item => item.round ?? null))],
      confirmedIn: confirmationsFor(observations),
      newMember: Boolean(!previous && state === 'present'),
      renamed: Boolean(previous && primary && previous.name !== null && primary.name !== null
        && previous.name !== primary.name),
      contentChanged: Boolean(previous && primary && previous.digest !== null && primary.digest !== null
        && previous.digest !== primary.digest),
      primaryRound: primary?.round ?? null,
    };
    if (previous && primary && previous.key !== null && primary.key !== null && previous.key !== primary.key) {
      member.previousKey = previous.key;
    }
    // Two overlapping ranges in the same round disagreeing about a member's
    // name or digest is real evidence of supplier inconsistency. Keep both
    // readings instead of silently picking one as "the truth".
    const conflicts = [];
    const names = [...new Set(targetObservations.map(item => item.name).filter(value => value !== null))];
    const digests = [...new Set(targetObservations.map(item => item.digest).filter(value => value !== null))];
    if (names.length > 1) conflicts.push({ field: 'name', values: names });
    if (digests.length > 1) conflicts.push({ field: 'digest', values: digests });
    if (conflicts.length > 0) member.conflicts = conflicts;
    if (targetObservations.length > 0) {
      member.observedAt = targetObservations.map(item => ({
        round: item.round, range: item.range, page: item.pageTarget,
        name: item.name, key: item.key, digest: item.digest,
      }));
    }
    if (state === 'missing') {
      const coveringPage = pages.find(page =>
        page.status === 'ok' && page.complete && page.hasMembers && roundMatches(page.round, targetRound)
        && pageRanges(page).some(range => rangeContains(range, previous.key)));
      member.missingEvidence = {
        round: targetRound,
        key: previous.key,
        range: coveredRange,
        ranges: coveringPage ? pageRanges(coveringPage) : [],
        page: coveringPage ? pageLabel(coveringPage) : null,
        url: coveringPage?.url ?? null,
        attempt: coveringPage?.evidenceAttempt ?? null,
        fetchedAt: coveringPage?.fetchedAt ?? null,
      };
    }
    if (state === 'unchecked') {
      member.observedInOtherRounds = [...new Set(otherObservations.map(item => item.round ?? null))];
      member.reason = previous
        ? (otherObservations.length > 0
          ? '另一轮次曾看到该成员，但本轮所属轮次没有覆盖它的完整范围'
          : '同一轮次的完整范围没有覆盖该成员，且本轮没有看到它')
        : '本轮没有同一轮次的存在证据';
    }
    members.push(member);
  }

  const presentMembers = members.filter(item => PRESENT_STATES.has(item.state));
  const contents = collectContents(presentMembers, observationsById);
  return {
    states,
    members,
    contents,
    memberCount: presentMembers.length,
    contentCount: contents.length,
    coverage,
  };
}

/**
 * Content is stored once per digest and may be referenced by several distinct
 * members. Membership and the rounds in which each member was confirmed are
 * kept in the member records and in the content confirmations, never as
 * duplicate content copies.
 */
function collectContents(presentMembers, observationsById) {
  const byDigest = new Map();
  for (const member of presentMembers) {
    if (member.digest === null) continue;
    const content = byDigest.get(member.digest)
      ?? { digest: member.digest, memberIds: new Set(), confirmations: [], seen: new Set() };
    for (const observation of observationsById.get(member.id) ?? []) {
      if (observation.digest !== member.digest) continue;
      const fingerprint = JSON.stringify([member.id, observation.round, observation.range, observation.pageTarget]);
      if (content.seen.has(fingerprint)) continue;
      content.seen.add(fingerprint);
      content.memberIds.add(member.id);
      content.confirmations.push({
        memberId: member.id,
        round: observation.round,
        range: observation.range,
        ranges: observation.ranges,
        complete: observation.complete,
        inTargetRound: observation.inTargetRound,
        page: observation.pageTarget,
        url: observation.pageUrl,
        attempt: observation.attempt,
        fetchedAt: observation.fetchedAt,
        origin: observation.origin,
      });
    }
    byDigest.set(member.digest, content);
  }
  return [...byDigest.values()]
    .map(content => ({
      digest: content.digest,
      memberIds: [...content.memberIds].sort(),
      rounds: [...new Set(content.confirmations.map(item => item.round ?? null))],
      confirmations: content.confirmations.sort((a, b) =>
        a.memberId.localeCompare(b.memberId)
        || String(a.round ?? '').localeCompare(String(b.round ?? ''))
        || (a.range?.[0] ?? Infinity) - (b.range?.[0] ?? Infinity)),
    }))
    .sort((a, b) => a.digest.localeCompare(b.digest));
}

export function changesFor(members) {
  const changes = [];
  for (const member of members) {
    if (member.renamed) {
      changes.push({
        state: 'renamed',
        id: member.id,
        round: member.primaryRound,
        from: { name: member.previous?.name ?? null, key: member.previous?.key ?? null },
        to: { name: member.name, key: member.key },
        ranges: member.confirmedIn[0]?.ranges ?? [],
        page: member.confirmedIn[0]?.page ?? null,
      });
    }
    if (member.contentChanged) {
      changes.push({
        state: 'content-changed',
        id: member.id,
        round: member.primaryRound,
        from: { digest: member.previous?.digest ?? null },
        to: { digest: member.digest },
        ranges: member.confirmedIn[0]?.ranges ?? [],
        page: member.confirmedIn[0]?.page ?? null,
      });
    }
    if (member.newMember) {
      changes.push({
        state: 'present',
        id: member.id,
        round: member.primaryRound,
        newMember: true,
        name: member.name,
        key: member.key,
        digest: member.digest,
        ranges: member.confirmedIn[0]?.ranges ?? [],
        page: member.confirmedIn[0]?.page ?? null,
      });
    }
    if (member.state === 'missing') {
      changes.push({
        state: 'missing',
        id: member.id,
        round: member.missingEvidence?.round ?? null,
        key: member.missingEvidence?.key ?? null,
        coveredBy: member.missingEvidence ?? null,
      });
    }
    if (member.state === 'unchecked') {
      changes.push({
        state: 'unchecked',
        id: member.id,
        round: null,
        key: member.previous?.key ?? null,
        reason: member.reason ?? null,
      });
    }
  }
  return changes.sort((a, b) => a.id.localeCompare(b.id)
    || (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9));
}

/**
 * A notification describes one member's currently announced situation:
 * existence, a rename, a content change, an explicit absence, or that the
 * member has not been surveyed for this round. When a rename and a content
 * change happen together, the rename is the headline and `also` keeps the
 * content change, so a single member never produces duplicate notifications.
 */
export function notificationsFor(members, targetRound) {
  const notifications = [];
  for (const member of members) {
    const confirmation = member.confirmedIn.find(item => roundMatches(item.round, member.primaryRound))
      ?? member.confirmedIn[0]
      ?? null;
    const pages = confirmation
      ? [{ page: confirmation.page, range: confirmation.range, ranges: confirmation.ranges, round: confirmation.round }]
      : [];
    if (member.state === 'missing') {
      notifications.push({
        state: 'missing',
        id: member.id,
        round: member.missingEvidence?.round ?? null,
        key: member.missingEvidence?.key ?? null,
        coveredBy: member.missingEvidence ?? null,
        signature: ['missing', member.id, member.missingEvidence?.key ?? null,
          member.missingEvidence?.range ? member.missingEvidence.range.join(':') : null].join('|'),
      });
      continue;
    }
    if (member.state === 'unchecked') {
      notifications.push({
        state: 'unchecked',
        id: member.id,
        round: targetRound ?? null,
        key: member.previous?.key ?? null,
        reason: member.reason ?? '缺少同一轮次的完整范围',
        observedInOtherRounds: member.observedInOtherRounds ?? [],
        signature: ['unchecked', member.id, member.previous?.key ?? null].join('|'),
      });
      continue;
    }
    const also = [];
    if (member.renamed && member.contentChanged) {
      also.push({
        state: 'content-changed',
        from: { digest: member.previous?.digest ?? null },
        to: { digest: member.digest },
      });
    }
    const headline = member.renamed ? 'renamed' : (member.contentChanged ? 'content-changed' : 'present');
    const notification = {
      state: headline,
      id: member.id,
      round: confirmation?.round ?? member.primaryRound ?? null,
      name: member.name,
      key: member.key,
      digest: member.digest,
      newMember: member.newMember,
      pages,
    };
    if (member.renamed) {
      notification.from = { name: member.previous?.name ?? null, key: member.previous?.key ?? null };
      notification.to = { name: member.name, key: member.key };
    }
    if (member.contentChanged) {
      notification.contentChange = {
        from: { digest: member.previous?.digest ?? null },
        to: { digest: member.digest },
      };
    }
    if (also.length > 0) notification.also = also;
    const signatureParts = [headline, member.id, member.name, member.key, member.digest];
    if (member.renamed) signatureParts.push('from:' + (member.previous?.name ?? ''), 'fromKey:' + (member.previous?.key ?? ''));
    if (member.contentChanged) signatureParts.push('fromDigest:' + (member.previous?.digest ?? ''));
    notification.signature = signatureParts.join('|');
    notifications.push(notification);
  }
  return notifications;
}

/**
 * Notifications are announced when a member's announced signature changes,
 * not on every run and not on every round. The registry stores only the last
 * announced signature per member, so the feed never re-announces a fact that
 * is still true and a member that reappears after a confirmed absence is
 * announced again.
 */
export function selectNewNotifications(notifications, registry) {
  const fresh = [];
  const next = { ...(registry ?? {}) };
  for (const notification of notifications) {
    if (next[notification.id] === notification.signature) continue;
    next[notification.id] = notification.signature;
    fresh.push(notification);
  }
  return { notifications: fresh, registry: next };
}

/**
 * Per-range publication: every readable page is delivered as soon as it is
 * read, even while other stations remain offline. `absenceChecked` marks the
 * only pages allowed to explain a missing member.
 */
export function publicationsFor({ pages, targetRound, attempt }) {
  return pages
    .filter(page => page.status === 'ok')
    .map(page => ({
      page: pageLabel(page),
      url: page.url ?? null,
      round: page.round ?? null,
      inTargetRound: Boolean(roundMatches(page.round, targetRound)),
      ranges: pageRanges(page),
      complete: Boolean(page.complete),
      absenceChecked: Boolean(page.complete && page.hasMembers && roundMatches(page.round, targetRound)),
      memberIds: [...new Set(page.members.map(member => member.id))].sort(),
      memberCount: page.memberCount,
      origin: page.origin ?? 'current',
      evidenceAttempt: page.evidenceAttempt ?? null,
      currentAttempt: page.currentAttempt ?? null,
      verifiedAt: page.fetchedAt ?? null,
      attempt,
    }))
    .sort((a, b) => String(a.verifiedAt ?? '').localeCompare(String(b.verifiedAt ?? ''))
      || String(a.page).localeCompare(String(b.page)));
}
