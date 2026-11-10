# Linux容器部署

当前采用此方式部署到公司内网服务器。入口为项目根目录 deploy.sh：从 https://github.com/haonanhu02-jpg/f 拉取代码，切换可用的基础镜像及npm源，构建生产镜像，通过Docker Compose运行；检查容器、API和页面后输出网站链接。失败返回非0退出码，输出日志目录及failure.log前30行。

仓库main分支包含完整源码：Dockerfile、deploy.sh、deploy/docker/、vendor/xlsx-0.20.3.tgz及前后端。源码不包含工作数据库、备份或实际账号凭据。脚本会检测空仓库和缺失文件，遇到不完整的源会返回失败日志。

## 服务器执行

需要Linux、Docker Engine及可用的Docker Compose v2插件，以及git、curl、python3、flock、timeout、tee等常见命令。建议至少2核、4GB内存和10GB可用空间，实际空间随附件与镜像增加。脚本检查已有依赖，不自动修改Docker全局配置或安装软件。

将 deploy.sh 放到服务器 /home/wsgfai/deploy.sh，然后在此目录执行：

```bash
cd /home/wsgfai
sudo bash /home/wsgfai/deploy.sh
```

也可先从main分支下载脚本，检查内容后执行：

```bash
sudo mkdir -p /home/wsgfai
cd /home/wsgfai
sudo curl --fail --location --output deploy.sh https://raw.githubusercontent.com/haonanhu02-jpg/f/main/deploy.sh
sudo bash /home/wsgfai/deploy.sh
```

若服务器不能访问raw.githubusercontent.com，使用本地源码中的deploy.sh传到服务器即可；脚本自身拉取项目时会尝试配置的多个代码源。

默认使用main分支，脚本自动切换到 /home/wsgfai 启动，拉取内容也放在此目录内。版本源码为 /home/wsgfai/releases/执行编号/source，当前成功版本为 /home/wsgfai/current/source，日志为 /home/wsgfai/logs/执行编号；对内网开放8080端口，自动选择服务器IP并输出 http://服务器IP:8080。无需在宿主机安装Node.js或npm。首次访问自行创建管理员账号，没有预置账号密码。公司防火墙需允许客户端访问指定端口。

多网卡、指定域名或自定义端口时建议明确填写访问地址：

```bash
sudo env PUBLIC_URL=http://192.168.1.100:8080 bash deploy.sh
sudo env HTTP_PORT=9000 PUBLIC_URL=http://192.168.1.100:9000 bash deploy.sh
```

将示例IP换成实际服务器内网IP。PUBLIC_URL必须为最终访问源，决定登录写请求的来源校验。若使用现有Nginx/网关提供HTTPS，可使用 PUBLIC_URL=https://实际域名，并按网关情况设置 BIND_IP=127.0.0.1；证书和代理需先由运维配置，脚本会校验HTTPS地址可达及证书有效，不会跳过证书验证。当前不自动签发未知域名的证书。

## 多源和重试

| 类别 | 默认依次尝试 |
| --- | --- |
| Git代码 | GitHub原站、gitclone.com缓存地址 |
| Node基础镜像 | Docker Hub、Amazon ECR Public Docker库、Google mirror.gcr.io缓存 |
| npm | registry.npmjs.org、registry.npmmirror.com |
| Excel组件 | 随源码携带官方SheetJS 0.20.3原始安装包，按原锁文件SHA-512验证 |

代码和基础镜像每个源默认尝试2次，均带超时；镜像构建按npm源逐一尝试。各源可能受服务器网络或缓存情况影响，不能承诺所有网络条件下必然成功。不会更改宿主机daemon.json、关闭TLS或修改npm依赖版本。企业内网有可用的镜像仓库时可优先使用，多个值以空格分隔：

```bash
sudo env \
  NODE_IMAGES='企业镜像仓库/library/node:24.15.0-bookworm-slim docker.io/library/node:24.15.0-bookworm-slim' \
  NPM_REGISTRIES='https://企业npm镜像 https://registry.npmjs.org' \
  GIT_URLS='https://github.com/haonanhu02-jpg/f.git https://gitclone.com/github.com/haonanhu02-jpg/f.git' \
  PUBLIC_URL=http://实际内网IP:8080 \
  bash deploy.sh
```

上述企业地址为占位值，使用前替换。GitHub可访问时，先读取main实际提交SHA，再校验各镜像拉取结果，拒绝过期或不一致的提交。原站不可达时允许使用配置的镜像分支并记录完整SHA；已知发布SHA时可通过 EXPECTED_COMMIT=完整40位SHA 锁定版本。当前浅克隆部署分支头，EXPECTED_COMMIT用于校验分支头，不用于检出任意历史提交。

自定义代码源须是可信源，且不要在URL中嵌入密码或访问令牌。镜像回源仅适用于此公开仓库；私有仓库应使用公司自己的Git服务和已有凭据管理，不把认证地址传给公共缓存。

