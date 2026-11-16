// 成员清点采集工作流入口。
//
// 设计要点：
// 1. 每页声明自己实际检查的键范围（半开区间）、清点轮次与是否完整；不同范围可以重叠。
// 2. 文件内容摘要（contents.json，按 digest 去重）与目录成员身份（members.json，按供方 id）
//    分开保存：同一文件出现在两个范围不复制内容，但每次“在某轮某页确认存在”的观察都保留。
// 3. 只有某个范围在同一清点轮次被完整覆盖（complete=true 且 round 等于清单轮次），
//    才可以对该范围内未出现的历史成员形成 missing；部分页、离线页、另一轮的页只能得到 unchecked。
// 4. 成员按供方 id 对齐：换名字不换 id 仍是同一成员（renamed）；同 digest 的不同成员不合并。
// 5. 每抓完一页立即做一次分范围发布，不等待所有站上线；重启只复用已落盘、可追溯的进度。
import { readFile } from 'node:fs/promises';
import { CensusStore, newRunId } from './census/store.mjs';
import { fetchCensus, fetchPage } from './census/client.mjs';
import { reconcile, notificationReason } from './census/classify.mjs';
import { rangeContains, samePageList } from './census/range.mjs';

export async function run({ source, stateDir, input }) {
  if (!source) throw new Error('缺少 source 来源地址');
  if (!stateDir) throw new Error('缺少 stateDir 状态目录');
  const prior = Array.isArray(input?.prior) ? input.prior : [];
  validatePrior(prior);

  const store = await new CensusStore(stateDir).load();
  const census = await fetchCensus(source); // 清单不可读时没有可交付证据，明确失败而非伪造结果

  // ---- 选择可续接的 run：同轮次、同一组页面、尚未完成 -------------------
  let runRecord = await findResumableRun(store, census);
  if (!runRecord) {
    runRecord = {
      runId: newRunId(),
      status: 'running',
      round: census.round,
      pages: census.pages,
      priorSnapshot: prior,
      startedAt: new Date().toISOString(),
      census: { round: census.round, pages: census.pages, raw: census.raw },
      pageStates: {},
      publicationCount: 0,
      deliveredKeys: [],
    };
    await store.saveRun(runRecord);
  } else {
    runRecord.status = 'running';
    runRecord.priorSnapshot = prior; // 输入以本次调用为准，证据仍在 pages/ 下可追溯
    await store.saveRun(runRecord);
  }

  // 续接时从磁盘恢复页面证据，保证缺失判定不会只基于内存。
  const pageRecords = [];
  for (const ref of census.pages) {
    const existing = runRecord.pageStates[ref];
    if (existing?.status === 'ok') {
      const { file } = store.pageFile(runRecord.runId, ref);
      pageRecords.push(JSON.parse(await readFile(file, 'utf8')));
    }
  }

  // 通知去重状态也从磁盘恢复，保证重启续接不会把已发布的变化再通知一次。
  const deliveredNotifications = new Set(runRecord.deliveredKeys ?? []); // 同一成员同一状态在本 run 内只通知一次
  for (const ref of census.pages) {
    const state = runRecord.pageStates[ref];
    let record;
    if (state?.status === 'ok') {
      record = pageRecords.find(item => item.ref === ref);
    } else {
      // 未抓过或上次失败（离线/超时/损坏）的页面重新抓取——失败从不被当作删除。
      record = await fetchPage(source, ref);
      await store.savePage(runRecord.runId, record);
      runRecord.pageStates[ref] = {
        status: record.status,
        round: record.round ?? null,
        range: record.range ?? null,
        complete: record.complete ?? null,
        fetchedAt: record.fetchedAt,
        error: record.error ?? null,
      };
      if (record.status === 'ok') pageRecords.push(record);
      await store.saveRun(runRecord);
    }

    if (record.status === 'ok') {
      for (const member of record.members) {
        store.observeMember(member, record.round, ref);
      }
      await store.persistIndexes();
    }

    // ---- 分范围发布：本页范围相关成员的最新判定 + 仍待清点的成员 ---------
    const result = reconcile({
      prior,
      memberIndex: store.members,
      contentIndex: store.contents,
      pageRecords,
      round: census.round,
    });
    const publication = buildPublication({
      runRecord, record, result, prior, deliveredNotifications,
    });
    runRecord.deliveredKeys = [...deliveredNotifications];
    runRecord.publicationCount += 1;
    await store.savePublication(runRecord.runId, runRecord.publicationCount, publication);
    await store.saveRun(runRecord);
  }

  // ---- 最终汇总发布 -----------------------------------------------------
  const finalResult = reconcile({
    prior,
    memberIndex: store.members,
    contentIndex: store.contents,
    pageRecords,
    round: census.round,
  });
  const failedPages = census.pages
    .filter(ref => runRecord.pageStates[ref]?.status !== 'ok')
    .map(ref => ({ ref, error: runRecord.pageStates[ref]?.error ?? '未读取' }));

  const summaryNotifications = buildAllNotifications(finalResult, prior);
  const summary = {
    kind: 'run-summary',
    runId: runRecord.runId,
    round: census.round,
    publishedAt: new Date().toISOString(),
    notifications: summaryNotifications,
    failedPages,
    coverage: {
      completeRanges: finalResult.completeRanges,
      fetchedPages: pageRecords.map(record => ({
        ref: record.ref, round: record.round, range: record.range, complete: record.complete,
      })),
    },
  };
  runRecord.publicationCount += 1;
  await store.savePublication(runRecord.runId, runRecord.publicationCount, summary);

  const result = {
    runId: runRecord.runId,
    round: census.round,
    states: finalResult.states,
    changes: finalResult.changes,
    memberCount: finalResult.memberCount,
    contentCount: finalResult.contentCount,
    evidence: finalResult.evidence,
    notifications: summaryNotifications,
    publications: runRecord.publicationCount,
    failedPages,
  };

  runRecord.status = failedPages.length > 0 ? 'partial' : 'complete';
  runRecord.finishedAt = new Date().toISOString();
  await store.saveRun(runRecord);
  await store.saveResult(runRecord.runId, result);
  return result;
}

