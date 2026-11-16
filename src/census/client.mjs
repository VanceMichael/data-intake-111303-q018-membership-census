// 来源读取：只通过 source 暴露的 HTTP 接口访问清点清单与页面，不读取模拟源内部文件。
// 读取失败（网络错误、超时、5xx/429）重试一次；失败作为证据保留，绝不解释成“文件下架”。

const FETCH_TIMEOUT_MS = 5000;

async function fetchJson(source, ref, attempts = 2) {
  const url = new URL(ref, source).href;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error('来源返回状态 ' + response.status);
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        return { ok: false, status: response.status, error: '来源返回状态 ' + response.status, body: text };
      }
      try {
        return { ok: true, status: response.status, body: JSON.parse(text), raw: text };
      } catch (error) {
        return { ok: false, status: response.status, error: '响应不是有效 JSON：' + error.message, body: text };
      }
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, error: lastError?.message ?? '读取失败' };
}

function validateCensus(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('清点清单不是对象');
  if (typeof payload.round !== 'string' || payload.round.length === 0) throw new Error('清点清单缺少 round');
  if (!Array.isArray(payload.pages) || payload.pages.some(page => typeof page !== 'string')) {
    throw new Error('清点清单 pages 必须是相对路径数组');
  }
}

function validatePage(payload) {
  const warnings = [];
  if (!payload || typeof payload !== 'object') throw new Error('清点页不是对象');
  if (typeof payload.round !== 'string' || payload.round.length === 0) {
    throw new Error('清点页缺少 round');
  }
  if (!Array.isArray(payload.range) || payload.range.length !== 2 || payload.range[0] >= payload.range[1]) {
    throw new Error('清点页 range 必须是半开区间 [lo, hi) 且 lo < hi');
  }
  if (typeof payload.complete !== 'boolean') throw new Error('清点页 complete 必须是布尔值');
  const members = [];
  for (const [index, member] of Array.isArray(payload.members) ? payload.members.entries() : []) {
    if (!member || typeof member.id !== 'string' || !Number.isFinite(member.key)
      || typeof member.name !== 'string' || typeof member.digest !== 'string') {
      warnings.push('成员 #' + index + ' 字段不完整，已跳过');
      continue;
    }
    members.push({ id: member.id, key: member.key, name: member.name, digest: member.digest });
  }
  return { members, warnings };
}

export async function fetchCensus(source) {
  const result = await fetchJson(source, '/census');
  if (!result.ok) throw new Error('无法读取清点清单：' + (result.error ?? result.status));
  validateCensus(result.body);
  return { round: result.body.round, pages: result.body.pages, raw: result.raw, status: result.status };
}

export async function fetchPage(source, ref) {
  const result = await fetchJson(source, ref);
  if (!result.ok) {
    return { ref, status: 'failed', error: result.error ?? ('HTTP ' + result.status), fetchedAt: new Date().toISOString() };
  }
  try {
    const { members, warnings } = validatePage(result.body);
    return {
      ref,
      status: 'ok',
      httpStatus: result.status,
      round: result.body.round,
      range: [result.body.range[0], result.body.range[1]],
      complete: result.body.complete,
      members,
      warnings,
      raw: result.raw,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    // 页面结构损坏按离线处理：保留证据，但不允许它支持任何结论。
    return { ref, status: 'failed', error: error.message, raw: result.body, fetchedAt: new Date().toISOString() };
  }
}
