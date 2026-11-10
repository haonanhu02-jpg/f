# 第四阶段API补充

继续使用第三阶段的JSON成功/错误协议。二进制下载与文件上传按下文处理。

## 附件

| 方法 | 接口 | 行为 |
| --- | --- | --- |
| GET | /api/archives/:id/attachments | 返回附件元数据列表，不含文件内容 |
| POST | /api/archives/:id/attachments?filename= | 原文件二进制，Content-Type为application/octet-stream；文件名URL编码 |
| GET/HEAD | /api/attachments/:id/content | 按实际MIME返回文件，默认inline；支持Range |
| GET | /api/attachments/:id/content?download=1 | 原文件下载，Content-Disposition保留UTF-8文件名 |

元数据包含id、archiveId、name、mime、size、sha256、createdAt。上传额外返回duplicate，重复内容不新增第二份附件。附件记录与内容在同一数据库事务内提交；扫描件份数字段不被修改。

单文件最大20MB。支持PDF、PNG、JPG/JPEG、WebP，实际文件签名与扩展名须匹配。作废档案拒绝上传，已有文件继续可读。不提供删除接口。

## Excel

| 方法 | 接口 | 行为 |
| --- | --- | --- |
| GET | /api/excel/template | 下载.xlsx模板，含填写说明、公司、分类目录 |
| POST | /api/excel/imports/preview?filename= | application/octet-stream二进制Excel；返回预览任务 |
| POST | /api/excel/imports/:id/commit | application/json，空对象{}；将可用行保存为草稿 |
| GET | /api/excel/imports/:id/report | 下载逐行结果.xlsx |
| GET | /api/excel/export | 沿用台账查询参数，导出全部匹配分页为.xlsx |

预览可选默认值参数：companyId、group（document/qualification）、categoryIds（逗号分隔节点ID）、numberingYear（归档年份）。文件明确填写的值优先，默认年份只用于年份类别。上传最大10MB、最多1000条业务数据，支持.xls/.xlsx。

预览及确认响应均包含id、committed、total、ready、imported、duplicates、failed、rows。每行包含Excel行号row、title、status、errors、warnings；status为ready、imported、duplicate或error。后端保存待导入记录，不接收前端重新提交的行数据以绕过预览。

确认任务30分钟过期；基础资料revision变化后返回409要求重新预览。确认使用事务，重复确认返回已保存结果，确认前新增的完全重复数据会再次检测并跳过。导入只新增草稿，不生成正式档号，也不覆盖已有档案。

导出支持company、group、category、department、validity、status、keyword，忽略当前页码，最多20000条，超限返回错误。日期为Excel日期值，数量为数值/空，证书编号等标识为文本。公式不参与导入计算，导出中以字符串保存用户文本。

## 数据结构版本2

在保留已有表和记录的基础上，增加attachments与excel_import_jobs，增加证书编号查询索引。附件内容为SQLite BLOB，数据库及WAL均属于运行资料。已有基础资料和编号计数器不会因升级而重置。

SheetJS依赖固定为0.20.3，来源为[官方Node.js安装文档](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)，后端通过Buffer读取和输出，不依赖前端安装该库。
