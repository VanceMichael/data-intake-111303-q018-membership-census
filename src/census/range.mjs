// 键范围工具：来源约定使用半开区间 [lo, hi)，key >= lo 且 key < hi 视为落在范围内。

export function isValidRange(range) {
  return Array.isArray(range) && range.length === 2
    && Number.isFinite(range[0]) && Number.isFinite(range[1])
    && range[0] < range[1];
}

export function rangeContains(range, key) {
  return key >= range[0] && key < range[1];
}

export function rangesCover(ranges, key) {
  return ranges.some(range => rangeContains(range, key));
}

// 覆盖某 key 的全部页面证据，用于说明 unchecked 的原因（部分页/离线页/另一轮页）。
export function pagesCovering(pageRecords, key) {
  return pageRecords.filter(record => record.range && rangeContains(record.range, key));
}

export function samePageList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
