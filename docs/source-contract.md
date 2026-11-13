# 来源与接收约定

GET /census 返回 round/pages，各页含 round/range/complete/members。key 使用半开区间；只有本轮明确 complete 的页能支持缺失结论。input.prior 为历史成员。输出 states[id]=present/renamed/content-changed/missing/unchecked、memberCount、contentCount；两种变化同时发生时另留 changes 数组。

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
