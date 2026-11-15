import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from '../src/source.mjs';
import { run } from '../src/workflow.mjs';

async function withSource(scenario, body) {
  const source = await startSource(scenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'census-test-'));
  try {
    return await body({ source, stateDir });
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

const member = (id, key, name, digest) => ({ id, key, name, digest });

test('重叠范围：成员确认保留两轮证据，内容只保存一份', async () => {
  const scenario = {
    name: 'overlap',
    routes: [
      { path: '/census', body: { round: 'r7', pages: ['/left', '/right'] } },
      {
        path: '/left',
        body: {
          round: 'r7', range: [0, 60], complete: true,
          members: [member('a', 10, 'a', 'shared'), member('b', 55, 'b', 'b-content')],
        },
      },
      {
        path: '/right',
        body: {
          round: 'r7', range: [50, 100], complete: true,
          members: [member('b', 55, 'b', 'b-content'), member('c', 70, 'c', 'shared')],
        },
      },
    ],
  };
  await withSource(scenario, async ({ source, stateDir }) => {
    const result = await run({ source: source.url, stateDir, input: { prior: [] } });
    assert.deepEqual(result.states, { a: 'present', b: 'present', c: 'present' });
    assert.equal(result.memberCount, 3);
    assert.equal(result.contentCount, 2, '同摘要的两个成员只能有一份内容');

    const b = result.members.find(item => item.id === 'b');
    assert.equal(b.confirmedIn.length, 2, '同一成员在两个范围被确认不能丢掉任何一轮');
    assert.deepEqual(b.confirmedIn.map(item => item.range), [[0, 60], [50, 100]]);

    const shared = result.contents.find(item => item.digest === 'shared');
    assert.deepEqual(shared.memberIds, ['a', 'c'], '同摘要不同成员不合并');
    assert.equal(shared.confirmations.length, 2);
    assert.deepEqual(result.coverage, [[0, 100]]);
  });
});

test('部分页与离线页都不能支持缺失结论', async () => {
  const scenario = {
    name: 'partial-and-offline',
    routes: [
      { path: '/census', body: { round: 'r3', pages: ['/partial', '/offline', '/full'] } },
      {
        path: '/partial',
        body: { round: 'r3', range: [0, 50], complete: false, members: [member('seen', 5, 'seen', 'd')] },
      },
      { path: '/offline', status: 503, body: '站点离线' },
      { path: '/full', body: { round: 'r3', range: [90, 100], complete: true, members: [] } },
    ],
  };
  const prior = [
    member('a', 10, 'a', 'x'),
    member('b', 60, 'b', 'y'),
    member('c', 95, 'c', 'z'),
  ];
  await withSource(scenario, async ({ source, stateDir }) => {
    const result = await run({ source: source.url, stateDir, input: { prior } });
    assert.equal(result.states.a, 'unchecked', '部分页未覆盖 a，不能判定缺失');
    assert.equal(result.states.b, 'unchecked', '离线页不能当成空目录');
    assert.equal(result.states.c, 'missing', '完整覆盖的范围可以确认缺失');
    assert.equal(result.states.seen, 'present');
    assert.equal(result.summary.partial, true);
    assert.ok(result.pages.find(page => page.page.endsWith('/offline')).status === 'offline');
    assert.ok(result.pending.offline.some(item => item.page.endsWith('/offline')));
    assert.ok(result.pending.incomplete.some(item => item.page.endsWith('/partial')));
    const missing = result.notifications.find(item => item.state === 'missing');
    assert.equal(missing.id, 'c');
    assert.deepEqual(missing.coveredBy.range, [90, 100], '缺失通知必须说明依据范围');
  });
});

test('另一轮的完整页不能为这一轮补范围，但保留它曾确认过成员的证据', async () => {
  const scenario = {
    name: 'other-round',
    routes: [
      { path: '/census', body: { round: 'r4', pages: ['/old'] } },
      {
        path: '/old',
        body: { round: 'r1', range: [0, 100], complete: true, members: [member('a', 10, 'a', 'x')] },
      },
    ],
  };
  await withSource(scenario, async ({ source, stateDir }) => {
    const result = await run({
      source: source.url, stateDir,
      input: { prior: [member('a', 10, 'a', 'x'), member('b', 60, 'b', 'y')] },
    });
    assert.equal(result.states.a, 'unchecked', '另一轮看到过不等于本轮清点过');
    assert.equal(result.states.b, 'unchecked');
    assert.deepEqual(result.coverage, []);
    assert.equal(result.pages[0].inTargetRound, false);
    assert.ok(result.pending.otherRound.length === 1);
    const a = result.members.find(item => item.id === 'a');
    assert.deepEqual(a.rounds, ['r1'], '在哪一轮看到的事实必须保留');
    const unchecked = result.notifications.find(item => item.id === 'a' && item.state === 'unchecked');
    assert.deepEqual(unchecked.observedInOtherRounds, ['r1']);
  });
});

test('改名保持成员身份，改名与内容变化同时发生只发一条通知', async () => {
  const scenario = {
    name: 'rename-and-change',
    routes: [
      { path: '/census', body: { round: 'r8', pages: ['/p'] } },
      {
        path: '/p',
        body: {
          round: 'r8', range: [0, 100], complete: true,
          members: [member('a', 10, 'new-name', 'new-digest'), member('b', 20, 'b', 'same-digest')],
        },
      },
    ],
  };
  await withSource(scenario, async ({ source, stateDir }) => {
    const result = await run({
      source: source.url, stateDir,
      input: { prior: [member('a', 10, 'old-name', 'old-digest'), member('b', 20, 'b', 'same-digest')] },
    });
    assert.equal(result.states.a, 'renamed');
    assert.equal(result.states.b, 'present');
    const forA = result.notifications.filter(item => item.id === 'a');
    assert.equal(forA.length, 1, '同一成员一次只产生一条通知');
    assert.equal(forA[0].state, 'renamed');
    assert.deepEqual(forA[0].from, { name: 'old-name', key: 10 });
    assert.deepEqual(forA[0].to, { name: 'new-name', key: 10 });
    assert.equal(forA[0].contentChange.to.digest, 'new-digest');
    assert.equal(result.memberCount, 2);
    assert.equal(result.contentCount, 2);
  });
});

test('重启续接：同轮次的离线页复用已核实副本，其他轮次不复用', async () => {
  const prior = [member('a', 10, 'a', 'x'), member('b', 60, 'b', 'y')];
  const stateDir = await mkdtemp(path.join(tmpdir(), 'census-restart-'));
  const first = await startSource({
    name: 'first',
    routes: [
      { path: '/census', body: { round: 'r6', pages: ['/one', '/two'] } },
      { path: '/one', body: { round: 'r6', range: [0, 50], complete: true, members: [member('a', 10, 'a', 'x')] } },
      { path: '/two', body: { round: 'r6', range: [50, 100], complete: true, members: [] } },
    ],
  });
  try {
    const firstRun = await run({ source: first.url, stateDir, input: { prior } });
    assert.equal(firstRun.states.b, 'missing');
  } finally { await first.close(); }

  // Second run: the census index still names the same round but both
  // stations are offline now.
  const second = await startSource({
    name: 'second',
    routes: [
      { path: '/census', body: { round: 'r6', pages: ['/one', '/two'] } },
      { path: '/one', status: 503, body: 'offline' },
      { path: '/two', status: 503, body: 'offline' },
    ],
  });
  try {
    const secondRun = await run({ source: second.url, stateDir, input: { prior } });
    assert.equal(secondRun.states.a, 'present');
    assert.equal(secondRun.states.b, 'missing', '同轮次已核实副本可以续接');
    assert.equal(secondRun.pages.filter(page => page.origin === 'reused').length, 2);
    assert.equal(secondRun.notifications.length, 0, '同一事实不重复通知');
    assert.equal(secondRun.summary.partial, true, '本轮未能访问站点仍须明确');
    assert.equal(secondRun.pending.offline.length, 2);
  } finally { await second.close(); }

  // Third run: a different round reuses nothing, even though copies exist.
  const third = await startSource({
    name: 'third',
    routes: [
      { path: '/census', body: { round: 'r7', pages: ['/one', '/two'] } },
      { path: '/one', status: 503, body: 'offline' },
      { path: '/two', status: 503, body: 'offline' },
    ],
  });
  try {
    const thirdRun = await run({ source: third.url, stateDir, input: { prior } });
    assert.equal(thirdRun.states.a, 'unchecked');
    assert.equal(thirdRun.states.b, 'unchecked');
    assert.equal(thirdRun.pages.filter(page => page.origin === 'reused').length, 0, '另一轮副本不得补足本轮');
  } finally { await third.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('索引本轮少列页：同轮次已核实副本继续有效，且明确标为未再提供', async () => {
  const prior = [member('a', 10, 'a', 'x'), member('b', 60, 'b', 'y')];
  const stateDir = await mkdtemp(path.join(tmpdir(), 'census-shrink-'));
  const first = await startSource({
    name: 'full-index',
    routes: [
      { path: '/census', body: { round: 'r2', pages: ['/one', '/two'] } },
      { path: '/one', body: { round: 'r2', range: [0, 50], complete: true, members: [member('a', 10, 'a', 'x')] } },
      { path: '/two', body: { round: 'r2', range: [50, 100], complete: true, members: [member('b', 60, 'b', 'y')] } },
    ],
  });
  try {
    const firstRun = await run({ source: first.url, stateDir, input: { prior } });
    assert.equal(firstRun.states.b, 'present');
  } finally { await first.close(); }

  const second = await startSource({
    name: 'partial-index',
    routes: [
      { path: '/census', body: { round: 'r2', pages: ['/one'] } },
      { path: '/one', body: { round: 'r2', range: [0, 50], complete: true, members: [member('a', 10, 'a', 'x')] } },
    ],
  });
  try {
    const secondRun = await run({ source: second.url, stateDir, input: { prior } });
    assert.equal(secondRun.states.b, 'present', '同轮次副本仍然说明 b 存在');
    const two = secondRun.pages.find(page => page.page.endsWith('/two'));
    assert.ok(two, '不再列出的页仍须出现在证据里');
    assert.equal(two.droppedFromIndex, true);
    assert.equal(two.origin, 'reused');
    assert.ok(secondRun.pending.offline.some(item => item.servedFromEarlierAttempt === 1));
    assert.equal(secondRun.notifications.length, 0);
  } finally { await second.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('状态文件丢失时从原始页副本恢复，不忘记已核实范围', async () => {
  const prior = [member('a', 10, 'a', 'x'), member('b', 60, 'b', 'y')];
  const scenario = {
    name: 'recovery',
    routes: [
      { path: '/census', body: { round: 'r2', pages: ['/p'] } },
      { path: '/p', body: { round: 'r2', range: [0, 100], complete: true, members: [member('a', 10, 'a', 'x')] } },
    ],
  };
  await withSource(scenario, async ({ source, stateDir }) => {
    const first = await run({ source: source.url, stateDir, input: { prior } });
    assert.equal(first.states.b, 'missing');
    await writeFile(path.join(stateDir, 'state.json'), '{ 损坏的 JSON', 'utf8');
    const second = await run({ source: source.url, stateDir, input: { prior } });
    assert.equal(second.recoveredState, true);
    assert.ok(second.pages.every(page => page.origin === 'current'));
    assert.equal(second.states.b, 'missing');
    assert.ok(second.pages[0].rawFile.startsWith('pages/attempt-'));
  });
});

test('新发现的成员进入历史基线，下一轮完整清点后可确认缺失', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'census-later-'));
  const first = await startSource({
    name: 'discover',
    routes: [
      { path: '/census', body: { round: 'r1', pages: ['/p'] } },
      { path: '/p', body: { round: 'r1', range: [0, 100], complete: true, members: [member('new', 5, 'n', 'd')] } },
    ],
  });
  try {
    const firstRun = await run({ source: first.url, stateDir, input: { prior: [] } });
    assert.equal(firstRun.states.new, 'present');
  } finally { await first.close(); }

  const second = await startSource({
    name: 'gone',
    routes: [
      { path: '/census', body: { round: 'r2', pages: ['/p'] } },
      { path: '/p', body: { round: 'r2', range: [0, 100], complete: true, members: [] } },
    ],
  });
  try {
    const secondRun = await run({ source: second.url, stateDir, input: { prior: [] } });
    assert.equal(secondRun.states.new, 'missing', '上一轮确认过的成员不能当成从未见过');
    assert.equal(secondRun.notifications.filter(item => item.id === 'new').length, 1);
  } finally {
    const thirdRun = await run({ source: second.url, stateDir, input: { prior: [] } });
    assert.equal(thirdRun.states.new, 'missing');
    assert.equal(thirdRun.notifications.length, 0, '同一状态不重复通知');
    await second.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('输出与落盘一致，且包含证据字段', async () => {
  const scenario = {
    name: 'persisted',
    routes: [
      { path: '/census', body: { round: 'r2', pages: ['/p'] } },
      { path: '/p', body: { round: 'r2', range: [0, 100], complete: true, members: [member('a', 10, 'a', 'x')] } },
    ],
  };
  await withSource(scenario, async ({ source, stateDir }) => {
    const result = await run({ source: source.url, stateDir, input: { prior: [member('a', 10, 'a', 'x')] } });
    const saved = JSON.parse(await readFile(path.join(stateDir, 'result.json'), 'utf8'));
    assert.deepEqual(saved.states, result.states);
    assert.deepEqual(saved.publications, result.publications);
    assert.ok(result.publications.every(item => item.verifiedAt && item.attempt === 1));
    assert.ok(result.index.url.endsWith('/census'));
  });
});
