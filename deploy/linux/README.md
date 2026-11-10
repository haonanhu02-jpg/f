# Linux内网部署说明

当前用户选择容器启动，优先使用[容器部署说明](../docker/README.md)和根目录deploy.sh。下述systemd方式作为备用参考，不与容器应用同时启用。

应用1.0.0，结构版本3。目标为一台Linux服务器、多用户浏览器访问。服务器IP、内网域名、证书及连接方式尚待提供，本说明没有在目标服务器上执行。

## 运行布局

浏览器通过内网HTTPS访问Nginx，Nginx转发到127.0.0.1:8080的Node.js服务。前端生产文件与API同源，前后端源码仍分离。SQLite数据库和附件保存在服务器本地持久磁盘，只运行一个systemd应用实例；不将数据库放在网络共享盘，不启用Node集群。备份目录独立于版本目录。

| 路径 | 用途 |
| --- | --- |
| /opt/archive-ledger/releases/1.0.0 | 解压后的Linux运行包 |
| /opt/archive-ledger/current | 指向当前版本的符号链接 |
| /etc/archive-ledger.env | 实际环境配置，权限640 |
| /var/lib/archive-ledger | 工作数据库及WAL，应用用户拥有 |
| /var/backups/archive-ledger | 校验备份，应用用户拥有；另按公司要求复制到异机存储 |

需要Node.js 24 LTS（建议与已验收的24.15.0或更新24.x保持一致）、systemd、Nginx、unzip；node路径假定为/usr/bin/node，其他路径须同步修改service文件。运行包包含已固定版本的xlsx和zod纯JavaScript依赖，不需要npm安装。Node安装及企业证书按服务器管理员现有流程处理。

## 安装

以下命令由服务器管理员执行。将两个包及.sha256文件安全传入服务器，先执行 sha256sum -c 对应文件.sha256。只部署linux运行包，源码包留作维护。

```bash
sudo useradd --system --home /var/lib/archive-ledger --shell /usr/sbin/nologin archive-ledger
sudo install -d -o root -g root -m 755 /opt/archive-ledger/releases/1.0.0
sudo unzip archive-ledger-1.0.0-linux.zip -d /opt/archive-ledger/releases/1.0.0
sudo chown -R root:root /opt/archive-ledger/releases/1.0.0
sudo ln -s /opt/archive-ledger/releases/1.0.0 /opt/archive-ledger/current
sudo install -d -o archive-ledger -g archive-ledger -m 700 /var/lib/archive-ledger /var/backups/archive-ledger
cd /opt/archive-ledger/current
node tools/verify-release.mjs
sudo install -o root -g archive-ledger -m 640 deploy/linux/archive-ledger.env.example /etc/archive-ledger.env
```

若用户、目录或current已存在，先核对现有安装，不重复覆盖；升级见运维文档。配置中 ARCHIVE_ALLOWED_ORIGINS 必须改为实际访问源，例如 https://公司内网域名，精确包含协议及非默认端口，不含末尾斜线。示例 archives.example.invalid 是占位值，不能直接上线。配置不包含密码；账号通过页面创建。

```bash
sudoedit /etc/archive-ledger.env
sudo install -m 644 deploy/linux/archive-ledger.service /etc/systemd/system/
sudo install -m 644 deploy/linux/archive-ledger-backup.service /etc/systemd/system/
sudo install -m 644 deploy/linux/archive-ledger-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now archive-ledger
curl --fail http://127.0.0.1:8080/api/health
sudo systemctl status archive-ledger --no-pager
```

创建Nginx站点配置，将 nginx.conf.example 的域名、证书路径改为实际值。企业证书须包含访问域名，并让客户端信任颁发机构；通过IP访问时证书也需覆盖该IP。按服务器Nginx惯例将配置放入已包含的conf.d或sites-enabled目录。仅向公司内网开放443和需要的80端口，8080保持本机监听。

```bash
sudo nginx -t
sudo systemctl reload nginx
node /opt/archive-ledger/current/deploy/linux/check-deployment.mjs https://实际内网域名
```

首次管理员创建前，将Nginx站点临时限制为管理员工作站的内网IP（通过公司网关或Nginx allow/deny），由管理员访问HTTPS页面自行创建账号、设置秘密等级和其他使用者。完成后再开放授权内网网段。无预置账号密码。

## 备份和上线验收

```bash
sudo systemctl start archive-ledger-backup.service
sudo journalctl -u archive-ledger-backup.service -n 30 --no-pager
sudo systemctl enable --now archive-ledger-backup.timer
systemctl list-timers archive-ledger-backup.timer
```

timer建议默认北京时间02:00执行，允许5分钟随机延迟；离线错过的任务开机后补跑。此配置只随交付包提供，本轮未在远程服务器启用。首次备份成功后，选择一份备份按恢复文档在新路径演练。备份不自动清理，运维人员按公司保留策略管理容量并复制到另一设备；每日备份通常意味着故障时可能需要补录最近一次备份之后的资料。

最后按 docs/phase-6/验收清单.md 完成两台客户端实测、证书验证、权限隔离、主机重启后自启、磁盘和备份监控，以及业务负责人签收。上述服务器检查没有在Windows开发电脑上替代执行。

配置依据：[Nginx代理文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[systemd服务文档](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)。
