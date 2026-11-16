// 持久化状态库：所有进度只通过原子写盘保留，重启后仅凭磁盘证据续接，不依赖调用方内存。
//
// 目录布局：
//   stateDir/
//     members.json   成员身份表（按供方 id 索引，成员与内容摘要分开保存）
//     contents.json  内容摘要表（按 digest 去重，重叠范围不会复制两份内容）
//     runs/<runId>/run.json            一轮清点的声明、页面清单与每页落盘状态
//     runs/<runId>/pages/<encoded>.json 页面原始证据与解析结果（含另一轮/部分页）
//     runs/<runId>/publications/<n>.json 分范围发布（每页一次 + 最终汇总）
//     runs/<runId>/result.json         本轮结构化结果
//     result.json                      最近一次业务结果（工作流入口约定）
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';

export async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, target);
}

async function readJsonMap(file, fallback) {
  try {
    const raw = await readFile(file, 'utf8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map(fallback);
    throw error;
  }
}

export class CensusStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.memberFile = path.join(stateDir, 'members.json');
    this.contentFile = path.join(stateDir, 'contents.json');
    this.runsDir = path.join(stateDir, 'runs');
    this.members = new Map();
    this.contents = new Map();
  }

  async load() {
    await mkdir(this.stateDir, { recursive: true });
    this.members = await readJsonMap(this.memberFile, []);
    this.contents = await readJsonMap(this.contentFile, []);
    return this;
  }

  runDir(runId) { return path.join(this.runsDir, runId); }
  runFile(runId) { return path.join(this.runDir(runId), 'run.json'); }
  pageFile(runId, pageRef) {
    const encoded = encodePageRef(pageRef);
    return { file: path.join(this.runDir(runId), 'pages', encoded + '.json'), encoded };
  }
  publicationFile(runId, seq) {
    return path.join(this.runDir(runId), 'publications', String(seq).padStart(3, '0') + '.json');
  }

  async listRuns() {
    try {
      const names = await readdir(this.runsDir);
      const runs = [];
      for (const name of names) {
        try {
          runs.push(JSON.parse(await readFile(this.runFile(name), 'utf8')));
        } catch { /* 损坏的半成品 run 不参与续接选择 */ }
      }
      return runs;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async readRun(runId) {
    return JSON.parse(await readFile(this.runFile(runId), 'utf8'));
  }

  async saveRun(run) { await writeJsonAtomic(this.runFile(run.runId), run); }

  async savePage(runId, record) {
    const { file } = this.pageFile(runId, record.ref);
    await writeJsonAtomic(file, record);
  }

  async savePublication(runId, seq, publication) {
    await writeJsonAtomic(this.publicationFile(runId, seq), publication);
  }

  async saveResult(runId, result) {
    await writeJsonAtomic(path.join(this.runDir(runId), 'result.json'), result);
    await writeJsonAtomic(path.join(this.stateDir, 'result.json'), result);
  }

  // ---- 成员身份与内容摘要分开维护 ------------------------------------

  // 登记一次“在某轮某页确认存在”的观察；同一成员在重叠范围出现不复制内容，
  // 但每一次观察（轮次+页面）都保留，存在事实不会因为去重而丢失。
  observeMember(member, round, pageRef) {
    const observation = { round, page: pageRef, key: member.key, name: member.name, digest: member.digest };
    let record = this.members.get(member.id);
    if (!record) {
      record = {
        id: member.id,
        current: { key: member.key, name: member.name, digest: member.digest },
        observations: [],
      };
      this.members.set(member.id, record);
    } else {
      record.current = { key: member.key, name: member.name, digest: member.digest };
    }
    const duplicated = record.observations.some(item =>
      item.round === round && item.page === pageRef
      && item.key === member.key && item.name === member.name && item.digest === member.digest);
    if (!duplicated) record.observations.push(observation);
    this.touchContent(member.digest, round, pageRef, member.id);
    return record;
  }

  touchContent(digest, round, pageRef, memberId) {
    let content = this.contents.get(digest);
    if (!content) {
      content = { digest, members: [], seen: [] };
      this.contents.set(digest, content);
    }
    if (!content.members.includes(memberId)) content.members.push(memberId);
    const seen = content.seen.some(item => item.round === round && item.page === pageRef);
    if (!seen) content.seen.push({ round, page: pageRef });
  }

  getMember(id) { return this.members.get(id); }

  async persistIndexes() {
    await writeJsonAtomic(this.memberFile, Object.fromEntries(this.members));
    await writeJsonAtomic(this.contentFile, Object.fromEntries(this.contents));
  }
}

// 页面引用是相对路径（如 /p1），落盘时转成安全文件名但保留可追溯的原始 ref。
export function encodePageRef(ref) {
  return ref.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

export function newRunId() {
  return 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
}