function buildPublication({ runRecord, record, result, prior, deliveredNotifications }) {
  const scope = record.range
    ? { ref: record.ref, round: record.round, range: record.range, complete: record.complete ?? null, status: record.status }
    : { ref: record.ref, status: record.status, error: record.error ?? null };

  const notifications = [];
  const priorById = new Map(prior.map(member => [member.id, member]));
  const scopedIds = collectScopedIds({ record, result, priorById });

  for (const id of scopedIds) {
    const state = result.states[id];
    const key = id + ':' + state;
    if (deliveredNotifications.has(key)) continue;
    deliveredNotifications.add(key);
    notifications.push({
      id,
      state,
      reason: notificationReason(state),
      evidence: result.evidence[id],
    });
  }

  // 本页范围内、目前仍无法定论的历史成员：明确告诉调用方“尚未清点”及原因。
  const pending = [];
  if (record.range) {
    for (const member of prior) {
      if (!rangeContains(record.range, member.key)) continue;
      if (result.states[member.id] === 'unchecked') {
        pending.push({ id: member.id, reasons: result.evidence[member.id]?.reasons ?? [] });
      }
    }
  }
  if (record.status === 'failed') {
    pending.push(...prior.map(member => ({
      id: member.id,
      reasons: [{ page: record.ref, reason: 'page-offline', detail: record.error ?? '页面读取失败' }],
    })));
  }

  return {
    kind: 'page-publication',
    runId: runRecord.runId,
    sequence: runRecord.publicationCount + 1,
    publishedAt: new Date().toISOString(),
    scope,
    notifications,
    pending,
    warnings: record.warnings ?? [],
  };
}

// 与本页相关的成员：本页观察到的成员，以及键落在本页范围内的历史成员。
function collectScopedIds({ record, priorById }) {
  const ids = new Set();
  if (record.status === 'ok') {
    for (const member of record.members ?? []) ids.add(member.id);
  }
  if (record.range) {
    for (const [id, member] of priorById) {
      if (rangeContains(record.range, member.key)) ids.add(id);
    }
  }
  if (record.status === 'failed') {
    for (const id of priorById.keys()) ids.add(id);
  }
  return ids;
}

function buildAllNotifications(result, prior) {
  const priorById = new Map(prior.map(member => [member.id, member]));
  return Object.keys(result.states).sort().map(id => ({
    id,
    state: result.states[id],
    reason: notificationReason(result.states[id]),
    isNewMember: !priorById.has(id),
    evidence: result.evidence[id],
  }));
}

async function findResumableRun(store, census) {
  const runs = await store.listRuns();
  const candidate = runs
    .filter(run => run.status !== 'complete'
      && run.round === census.round
      && samePageList(run.pages, census.pages))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  return candidate ? store.readRun(candidate.runId) : null;
}

function validatePrior(prior) {
  for (const [index, member] of prior.entries()) {
    if (!member || typeof member.id !== 'string' || !Number.isFinite(member.key)
      || typeof member.name !== 'string' || typeof member.digest !== 'string') {
      throw new Error('input.prior[' + index + '] 字段不完整（需要 id/key/name/digest）');
    }
  }
}
