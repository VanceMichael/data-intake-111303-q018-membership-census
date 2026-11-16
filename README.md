# 断续在线资料源的成员清点与缺失确认

这是 membership-census 的 Node.js 项目。能力覆盖本地资料源启动、来源检查、成员清点采集与接口演练。清点工作流位于 `src/workflow.mjs`，辅助模块在 `src/census/`。

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

`npm test` 检查来源契约与清点工作流（含重叠范围、重启续接、分范围发布等用例）。`npm run build` 做全部 JavaScript 源码语法检查，不生成运行时依赖。`npm run source` 启动回环服务并打印地址，`SOURCE_CASE=1 npm run source` 可切换异常场景。

## 工作流接入

业务入口为 `src/workflow.mjs` 导出的异步 `run({ source, stateDir, input })`。source 是本地资料源地址，input.prior 是历史成员（id/key/name/digest），stateDir 是跨次执行保留的状态目录。调用结束返回结构化业务结果，并将相同结果持久化至 stateDir/result.json，其他持久状态布局由业务模块决定。重启续接只复用已落盘且可追溯的页面证据，不依赖调用方持有的内存。

GET /census 返回 round/pages，各页含 round/range/complete/members。key 使用半开区间；只有本轮明确 complete 的页能支持缺失结论，部分页、离线页和另一轮的页只能得到 unchecked。输出 states[id]=present/renamed/content-changed/missing/unchecked、memberCount、contentCount；两种变化同时发生时另留 changes 数组。成员身份（按 id）与内容摘要（按 digest）分表存储，重叠范围不复制内容但保留每次观察；每页抓完即产生一次分范围发布（publications/），通知理由区分存在、改名、内容变化、明确缺失与尚未清点。

完整来源约定、输出示例与状态判定见 `docs/source-contract.md`，状态目录布局与分范围发布语义同样记录在该文档。fixtures 下的资料只用于本地演练，代表不同供方响应或门户状态，不是资料接收器的实现。

## 业务核对与短演示

```sh
npm run acceptance
npm run demo
```

`npm run acceptance` 核对 fixtures 三个约定用例的结果、落盘内容和实际来源访问；`npm test` 中的 `test/workflow.test.mjs` 另覆盖重叠范围去重、离线页重启续接、跨轮隔离、改名/内容变化、分范围发布与新成员计数。demo 从干净临时状态启动本地服务，实际执行前三种情况并完整输出结果及请求，不回放记录。每种情形应在 15 秒内完成，整次演示在 75 秒超时后报失败退出，预留在 90 秒内展示的余量。

容器内执行基线检查：`docker run --rm --network none membership-census:local npm test`。工作流开发完成后执行 `docker run --rm --network none membership-census:local npm run demo`。容器内回环端口可用；正式核对过程不连接外部网络。
