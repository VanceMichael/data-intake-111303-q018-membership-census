# 断续在线资料源的成员清点与缺失确认

这是 membership-census 的 Node.js 项目。本地资料源启动、来源检查、接口演练与成员清点工作流都在本项目内；清点工作流入口为 `src/workflow.mjs`。

## 环境

使用 Node.js 22，最低 22.20.0；Docker 基础镜像按摘要固定，依赖已在 package-lock.json 固定。资料源仅使用本地接口或本地合成设备进程。不需要真实账户、新闻站点连接或生产数据。

开发环境首次安装执行 `npm ci --ignore-scripts --no-audit --no-fund`。构建镜像执行 `docker build -t membership-census:local .`，依赖准备只在这一步进行；正式运行不下载包、浏览器或数据。

## 常用操作

```sh
npm test
npm run build
npm run inspect
npm run source
```

`npm test` 检查资料源与接口读取。`npm run acceptance` 与 `npm run workflow-test` 检查清点工作流；`npm run build` 做全部 JavaScript 源码语法检查，不生成运行时依赖。`npm run source` 启动回环服务并打印地址，`SOURCE_CASE=1 npm run source` 可切换异常场景。

## 工作流接入

业务入口约定为 `src/workflow.mjs` 导出的异步 `run({ source, stateDir, input })`。source 是本地资料源地址，input 是业务输入（`prior` 历史成员，可选 `timeoutMs`），stateDir 是跨次执行保留的状态目录。调用结束返回结构化业务结果，并将相同结果持久化至 stateDir/result.json。不能依赖调用方持有的内存来完成恢复。

GET /census 返回 round/pages，各页含 round/range/complete/members。key 使用半开区间；只有**同一清点轮次**中声明 `complete` 且页内列出 `members` 的页，才能合并范围并支持缺失结论。部分页、离线页、无法解析的页与另一轮的页都不参与缺失判断。`input.prior` 为历史成员。输出 `states[id]` 为 `present`/`renamed`/`content-changed`/`missing`/`unchecked`，另含 `memberCount`（成员数）与 `contentCount`（去重后的内容摘要数）。

除业务状态外，结果还给出证据与发布字段：

- `pages`：每页声明的轮次、范围、完整性、来源（本轮读取或复用同轮次已核实副本）与原始副本路径。
- `publications`：按范围发布，页一读到就交付，不等其他站；`absenceChecked` 标出可解释缺失的页。
- `pending`：离线、部分、另一轮与无法解析的页，说明哪些范围尚未清点。
- `members[].confirmedIn`：成员在哪些轮次、哪些范围、哪一页被确认；重叠范围不会丢掉确认记录。
- `contents`：按摘要去重，`memberIds` 列出共享同一内容的成员；成员身份与内容存储分开。
- `changes` 与 `notifications`：存在、改名、内容变化、明确缺失、尚未清点。通知按成员当前事实去重，重启不会重复刷同一条。

完整来源约定、输出示例与状态判定见 `docs/source-contract.md`。fixtures 下的资料只用于本地演练，代表不同供方响应或门户状态，不是资料接收器的实现。

## 业务核对与短演示

```sh
npm run acceptance
npm run workflow-test
npm run demo
```

acceptance 检查验收用例的结果、落盘内容和实际来源访问；workflow-test 覆盖重叠范围、部分/离线页、跨轮次、改名与内容变化、重启续接和状态恢复；demo 从干净临时状态启动本地服务，实际执行前三种情况并完整输出结果及请求，不回放记录。每种情形应在 15 秒内完成，整次演示在 75 秒超时后报失败退出，预留在 90 秒内展示的余量。

容器内执行基线检查：`docker run --rm --network none membership-census:local npm test`。完整清点流程执行 `docker run --rm --network none membership-census:local npm run demo`。容器内回环端口可用；正式核对过程不连接外部网络。
