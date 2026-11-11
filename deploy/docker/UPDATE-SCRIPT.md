# 固定项目目录的部署更新脚本

按用户提供的另一个项目脚本的使用方式，提供独立 update-archive.sh 文件。将文件放到已存在的 /home/wsgfai，然后执行：

```bash
bash /home/wsgfai/update-archive.sh
```

脚本从 haonanhu02-jpg/f 的main分支拉取。首次克隆到 /home/wsgfai/f；后续在同一目录执行 git pull --ff-only。优先尝试GitClone镜像，失败后尝试GitHub原站；每个地址默认3次。使用单次Git配置解决仓库属主检查及HTTP/1.1连接，不修改服务器全局Git配置。本地源码有未提交修改或当前分支不符时停止，不覆盖修改。

代码更新后，按多个Node镜像源和npm源构建，再用项目已有Compose配置启动。默认端口8080；可用 HTTP_PORT=9000 PUBLIC_URL=http://实际IP:9000 bash /home/wsgfai/update-archive.sh 指定其他端口和地址。需要服务器已有Docker Engine、Compose插件、Git、curl、Python3和常见Linux工具。

成功前检查容器健康状态、API及实际网站页面，成功后输出网址。失败输出 /home/wsgfai/archive-logs/本次编号 和 failure.log前30行；完整命令及容器日志保留在该目录。不会自动创建/home/wsgfai，若启动目录不存在则提示错误。

SQLite与附件继续使用同一个 archive-ledger_data 命名卷，备份使用 archive-ledger_backups。重复部署先在旧容器中备份，备份失败停止替换；通过 up -d 更新容器，不先执行down。此脚本上次成功运行的镜像及Compose配置记录在 /home/wsgfai/.archive-deploy/current；新版本启动失败时尝试用该记录重新启动旧版本，数据库不自动回滚。

原deploy.sh使用版本源码目录，仍保留；本脚本是固定目录的另一入口。两种方式选一种运行，不要同时部署同一项目。截图中其他项目的地址和Compose配置不适用于本项目。

验证：Bash语法检查和7组Linux测试通过，测试使用真实本地Git仓库验证首次克隆、快速更新、本地修改保留和目录保护；Docker与HTTP行为由模拟命令覆盖，不代表已经在目标服务器完成真实容器构建启动。
