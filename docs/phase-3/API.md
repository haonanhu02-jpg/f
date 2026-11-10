# 第三阶段实际API契约

基础路径：`/api`。成功响应`{ "data": ... }`；失败响应`{ "error": { "code": "...", "message": "...", "details": [] } }`，字段问题按需带`details`。

本文件描述当前实现，替代第二阶段尚未落实的接口建议。公司、部门和分类维护使用一个带版本号的事务接口，以保持目录及引用一致。

## 接口目录

| 方法 | 地址 | 输入/输出 |
| --- | --- | --- |
| GET | /health | 服务状态、数据库类型、结构版本 |
| GET | /bootstrap | 公司、部门、分类树、基础资料revision、已确认编号说明；不加载全库档案 |
| GET | /companies | 公司列表 |
| GET | /departments?companyId= | 公司部门列表，companyId可选 |
| GET | /categories | 分类树；公司是否适用目录由公司categoryEnabled控制 |
| PUT | /master-data | revision、companies、departments、categories；原子校验并保存基础资料 |
| GET | /archives | 服务端筛选及分页；返回records、total、page、pageSize、stats |
| GET | /archives/:id | 完整记录、正式档号、生命周期及登记快照 |
| POST | /archive-drafts | 新建草稿；客户端稳定ID用于避免网络重试重复创建 |
| PATCH | /archives/:id | 保存完整可编辑字段，提交当前recordVersion |
| POST | /archive-drafts/:id/register | `{ "recordVersion": 1 }`，原子分配正式档号 |
| POST | /archives/:id/void | `{ "recordVersion": 2, "reason": "误录" }` |
| POST | /migrations/phase2 | 显式迁移第二阶段公司/部门/分类/草稿；排除演示并检查冲突 |

`PATCH /archive-drafts/:id`也接受同样的更新协议，正式档案建议使用`/archives/:id`。

## 查询参数

| 参数 | 含义 |
| --- | --- |
| company | 公司ID |
| group | document或qualification |
| category | 任意层级分类ID，包含该节点下的记录 |
| department | 移交部门ID |
| validity | fixed、permanent、na、unknown |
| status | draft、registered、void |
| keyword | 档案名称、档号、证书编号、公司名称检索；最长200字符 |
| page | 正整数，从1开始 |
| pageSize | 每页1—100条，默认10 |

分页结果中的stats为全库各登记状态数量，不受当前筛选影响。页面列表及total为当前筛选结果。

## 草稿和修改字段

完整字段来自第一阶段字段字典，使用前端一致的camelCase命名：

```json
{
  "id": "客户端生成的UUID",
  "companyId": "company-4",
  "group": "document",
  "categoryIds": ["cat-01", "cat-01-01"],
  "title": "建设工程规划许可证",
  "certificateNumber": "00123",
  "issuingAuthority": "",
  "issuedOn": "",
  "originalCount": 1,
  "copyCount": 0,
  "scanCount": null,
  "validityMode": "na",
  "validFrom": "",
  "validUntil": "",
  "transferPerson": "",
  "departmentId": "",
  "confidentialityLevel": "",
  "retentionMode": "unknown",
  "retentionFrom": "",
  "retentionUntil": "",
  "storageLocation": "A柜 / 01层",
  "remarks": "",
  "numberingYear": "",
  "isExample": false,
  "recordVersion": 0
}
```

新建recordVersion为0，保存后返回1；修改提交上一次读取的版本。日期为空字符串或真实`YYYY-MM-DD`；数量为非负整数或null，null与0区别保留。年份类别numberingYear为四位归档年份，普通类别为空。当前秘密等级字典待补，只接受空值。

不能通过提交status、archiveNumber、登记时间等字段绕过正式登记流程。响应额外包含status、archiveNumber、recordVersion、createdAt、updatedAt、registeredAt、voidedAt、voidReason、registrationSnapshot、warnings。重复证书编号仅返回核查提醒，不直接拒绝不同版本。

## 错误与重试

- 400：JSON格式错误。
- 403：浏览器来源不在允许列表。
- 404：接口或档案不存在。
- 409：版本冲突、档号相关字段锁定、迁移冲突、数据库冲突。
- 413/415：内容过大或提交格式不是JSON。
- 422：字段、日期、分类、部门、公司编码或编号规则不满足要求。

`REVISION_CONFLICT`后应刷新再核对修改。正式登记请求可以重试，已登记记录返回同一档号；已经作废的记录不会重新登记。作废请求重复提交相同原因返回已有结果，不覆盖原原因。

这些约束由后端执行，前端校验只用于及时提示。当前服务仅在本机监听，角色权限按第五阶段实现。
