# 档案台账前端

当前为1.0.0版本：沿用已认可的界面，接入独立后端与SQLite，支持扫描附件、Excel批量台账、账号权限、日志、到期提醒和统计。生产构建复用相同业务组件，增加独立静态入口，无需服务器运行前端开发工具。

## 启动

项目整体需要Node.js 24或更高版本，先启动后端：

```powershell
cd D:\档案\backend
npm ci
npm start
```

另开一个终端启动前端：

```powershell
cd D:\档案\frontend
npm ci
npm run dev
```

已安装依赖时可跳过npm ci。默认前端地址`http://127.0.0.1:5173/`，后端默认3001端口。前端使用开发代理对接`/api`；后端未启动时页面显示连接问题，不回退到本机数据冒充数据库。

首次打开自行创建首位管理员，项目没有默认账号密码。管理员维护秘密等级并建立账号；普通账号按公司、密级和独立的未定密/原文件/导出授权展示页面。停用或调整授权会撤销已有会话，使用者需要重新登录。

## 功能

- 服务端分页查询，按公司、大类、多层分类、部门、有效期模式、登记状态筛选；支持名称、档号、证书编号关键词。
- 新增、编辑、详情页面，原表数量、日期、移交、密级、保存期限、位置和备注字段完整保留。
- 保存数据库草稿，或保存并正式入账；正式档号由后端事务分配。
- 正式档案保管等信息修改，归属/分类/归档年份锁定；作废原因和原号保留。
- 公司、部门、分类维护已保存到数据库，带并发版本检查。
- 显式迁移第二阶段本机草稿；保留本机原资料，排除演示数据，冲突时不覆盖。
- 桌面及手机布局。
- 扫描附件上传、图片/PDF预览及原文件下载，上传相同内容自动去重，文件数与份数独立。
- Excel模板下载、.xls/.xlsx预览校验、确认导入可用行及结果报告。
- 按当前查询条件导出全部匹配记录，保留原表字段、日期和编号。
- 登录退出、本人修改密码、管理员账号授权与秘密等级管理。
- 默认提前30天的有效期和保存期限提醒，可选7/30/60/90天。
- 授权范围内的统计，管理员只读操作日志与修改前后对比。

3家公司编码、秘密等级依然待补。未补公司编码和未明确编号模式的类别，允许准备草稿，但不能正式入账。

## 代码结构

前端使用React、TypeScript和Vinext/Vite。业务代码在`features/archive/`；`repository.ts`封装HTTP请求；`model.ts`定义响应结构和即时校验；`ArchiveApp.tsx`协调页面；`Ledger.tsx`处理服务端查询结果；表单与详情分文件维护。

初始参考数据由第一阶段资料整理，可执行`npm run sync:reference`同步前端参考文件及后端seed。同步不会覆盖已有数据库或浏览器资料。后端独立携带seed，不依赖前端源码才能运行。

模板保留Sites构建支持，但当前按阶段在本地运行，尚未注册或部署云端站点。

## 检查

```powershell
npm run typecheck
npm run build
python -X utf8 scripts/verify-phase3.py
python -X utf8 scripts/verify-phase4.py
python -X utf8 scripts/verify-phase5.py
python -X utf8 scripts/verify-phase6.py
```

浏览器脚本需要Python Playwright及本机已有Chromium，使用独立临时API及数据库，不写入3001端口的实际工作库。截图与验收报告在忽略跟踪的`outputs/`。旧verify-phase2.py保留为历史参考，不适用于当前版本。

第四阶段浏览器脚本也使用独立临时数据库，结果在outputs/。现行附件及Excel操作见[第四阶段完成清单](../docs/phase-4/README.md)及[第四阶段API](../docs/phase-4/API.md)。登记与编号契约仍见[第三阶段API](../docs/phase-3/API.md)。

第五阶段通过8组浏览器验收，第三阶段11组与第四阶段8组回归也已通过。账号初始化、角色规则、日志与分析见[第五阶段完成清单](../docs/phase-5/README.md)及[第五阶段API](../docs/phase-5/API.md)。测试不会建立实际工作账号或预置实际秘密等级。

## 生产构建

执行 npm run build:production 生成 dist-production/，入口为 production/main.tsx，复用 features/archive/ 与 app/globals.css。由独立Node服务托管静态文件和API，经Nginx提供HTTPS。保留原Vinext/Sites开发构建配置；Linux交付不依赖Cloudflare或Sites模拟登录。

verify-phase6.py直接启动生产静态包和隔离API，不依赖5173开发服务；验证生产登录、登记、PDF预览/下载、Excel导出、统计、手机布局及在线备份恢复。其余浏览器脚本仍以5173开发前端执行，并使用隔离API。第六阶段说明见[交付清单](../docs/phase-6/README.md)。
