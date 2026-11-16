# 来源与接收约定

GET /census 返回 round/pages，各页含 round/range/complete/members。key 使用半开区间；只有本轮明确 complete 的页能支持缺失结论。input.prior 为历史成员。输出 states[id]=present/renamed/content-changed/missing/unchecked、memberCount、contentCount；两种变化同时发生时另留 changes 数组。

## 边界与操作

来源地址由启动函数动态分配，不固定端口。所有时间值只按各自字段的业务含义使用；不以请求抵达顺序推导资料版本。可见结果应附真实原始响应、页面或运行证据，不能仅根据调用参数生成结果。

来源演练用例位于 fixtures/cases.json，name 为当前情形名称，routes 为实际供方响应。工作流只通过 source 暴露的接口或页面访问来源；不得导入模拟源内部状态、读取它的文件来代替真实采集。浏览器门户内部动作接口只服务页面，不是机器人可直接调用的业务 API。

读取失败不等于不存在；部分资料可以保留，但需要完整性承诺的结果不能伪称完成。重启时只能复用已落盘且能追溯依据的进度。输出可扩展更多证据字段，但不能省略下列业务状态。

## 清点页语义

每页是供方对“自己实际检查过的键范围”的签收证据，字段如下：

- `round`：该页所属清点轮次。只有与 `/census` 清单同轮的页能参与本轮结论；另一轮的页只作为历史观察证据保存。
- `range`：半开区间 `[lo, hi)`，成员按 `key` 归属范围。不同页的范围允许重叠。
- `complete`：供方对该范围完整性的承诺。`true` 表示该范围内成员已全部列尽；`false` 是部分页，只能证明列出的成员存在，不能证明未列出的成员缺失。
- `members`：该页实际清点到的成员，每项含 `id/key/name/digest`。

## 状态判定纪律

### 完整范围才确认缺失

业务输入：
```json
{
  "prior": [
    { "id": "a", "key": 10, "name": "old", "digest": "same" },
    { "id": "b", "key": 60, "name": "b", "digest": "same" }
  ]
}
```
结果必须包含：
```json
{ "states": { "a": "missing", "b": "unchecked" } }
```

`missing` 的唯一来源：某历史成员的 key 被**同一轮次**且 `complete=true` 的页面范围覆盖、但该成员没有在本轮任何页面出现。部分页（complete=false）、离线/失败页、另一轮的页都不能与其他页拼出缺失结论，这些成员保持 `unchecked`，并在 `evidence.reasons` 中给出 `partial-page` / `page-offline` / `different-round` / `out-of-any-fetched-range` 的具体原因。

### 同摘要不同成员不合并

业务输入同上，结果必须包含：
```json
{ "states": { "a": "renamed", "b": "present" }, "memberCount": 2, "contentCount": 1 }
```

成员身份按供方 `id` 对齐：`id` 不变而 `name` 变化是 `renamed`，仍是同一成员；两个不同成员即使 `digest` 相同也各自独立计数，绝不按摘要合并。`digest` 变化给出 `content-changed`；改名与内容变化同时发生时状态取 `content-changed`，两项布尔标记完整记录在 `changes` 数组中。历史中不存在、本轮新观察到的成员标记为 `present`，通知里 `isNewMember=true`。

### 另一轮不能补足清点范围

业务输入同上，结果必须包含：
```json
{ "states": { "a": "unchecked", "b": "unchecked" } }
```

另一轮页面观察到的成员仍会写入成员表（保留“在哪轮被确认存在”的事实），但不参与本轮存在/缺失判定，通知理由为 `not-yet-censused`。

## 成员与内容分开存储

状态目录 `stateDir` 布局：

```
members.json                 成员身份表，按 id 索引；observations 保留每次 (round, page) 确认
contents.json                内容摘要表，按 digest 去重；seen 记录出现位置，members 记录引用成员
runs/<runId>/run.json        本轮清单、页面抓取状态、发布计数（重启续接依据）
runs/<runId>/pages/*.json    每页原始响应与解析结果，失败页也落盘并附 error
runs/<runId>/publications/   分范围发布，每页一份 page-publication，最后一份 run-summary
runs/<runId>/result.json     本轮结构化结果
result.json                  最近一次业务结果（工作流入口约定）
```

同一成员出现在两个重叠范围时，内容摘要只存一份（`contentCount` 按 digest 计），但两条观察分别保留；同一 digest 被多个成员引用时 `contents[digest].members` 列出全部成员 id。

## 分范围发布与重启续接

- 每抓完一页立即产出一次 `page-publication`：`scope` 说明页面轮次/范围/完整性，`notifications` 交付该范围已可定论的变化（同一成员同一状态在一轮内不重复通知），`pending` 列出本范围内仍 `unchecked` 的历史成员及原因。无需等待所有站点上线即可交付已核实的变化。
- 页面读取失败（超时、5xx/429、结构损坏）重试一次后仍失败的，落盘为失败证据并在 `failedPages` 中报告；run 标记为 `partial`，已核实的结果照常交付。失败从不被解释为删除。
- 重启时按 `round + 同一组 pages + 未完成` 匹配可续接的 run：状态为 `ok` 的页直接复用磁盘证据、不再请求来源；失败页和未抓页重新抓取。轮次变化或页面清单变化会开启新 run，旧证据保留可追溯。
- 通知理由 `reason` 与状态对应：`present`（存在）、`renamed`（改名）、`content-changed`（内容变化）、`confirmed-missing`（明确缺失）、`not-yet-censused`（尚未清点）。
