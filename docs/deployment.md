# 独立服务器与 Docker 部署

独立部署使用 Next.js standalone、Node.js 和 SQLite，不需要 Cloudflare、D1、R2 或 ChatGPT 账号。日志、问题、审计和 Markdown 原文均保存在同一 SQLite 数据库。适用于单实例、单管理员的团队门户；不支持多个副本共享数据库，也不要将 SQLite 放到 NFS 等网络文件系统。

项目默认公开展示审查内容，并允许匿名更新活动问题。只供内部使用时，请在反向代理或防火墙限制访问。管理员使用随机密码登录 `/login`，会话有效期 12 小时。Linux 容器以非 root 用户运行。

## Docker Compose

安装 Git 和 Docker Engine / Docker Desktop（Linux 容器）及 Compose v2，然后克隆仓库。以下 Shell 命令在 Linux 执行；Windows 对应使用 PowerShell 的 `Set-Location`，密钥生成和应用命令相同。

```sh
git clone https://github.com/zhoupeixian/svn-review-hub.git
cd svn-review-hub
node scripts/init-server.mjs http://localhost:3000
docker compose up -d --build
docker compose ps
curl --fail http://localhost:3000/api/health
```

密钥生成需要 Node.js 22 或 24。仅安装 Docker 时可在仓库目录使用容器生成：

```sh
docker run --rm -v "$PWD:/workspace" -w /workspace --entrypoint node node:24-bookworm-slim scripts/init-server.mjs http://localhost:3000
```

脚本以独占方式创建 `.env.server`，不会覆盖已有配置，也不会在终端打印密码。打开该文件读取 `PORTAL_ADMIN_PASSWORD`，在 `/login` 登录后进入 `/admin/projects`。妥善保管文件，不要提交或分享；Linux 下将文件所有权设为维护账户并保持权限 `600`，Windows 下限制其 ACL。

首次访问会初始化数据库。默认容器端口仅绑定宿主机 `127.0.0.1:3000`，数据保存在命名卷 `zherp-portal-data`。更新容器不会清空数据；不要执行 `docker compose down -v`。可通过 `PORTAL_VOLUME` 指定新部署的卷名；变更卷名会进入不同数据库，不是数据迁移。

### 使用 GitHub Packages 镜像

维护者手动运行 **Publish container** 后，会得到经过 CI 和容器验收的 `ghcr.io/zhoupeixian/svn-review-hub:sha-<完整提交号>`。公开 Release 发布时生成同名 `vX.Y.Z` 镜像。当前镜像平台为 **linux/amd64**；其他架构请自行构建并验证。

从成功的工作流记录或 Packages 页面复制真实存在的镜像地址，优先固定 `@sha256:...` 摘要：

```sh
export PORTAL_IMAGE=ghcr.io/zhoupeixian/svn-review-hub@sha256:<实际摘要>
docker compose pull
docker compose up -d --no-build
```

PowerShell 使用 `$env:PORTAL_IMAGE = '实际镜像地址'`。首次 GHCR 发布后维护者需确认 Package 为 Public 才能匿名拉取；Private 包需要具有 `read:packages` 权限的凭据。Release 草稿本身不生成可拉取镜像。发布流程不会自动更新你的服务器。

仓库改名前已经发布并固定的 `ghcr.io/zhoupeixian/zherp-svn-review-portal@sha256:...` 镜像可继续用于现有部署；仓库改名后的新发布使用 `ghcr.io/zhoupeixian/svn-review-hub`。不要仅为了名称统一替换一个已经验证并固定摘要的生产镜像。

## HTTPS 与反向代理

生产先将 `.env.server` 的 `PORTAL_ORIGIN` 改成唯一外部地址，例如 `https://review.example.com`，再重建容器使配置生效。错误的 Origin 会导致登录失败。可在宿主机使用 Caddy：

```caddyfile
review.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

配置域名 DNS 和防火墙，开放代理的 80/443，保持应用 3000 不对公网开放。HTTPS Origin 会启用 Secure Cookie。也可使用已有 Nginx 或负载均衡器完成 TLS。

默认不信任客户端提供的 IP 头，匿名协作与管理员登录分别使用共享限流桶。登录每 15 分钟最多 10 次尝试；无可信代理时，其他人的错误尝试也可能暂时阻断管理员登录。因此公网部署应配置下述代理来源隔离，并按需在代理限制登录流量。只有在代理**始终覆盖** `X-Real-IP` 且无法绕过代理访问应用时，才设置 `PORTAL_TRUST_PROXY=true`，用于区分真实匿名来源。以 Caddy 为例，在 `reverse_proxy` 块加入 `header_up X-Real-IP {remote_host}`。不得透传客户端自行设置的值。

## 不使用 Docker

使用 Node.js 24 LTS（CI 同时验证 Node.js 22），安装和构建：

```sh
npm ci
node scripts/init-server.mjs http://localhost:3000
npm run build:server
npm run start:server
```

默认监听 `127.0.0.1:3000`，数据位于仓库的 `data/portal.sqlite`。首次构建需要下载依赖和字体。不要用 `npm run dev` 提供生产服务；它属于 Cloudflare 开发路径。Node 的 `node:sqlite` 在部分受支持版本仍显示实验性警告；升级 Node 后也需运行仓库验证。

Linux 可将以下 systemd 示例保存为管理员管理的服务单元，按实际账户和安装目录修改：

```ini
[Unit]
Description=SVN review portal
After=network.target

