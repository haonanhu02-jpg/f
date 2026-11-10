# 第五阶段API：身份、权限、日志与分析

本阶段在[第三阶段API](../phase-3/API.md)、[第四阶段API](../phase-4/API.md)上增加身份与授权要求。除健康检查与认证入口外，原有业务接口现在也必须登录。默认本地地址 http://127.0.0.1:3001。

## 会话与通用约定

成功响应为 `{ "data": ... }`，失败为 `{ "error": { "code": "...", "message": "..." } }`。未登录/失效会话返回401，无操作权限返回403；不可读取的档案返回404，防止暴露其是否存在；并发版本冲突返回409。

登录和初始化通过 Set-Cookie 写入 archive_session，会话有效8小时，使用 HttpOnly、SameSite=Strict。会话原令牌仅在Cookie中传输，数据库存储其摘要；返回JSON中的 csrfToken 用于后续写请求的 X-CSRF-Token 头。浏览器请求须携带Cookie，不将认证令牌保存在 localStorage。

除了登录和初始化外，POST/PUT/PATCH写请求还需有效的 X-CSRF-Token；附件上传和Excel预览同样需要。长请求读取请求体后再次检查会话，防止已撤销账号完成上传。密码使用带随机盐的 scrypt 哈希，不提供密码读取接口。

| 方法与路径 | 用途 | 权限 |
| --- | --- | --- |
| GET /api/health | 服务健康及 schemaVersion=3 | 公开 |
| GET /api/auth/status | 是否需要初始化（setupRequired） | 公开 |
| GET /api/auth/session | 当前用户、CSRF和到期时间；无登录时 user=null | 公开入口 |
| POST /api/auth/setup | 创建首位管理员并登录，仅数据库无账号时可用 | 公开入口 |
| POST /api/auth/login | 登录并建立会话 | 公开入口 |
| POST /api/auth/logout | 撤销当前会话并清Cookie | 已登录 |
| POST /api/auth/password | 验证旧密码并修改，撤销本人全部会话 | 已登录 |

setup字段为 username、displayName、password；login为 username、password；修改密码为 oldPassword、newPassword。密码10—128位。登录失败按账号8次/15分钟、IP50次/15分钟限制，状态保存在数据库；错误提示不区分账号不存在或密码错误。

## 账号与秘密等级

| 方法与路径 | 用途 |
| --- | --- |
| GET /api/security/users | 账号列表 |
| POST /api/security/users | 新建账号 |
| PATCH /api/security/users/:id | 修改角色、授权、启停或重置密码 |
| GET /api/security/levels | 秘密等级字典 |
| POST /api/security/levels | 新增等级 |
| PATCH /api/security/levels/:id | 修改名称、启停 |
| GET /api/audit-logs | 操作日志分页，支持 action、page |

以上接口只允许系统管理员。角色为 admin、archivist、viewer。账号授权字段包括 companyIds、levelIds、canReadUnclassified、canDownload、canExport。canDownload同时控制附件原文件的预览和下载。新建需密码；修改账号携带 userVersion，修改等级携带 levelVersion，过期版本返回409。

秘密等级初始为空，管理员按实际资料添加，不预设名称或层级。等级可停用，不删除；已登记档案可保留历史停用等级，普通新增录入须使用启用等级。最后一个启用管理员受到保护。

GET /api/bootstrap 增加 currentUser、confidentialityLevels、capabilities；公司、部门、等级只返回当前账号获准范围。capabilities含 manage、write、download、export、unclassified，页面据此展示操作；服务端仍独立检查每个请求。

## 台账、附件和Excel权限

档案查询、详情、汇总与重复证书提示按公司和精确等级同时筛选，未定密必须独立授权。写入检查原档案和更新后的归属范围；查询人员禁止写入。基础资料及旧本机草稿迁移限系统管理员。

附件元数据遵循档案可读权限；原文件接口 /api/attachments/:id/content 额外验证 canDownload。Excel模板与导入限可写角色；导出及结果报告额外验证 canExport。导入任务绑定创建者，管理员可管理；确认时重新验证权限及基础资料版本。

## 提醒与统计

GET /api/reminders 和 GET /api/statistics 均支持 company（公司ID，可省略）、days（7/30/60/90，默认30）。返回当前授权范围的汇总与提醒数据，使用北京时间日期计算。固定有效期及保存期限各自形成事项；仅已登记档案提醒，状态为 expired、today、soon。到期不触发自动删除。统计包含各登记状态，总数与公司、大类、分类分组保持一致。

提醒与统计查询、台账查询、详情、文件访问、导出及关键修改写入日志。日志仅供管理员查询，每页50条，记录操作者快照、请求标识、动作与变化，不包含密码或认证令牌。

## 运行配置

沿用 PORT、ARCHIVE_DB_PATH、ARCHIVE_ALLOWED_ORIGINS。新增 ARCHIVE_COOKIE_SECURE=1 时为会话Cookie启用 Secure；仅在HTTPS部署环境设置。默认监听127.0.0.1。没有默认账号、匿名业务接口或跳过认证的HTTP入口。

实现参考：[Node.js scrypt](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptsyncpassword-salt-keylen-options)、[MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)。
