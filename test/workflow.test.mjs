import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from '../src/source.mjs';

const { run } = await import('../src/workflow.mjs');

async function withState() {
  return mkdtemp(path.join(tmpdir(), 'census-state-'));
}

function scenarioOf(routes, name = '演练') {
  return { name, routes };
}

const prior = [
  { id: 'a', key: 10, name: 'alpha', digest: 'd1' },
  { id: 'b', key: 60, name: 'bravo', digest: 'd2' },
  { id: 'c', key: 70, name: 'charlie', digest: 'd3' },
];

test('重叠范围：同一成员不复制内容，但保留每轮每页的存在事实', async () => {
  const scenario = scenarioOf([
    { path: '/census', body: { round: 'r1', pages: ['/p1', '/p2'] } },
    { path: '/p1', body: { round: 'r1', range: [0, 50], complete: true, members: [
      { id: 'a', key: 10, name: 'alpha', digest: 'd1' },
      { id: 'b', key: 60, name: 'bravo', digest: 'd2' },
    ] } },
    { path: '/p2', body: { round: 'r1', range: [25, 100], complete: true, members: [
      // b 同时落在两个重叠范围；d1/d2 与 p1 重复，不得产生新内容记录
      { id: 'b', key: 60, name: 'bravo', digest: 'd2' },
      { id: 'c', key: 70, name: 'charlie', digest: 'd3' },
    ] } },
  ]);
  const source = await startSource(scenario);
  const stateDir = await withState();
  try {
    const result = await run({ source: source.url, stateDir, input: { prior } });
    assert.equal(result.memberCount, 3);
    assert.equal(result.contentCount, 3); // 三个不同 digest，而不是五个
    assert.deepEqual(result.states, { a: 'present', b: 'present', c: 'present' });

    const members = JSON.parse(await readFile(path.join(stateDir, 'members.json'), 'utf8'));
    assert.equal(members.b.observations.length, 2); // 两个范围的确认事实都在
    assert.deepEqual(members.b.observations.map(o => o.page).sort(), ['/p1', '/p2']);
    const contents = JSON.parse(await readFile(path.join(stateDir, 'contents.json'), 'utf8'));
    assert.deepEqual(Object.keys(contents).sort(), ['d1', 'd2', 'd3']);
    assert.equal(contents.d2.members.length, 1); // 同 digest 不合并成员，也不复制内容
    assert.equal(contents.d2.seen.length, 2);    // 两次出现的证据仍保留
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('部分页不能推出缺失；同轮完整页覆盖的成员才标 missing', async () => {
  const scenario = scenarioOf([
    { path: '/census', body: { round: 'r1', pages: ['/p1', '/p2'] } },
    { path: '/p1', body: { round: 'r1', range: [0, 50], complete: true, members: [] } },
    { path: '/p2', body: { round: 'r1', range: [50, 100], complete: false, members: [] } },
  ]);
  const source = await startSource(scenario);
  const stateDir = await withState();
  try {
    const result = await run({ source: source.url, stateDir, input: { prior } });
    assert.equal(result.states.a, 'missing');   // 完整范围 [0,50) 内未出现
    assert.equal(result.states.b, 'unchecked'); // 只被部分页 [50,100) 覆盖
    assert.equal(result.states.c, 'unchecked');
    assert.equal(result.evidence.b.reasons[0].reason, 'partial-page');
    assert.equal(result.evidence.c.reasons[0].reason, 'partial-page');
    assert.equal(result.failedPages.length, 0);
    const runFiles = await readdir(path.join(stateDir, 'runs'));
    const runRecord = JSON.parse(await readFile(path.join(stateDir, 'runs', runFiles[0], 'run.json'), 'utf8'));
    assert.equal(runRecord.status, 'complete');
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('离线页：读取失败不被当作删除，恢复后重启续接可转为明确结论', async () => {
  const scenario = scenarioOf([
    { path: '/census', body: { round: 'r1', pages: ['/p1', '/p2'] } },
    { path: '/p1', body: { round: 'r1', range: [0, 50], complete: true, members: [
      { id: 'a', key: 10, name: 'alpha', digest: 'd1' },
    ] } },
    {
      path: '/p2',
      replies: [
        { status: 503, body: { error: '站点离线' } },
        { status: 503, body: { error: '站点离线' } }, // 客户端内部重试一次，仍失败
        { status: 200, body: { round: 'r1', range: [50, 100], complete: true, members: [] } },
      ],
    },
  ]);
  const source = await startSource(scenario);
  const stateDir = await withState();
  try {
    const first = await run({ source: source.url, stateDir, input: { prior } });
    assert.equal(first.states.a, 'present');
    assert.equal(first.states.b, 'unchecked'); // p2 离线，不能判缺失
    assert.equal(first.states.c, 'unchecked');
    assert.equal(first.failedPages[0].ref, '/p2');

    // 重启：同一 stateDir 续接，已成功的 p1 不重复抓取
    const second = await run({ source: source.url, stateDir, input: { prior } });
    assert.equal(second.states.b, 'missing');
    assert.equal(second.states.c, 'missing');
    assert.equal(second.failedPages.length, 0);
    const p1Hits = source.history.filter(entry => entry.path === '/p1').length;
    assert.equal(p1Hits, 1, '续接不应重复读取已落盘的完整页');
    const p2Hits = source.history.filter(entry => entry.path === '/p2').length;
    assert.equal(p2Hits, 3, '首次运行两次尝试均失败，重启后再抓取成功');

    // 续接后的分范围发布不得重复通知首次已交付的 a:present（run-summary 是全量快照，不计入）
    const runFiles = await readdir(path.join(stateDir, 'runs'));
    const pubDir = path.join(stateDir, 'runs', runFiles[0], 'publications');
    const publications = (await readdir(pubDir)).sort().map(file =>
      JSON.parse(readFileSync(path.join(pubDir, file), 'utf8')));
    const presentNotes = publications
      .filter(pub => pub.kind === 'page-publication')
      .flatMap(pub => (pub.notifications ?? []).filter(note => note.id === 'a' && note.state === 'present'));
    assert.equal(presentNotes.length, 1, '重启续接不应重复发布已通知过的变化');
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('另一轮的完整页不能拼出本轮缺失，观察仅作证据保留', async () => {
  const scenario = scenarioOf([
    { path: '/census', body: { round: 'r2', pages: ['/p1'] } },
    { path: '/p1', body: { round: 'r1', range: [0, 100], complete: true, members: [
      { id: 'a', key: 10, name: 'alpha-old', digest: 'd0' },
    ] } },
  ]);
  const source = await startSource(scenario);
  const stateDir = await withState();
  try {
    const result = await run({ source: source.url, stateDir, input: { prior } });
    assert.equal(result.states.a, 'unchecked');
    assert.equal(result.states.b, 'unchecked');
    assert.equal(result.states.c, 'unchecked');
    const members = JSON.parse(await readFile(path.join(stateDir, 'members.json'), 'utf8'));
    // 另一轮的存在事实仍被保存，可追溯但不冒充本轮清点
    assert.equal(members.a.observations[0].round, 'r1');
    assert.equal(result.evidence.a.reasons[0].reason, 'different-round');
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('改名与内容变化：同 id 是同一成员，两类变化同时进入 changes', async () => {
  const scenario = scenarioOf([
    { path: '/census', body: { round: 'r9', pages: ['/p1'] } },
    { path: '/p1', body: { round: 'r9', range: [0, 100], complete: true, members: [
      { id: 'a', key: 10, name: 'alpha-renamed', digest: 'd1' }, // 只改名
      { id: 'b', key: 60, name: 'bravo', digest: 'd2-new' },     // 只变内容
      { id: 'c', key: 70, name: 'charlie-x', digest: 'd3-new' }, // 同时发生
    ] } },
  ]);
  const source = await startSource(scenario);
  const stateDir = await withState();
  try {
    const result = await run({ source: source.url, stateDir, input: { prior } });
    assert.equal(result.states.a, 'renamed');
    assert.equal(result.states.b, 'content-changed');
    assert.equal(result.states.c, 'content-changed'); // 内容变化优先，改名也在 changes 中
    const changeOf = id => result.changes.find(change => change.id === id);
    assert.deepEqual(changeOf('a'), { ...changeOf('a'), nameChanged: true, contentChanged: false });
    assert.equal(changeOf('b').contentChanged, true);
    assert.equal(changeOf('b').nameChanged, false);
    assert.equal(changeOf('c').nameChanged, true);
    assert.equal(changeOf('c').contentChanged, true);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('分范围发布：每页立即交付通知，且通知能区分五种状态', async () => {
  const scenario = scenarioOf([
    { path: '/census', body: { round: 'r1', pages: ['/p1', '/p2'] } },
    { path: '/p1', body: { round: 'r1', range: [0, 50], complete: true, members: [
      { id: 'a', key: 10, name: 'alpha', digest: 'd1' }, // present
      { id: 'b', key: 60, name: 'bravo-2', digest: 'd2' }, // renamed（范围外仍会作为观察发布）
    ] } },
    { path: '/p2', body: { round: 'r1', range: [50, 100], complete: false, members: [] } },
  ]);
  const source = await startSource(scenario);
  const stateDir = await withState();
  try {
    await run({ source: source.url, stateDir, input: { prior } });
    const runFiles = await readdir(path.join(stateDir, 'runs'));
    const pubDir = path.join(stateDir, 'runs', runFiles[0], 'publications');
    const publications = (await readdir(pubDir)).sort();
    assert.equal(publications.length, 3); // 两页各一次 + 最终汇总
    const first = JSON.parse(await readFile(path.join(pubDir, publications[0]), 'utf8'));
    assert.equal(first.kind, 'page-publication');
    assert.deepEqual(first.scope.range, [0, 50]);
    const reasons = Object.fromEntries(first.notifications.map(n => [n.id, n.reason]));
    assert.equal(reasons.a, 'present');
    assert.equal(reasons.b, 'renamed');
    const summary = JSON.parse(await readFile(path.join(pubDir, publications[2]), 'utf8'));
    assert.equal(summary.kind, 'run-summary');
    const finalReasons = Object.fromEntries(summary.notifications.map(n => [n.id, n.reason]));
    assert.equal(finalReasons.a, 'present');
    assert.equal(finalReasons.b, 'renamed');
    assert.equal(finalReasons.c, 'not-yet-censused');
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('新成员与同摘要不同成员：按供方 id 独立计数，不按 digest 合并', async () => {
  const scenario = scenarioOf([
    { path: '/census', body: { round: 'r1', pages: ['/p1'] } },
    { path: '/p1', body: { round: 'r1', range: [0, 100], complete: true, members: [
      { id: 'a', key: 10, name: 'alpha', digest: 'same' },
      { id: 'b', key: 60, name: 'bravo', digest: 'same' },
      { id: 'n', key: 90, name: 'newcomer', digest: 'dn' },
    ] } },
  ]);
  const source = await startSource(scenario);
  const stateDir = await withState();
  try {
    const result = await run({ source: source.url, stateDir, input: { prior: prior.slice(0, 2) } });
    assert.equal(result.memberCount, 3);
    assert.equal(result.contentCount, 2); // same 只存一份内容
    assert.equal(result.states.n, 'present');
    const note = result.notifications.find(item => item.id === 'n');
    assert.equal(note.isNewMember, true);
    const contents = JSON.parse(await readFile(path.join(stateDir, 'contents.json'), 'utf8'));
    assert.deepEqual(contents.same.members.sort(), ['a', 'b']);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('结果同时写入 stateDir/result.json，重启不依赖内存状态', async () => {
  const scenario = scenarioOf([
    { path: '/census', body: { round: 'r1', pages: ['/p1'] } },
    { path: '/p1', body: { round: 'r1', range: [0, 100], complete: true, members: [] } },
  ]);
  const source = await startSource(scenario);
  const stateDir = await withState();
  try {
    const result = await run({ source: source.url, stateDir, input: { prior } });
    const saved = JSON.parse(await readFile(path.join(stateDir, 'result.json'), 'utf8'));
    assert.deepEqual(saved.states, result.states);
    assert.equal(saved.runId, result.runId);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