## 成功与失败输出

成功示例：

```text
部署成功
网站链接：http://192.168.1.100:8080
提交：本次实际40位提交SHA
日志目录：/home/wsgfai/logs/本次执行编号
```

失败示例：

```text
部署失败（退出码 1）
失败日志目录：/home/wsgfai/logs/本次执行编号
前30行日志（failure.log）：
失败阶段：构建镜像
失败原因：使用全部npm镜像源构建后仍然失败。
……实际日志内容……
```

每次执行生成独立目录，保留deploy.log、git/pull/build各次日志、健康检查结果及result.json。失败会尽可能额外收集compose-ps.log、container.log和docker-version.log。failure.log包含失败阶段/原因及对应阶段日志，终端仅显示其前30行，完整内容保留在目录中。没有通过启动检查时不会打印成功链接。

## 数据持久化、重复部署与回退

应用以非root用户运行。数据和备份分别保存在Docker命名卷 archive-ledger_data、archive-ledger_backups，包含附件的SQLite位于 /data/archive.sqlite。重复执行脚本时使用相同Compose项目名，复用这两个卷，镜像及容器更新不会清空资料。不要执行 docker compose down -v 或 docker volume prune 来更新应用。

每次拉取放入新的releases目录，不覆盖上次源码。检测到正在运行的同项目容器时，替换之前先在旧容器中制作校验备份；备份失败会中止替换。新版本启动失败时，若存在上次成功部署记录，则尝试重新启动上一版本镜像，结果写入rollback.log，仍报告本次部署失败。自动回退只恢复应用版本，不覆盖数据库；未来涉及结构升级时仍须按对应版本恢复方案处理。

首次容器部署不会自动迁移宿主机的旧数据库。需要迁移时先使用已有备份工具制作并验证快照，由运维按新路径恢复方式迁入数据卷，避免误把开发目录数据当作正式库。

成功后 current 链接指向本次部署目录，后续查看日志、停启与备份可运行：

```bash
cd /home/wsgfai/current
sudo docker compose --project-name archive-ledger --env-file runtime.env -f source/deploy/docker/compose.yaml ps
sudo docker compose --project-name archive-ledger --env-file runtime.env -f source/deploy/docker/compose.yaml logs --tail 100 app
sudo docker compose --project-name archive-ledger --env-file runtime.env -f source/deploy/docker/compose.yaml exec -T app node scripts/maintenance.mjs backup
sudo docker compose --project-name archive-ledger --env-file runtime.env -f source/deploy/docker/compose.yaml stop
sudo docker compose --project-name archive-ledger --env-file runtime.env -f source/deploy/docker/compose.yaml start
```

容器配置unless-stopped，Docker服务随主机启动后会自动重启未手动停止的容器。内网多人访问同一实例，不增加SQLite应用副本。主机Docker是否开机启动及实际客户端访问仍需服务器验收。定时备份可由运维的调度系统调用上面的容器内备份命令；原systemd备份模板针对宿主机运行方式，不与容器部署同时启用。

## 可选配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| DEPLOY_DIR | /home/wsgfai | 代码版本与部署记录目录 |
| LOG_BASE | DEPLOY_DIR/logs | 日志位置，不可写时尝试临时目录 |
| BRANCH | main | 拉取分支 |
| REPO_URL | 指定GitHub仓库.git地址 | 原始代码源 |
| PROJECT | archive-ledger | Compose项目名，改名会使用另一组数据卷 |
| HTTP_PORT | 8080 | 宿主机端口 |
| BIND_IP | 0.0.0.0 | 发布监听地址 |
| PUBLIC_URL | 自动识别IP和端口 | 最终访问源，成功前验证可达 |
| EXPECTED_COMMIT | 原站分支SHA（可取得时） | 校验发布版本 |
| RETRIES | 2 | 每个Git/基础镜像源重试次数 |
| GIT_TIMEOUT / PULL_TIMEOUT | 120 / 180秒 | 单次拉取超时 |
| BUILD_TIMEOUT / HEALTH_TIMEOUT | 1800 / 120秒 | 每次构建和容器健康等待上限 |

## 本次验证

Bash语法检查、真实Docker Compose配置解析、Linux下10项模拟部署测试及38项后端回归已验证。模拟覆盖多源切换、空仓库、提交不匹配、Docker不可用、拉取/构建失败、启动/健康/URL失败、前30行日志、升级前备份及回退。模拟测试不等同于Docker镜像实际构建。

当前电脑Docker守护进程未运行，目标Linux服务器信息也未提供，因此尚未完成真实容器构建及启动，不提供虚构的线上链接。服务器执行后以脚本实际输出为准。

参考：[Docker构建参数](https://docs.docker.com/build/building/variables/)、[Compose服务配置](https://docs.docker.com/reference/compose-file/services/)、[GitClone用法](https://gitclone.com/)、[Google镜像缓存](https://docs.cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images)、[npm镜像说明](https://npmmirror.com/)。
