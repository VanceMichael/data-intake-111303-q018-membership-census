import { safeSlug, validRange, asKey } from './util.mjs';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const asObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseRanges(value) {
  if (!Array.isArray(value)) return [];
  return value.map(validRange).filter(Boolean);
}

function normalizeMember(raw) {
  if (!asObject(raw) || raw.id === undefined || raw.id === null) return null;
  return {
    id: String(raw.id),
    key: asKey(raw.key),
    name: raw.name === undefined || raw.name === null ? null : String(raw.name),
    digest: raw.digest === undefined || raw.digest === null ? null : String(raw.digest),
  };
}

/**
 * A page from the supplier. `body` is the supplier's own JSON document. All
 * fields are kept as declared; in particular a page without `round` must not
 * be silently upgraded to the index round, because absence conclusions are
 * only valid within one explicitly named round.
 */
export function normalizePage(body) {
  if (!asObject(body)) throw new Error('清点页格式无效：不是对象');
  if (!Array.isArray(body.range) && !Array.isArray(body.ranges)) throw new Error('清点页缺少 range');
  if (body.members !== undefined && !Array.isArray(body.members)) throw new Error('清点页 members 不是数组');
  return {
    round: body.round ?? null,
    range: validRange(body.range ?? []),
    complete: body.complete === true,
    hasMembers: Array.isArray(body.members),
    members: (body.members ?? []).map(normalizeMember).filter(Boolean),
    // Pages may describe disjoint sub-ranges they actually checked.
    ranges: parseRanges(body.ranges ?? (body.range ? [body.range] : [])),
    offline: body.offline === true,
  };
}

export function pageFilename(target) {
  if (target === null || target === undefined) return 'page-unknown';
  let label;
  if (typeof target === 'object') {
    label = target.href ?? target.url ?? target.path ?? target.page ?? JSON.stringify(target);
  } else label = String(target);
  return 'page-' + safeSlug(label);
}

export async function saveRawPage(rawDir, target, body, meta = {}) {
  await mkdir(rawDir, { recursive: true });
  const filename = path.join(rawDir, pageFilename(target) + '.json');
  // Write through a temporary name so a crash can never leave a half-written
  // copy that a later run would treat as evidence.
  const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify({ target, ...meta, body }, null, 2) + '\n', 'utf8');
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return filename;
}

/**
 * Path of the copy relative to stateDir. Stored evidence is addressed by that
 * stable relative path, never by an absolute filesystem location.
 */
export function rawPageRelative(rawRelative, target) {
  return path.posix.join(rawRelative ?? '', pageFilename(target) + '.json');
}

export { normalizeMember };
