# 来源与接收约定

GET /census 返回 round/pages，各页含 round/range/complete/members。key 使用半开区间；只有本轮明确 complete 的页能支持缺失结论。input.prior 为历史成员。输出 states[id]=present/renamed/content-changed/missing/unchecked、memberCount、contentCount；两种变化同时发生时另留 changes 数组。

## 判定规则

- **范围**：`range: [start, end]` 为半开区间。页可以只声明自己实际检查过的范围，不同页的范围可以重叠，也可以相邻拼成连续覆盖。合并范围只用于回答"这里是否完整清点过"，不代表供方交出了全目录。
- **轮次**：页自己的 `round` 才有效。索引声明的轮次只说明这次执行期望清点哪一轮；页缺 `round` 时不会被自动补成索引轮次，也不会参与缺失判断。另一轮（`r1` 对 `r4`）的完整页不能为这一轮补范围，但它确认过成员存在的事实必须保留。
- **完整性**：`complete: true` 且页内确实给出 `members` 数组的页，才贡献覆盖范围。`complete: false`、HTTP 失败、超时、无法解析、页内声明 `offline: true` 的页都不贡献；读取失败一律不算"目录为空"。
- **缺失**：仅当历史成员 `id` 存在、其 `key` 落在**目标轮次完整覆盖范围**内、且目标轮次没有任何页列出它时，才判定 `missing`。通知必须附上依据的轮次、范围与页。
- **存在 / 改名 / 内容变化**：以目标轮次的可读页为准。供方 `id` 是成员身份；`id` 不变而 `name` 变是 `renamed`，`digest` 变是 `content-changed`，两者同时发生仍是一条通知（`contentChange` 字段保留内容变化）。`digest` 相同只说明内容相同，不能合并两个不同 `id`。
- **尚未清点**：没有目标轮次证据，且同一轮次的完整范围也没有覆盖到它。只在别的轮次出现过时，`unchecked` 同时保留 `observedInOtherRounds`。
- **内容与成员分开**：`contents` 按 `digest` 只存一份，`memberIds` 列出共享该内容的成员；`members[].confirmedIn` 与 `contents[].confirmations` 保留每次确认的轮次、范围、页与尝试序号。重叠范围看到同一成员会得到多条确认，而不是重复内容或丢掉某轮事实。

## 分范围发布与续接

- `publications` 逐页交付：某站可读就立即发布它声明的范围与成员，不等待其他站上线。`absenceChecked` 标出可以解释缺失的页。
- `pending` 列出离线、部分、另一轮和无法解析的页，明确哪些范围尚未清点；`summary.partial` 为真时不能把本次结果当成目录完整。
- 每次执行先写 `stateDir/pages/attempt-N/<page>.json` 原始副本，再写 `stateDir/state.json` 解释结果，最后写 `stateDir/result.json`。重启时只复用同一轮次、已落盘且可追溯到原件的副本（标记 `origin: "reused"`、`evidenceAttempt`），并保留本轮失败信息；跨轮次副本绝不复用。状态文件损坏时从原始副本恢复可解析的页。
- 通知按成员当前事实去重：同一事实不因重启重复，成员在明确缺失后又出现时会再次通知。

## 边界与操作

来源地址由启动函数动态分配，不固定端口。所有时间值只按各自字段的业务含义使用；不以请求抵达顺序推导资料版本。可见结果应附真实原始响应、页面或运行证据，不能仅根据调用参数生成结果。

来源演练用例位于 fixtures/cases.json，name 为当前情形名称，routes 为实际供方响应。工作流只通过 source 暴露的接口或页面访问来源；不得导入模拟源内部状态、读取它的文件来代替真实采集。浏览器门户内部动作接口只服务页面，不是机器人可直接调用的业务 API。

读取失败不等于不存在；部分资料可以保留，但需要完整性承诺的结果不能伪称完成。重启时只能复用已落盘且能追溯依据的进度。输出可扩展更多证据字段，但不能省略下列业务状态。

## 业务输入与结果

### 完整范围才确认缺失

业务输入：
```json
{
  "prior": [
    {
      "id": "a",
      "key": 10,
      "name": "old",
      "digest": "same"
    },
    {
      "id": "b",
      "key": 60,
      "name": "b",
      "digest": "same"
    }
  ]
}
```
结果必须包含：
```json
{
  "states": {
    "a": "missing",
    "b": "unchecked"
  }
}
```

### 同摘要不同成员不合并

业务输入：
```json
{
  "prior": [
    {
      "id": "a",
      "key": 10,
      "name": "old",
      "digest": "same"
    },
    {
      "id": "b",
      "key": 60,
      "name": "b",
      "digest": "same"
    }
  ]
}
```
结果必须包含：
```json
{
  "states": {
    "a": "renamed",
    "b": "present"
  },
  "memberCount": 2,
  "contentCount": 1
}
```

### 另一轮不能补足清点范围

业务输入：
```json
{
  "prior": [
    {
      "id": "a",
      "key": 10,
      "name": "old",
      "digest": "same"
    },
    {
      "id": "b",
      "key": 60,
      "name": "b",
      "digest": "same"
    }
  ]
}
```
结果必须包含：
```json
{
  "states": {
    "a": "unchecked",
    "b": "unchecked"
  }
}
```