[Service]
Type=simple
User=portal
WorkingDirectory=/opt/svn-review-hub
EnvironmentFile=/opt/svn-review-hub/.env.server
Environment=NODE_ENV=production
ExecStart=/usr/bin/node scripts/start-server.mjs
Restart=on-failure
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

维护账户必须能写入数据目录；按你的系统调整 Node 路径。Windows 可使用现有服务管理工具托管 `npm run start:server`，确保工作目录与环境配置一致。

仓库改名不会要求已有安装目录同步改名；如果现有服务仍位于旧目录，只要 `WorkingDirectory` 和 `EnvironmentFile` 继续指向实际路径即可。上面的 `/opt/svn-review-hub` 仅是新安装示例。

## 配置

| 变量 | 用途 |
| --- | --- |
| `PORTAL_ORIGIN` | 浏览器访问的唯一 HTTP(S) Origin，不含路径 |
| `PORTAL_ADMIN_PASSWORD` | 管理员随机密码，至少 20 字符；生成器使用 32 字节随机值 |
| `PORTAL_SESSION_SECRET` | 会话签名密钥，至少 32 字符 |
| `ANONYMOUS_SOURCE_HASH_KEY` | 匿名来源 HMAC 密钥，至少 32 字符 |
| `REVIEW_SYNC_MASTER_KEY` | 32 字节随机密钥的 Base64，用于加密项目同步密钥 |
| `PORTAL_DATA_DIR` | 原生部署数据库目录，默认 `./data`；容器默认 `/data` |
| `PORTAL_BIND_ADDRESS` / `PORT` | 原生服务监听地址和端口，默认 `127.0.0.1:3000` |
| `PORTAL_TRUST_PROXY` | 默认禁用，只有上述可信代理条件满足时设置 `true` |

Compose 的宿主机端口由 `PORTAL_BIND_HOST` / `PORTAL_PORT` 控制，镜像由 `PORTAL_IMAGE` 控制。这些 Compose 插值变量应在当前 Shell 或 Compose 的 `.env` 配置；不要误以为服务的 `.env.server` 会参与 Compose 文件插值。

更改密码或会话密钥并重启会使已有会话失效；修改同步主密钥会使已有项目密钥无法解密，不能将其当作普通密码随意轮换。项目同步密钥可在管理页独立轮换。

## 备份、恢复与升级

备份必须同时保留数据库快照和匹配的 `.env.server`。备份中含业务内容和加密密钥，存放在受限、加密且独立于服务器的存储上。

原生部署可在线生成一致快照，目标文件必须不存在：

```sh
node --env-file=.env.server scripts/backup-server.mjs backups/portal-2026-09-13.sqlite
```

容器部署：

```sh
docker compose exec portal node scripts/backup-server.mjs /data/backup-2026-09-13.sqlite
docker compose cp portal:/data/backup-2026-09-13.sqlite ./portal-2026-09-13.sqlite
```

不要在运行中只复制 `portal.sqlite` 而遗漏 WAL。脚本使用 SQLite `VACUUM INTO` 快照，同时包括原文。定期将快照取出并做恢复演练，按自己的保留策略管理备份空间。

恢复前停止服务，选择**全新空目录或新卷**，保留原数据以便回退。原生部署示例：

```sh
export PORTAL_DATA_DIR=/srv/portal-restored
node scripts/restore-server.mjs /secure-backups/portal-2026-09-13.sqlite
npm run start:server
```

容器恢复可先停止原服务，将备份放入当前卷，再恢复到该卷的新子目录：

```sh
docker compose stop portal
docker compose run --no-deps --entrypoint node -e PORTAL_DATA_DIR=/data/restored portal scripts/restore-server.mjs /data/backup-2026-09-13.sqlite
```

成功后在 `.env.server` 加入 `PORTAL_DATA_DIR=/data/restored`，确认其他密钥与快照匹配，再 `docker compose up -d`。脚本检查数据库完整性并拒绝覆盖已有目标。恢复后验证 `/api/health`、日志原文和项目同步。

升级顺序：阅读版本说明 → 备份数据和配置 → 拉取固定镜像或切换 Git 版本并重新构建 → 启动 → 检查健康、原文和同步。schema 会在访问时兼容升级；**降级镜像不等于回滚数据库**，必要时恢复旧版本匹配的快照和配置。

Cloudflare 的既有 D1/R2 与 SQLite 实例不会自动同步。迁移历史日志可以重新导入 Markdown，但协作历史、审计与身份迁移需要单独设计，不承诺直接复制数据库即可切换。
