# SheetJS离线依赖

xlsx-0.20.3.tgz 为官方发布的SheetJS 0.20.3原始npm包。构建时以 backend/package-lock.json 中既有的SHA-512完整性值校验，避免服务器构建额外依赖单一CDN。项目未修改包内内容，许可证位于包内 package/LICENSE（Apache-2.0）。

原始发布地址：https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz

请保留此文件随源码提交；它属于构建依赖，不是档案附件或工作数据。更新版本时同时核对官方发布包和锁文件，不跳过完整性检查。
