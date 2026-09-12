# ZHERP SVN 审查门户

将 SVN 代码审查 Markdown 日志整理为可检索、可跟踪、可分享的多项目门户。适合开发者查看每日审查结果、跟进问题，也方便管理员统一导入和归档日志。

本项目负责展示和管理审查结果；SVN 更新、构建及代码审查由外部自动化完成，门户接收其输出。

[本地运行](#本地运行) · [自动同步](#导入和自动同步) · [开发指南](AGENTS.md) · [反馈与贡献](#反馈与贡献)

## 能做什么

- 按项目浏览日志、Revision 和 P1/P2/P3 问题，按条件筛选与搜索。
- 在问题看板记录处理说明，跟踪待处理、待确认、已解决、误判、设计如此、暂不处理六种状态。
- 分享当前筛选链接、查看日志原文，导出日志和问题数据。
- 查看只读归档；管理员可预览并确认归档、恢复日志、手工上传 Markdown。
- 管理项目、启停状态、排序和独立同步密钥，并查看项目管理审计记录。
- 接收本地日志自动同步，展示最近自动同步及相关健康指标。

## 页面与使用流程

| 入口 | 用途 |
| --- | --- |
| `/` | 项目目录 |
| `/projects/{slug}` | 项目日志首页 |
| `/projects/{slug}/issues` | 问题看板 |
| `/projects/{slug}/archive` | 归档库 |
| `/projects/{slug}/reviews/{id}` | 日志详情 |
| `/projects/{slug}/admin` | 项目日志管理，需要管理员身份 |
| `/admin/projects` | 全站项目管理，需要管理员身份 |

从项目目录进入目标项目，筛选日志或问题，打开详情查看原始上下文，再填写问题状态与处理说明。当前问题支持匿名协作；匿名记录不代表经过认证的操作者身份。归档内容只读。旧 `/admin` 等兼容入口对应默认 `zherp` 项目，新集成应优先使用带项目路径的入口。

管理员登录依赖托管环境提供的 ChatGPT 身份。管理员表为空时，首个通过管理员检查的已登录用户会被登记为管理员，后续用户需要已在管理员表中；首次初始化应由项目负责人完成。

## 本地运行

需要 Node.js **22.13.0 或更高版本**、npm 和 Git。以下示例使用 PowerShell；已克隆仓库的开发者直接进入现有目录，不要重复克隆。

```powershell
git clone https://github.com/zhoupeixian/zherp-svn-review-portal.git
Set-Location zherp-svn-review-portal
npm ci
if (-not (Test-Path .dev.vars)) { Copy-Item .dev.vars.example .dev.vars }
```

编辑 `.dev.vars`，将占位值换为独立随机密钥：

| 服务端变量 | 用途 |
| --- | --- |
| `ANONYMOUS_SOURCE_HASH_KEY` | 匿名协作来源摘要，至少 32 个字符 |
| `REVIEW_SYNC_MASTER_KEY` | 加密项目同步密钥，32 字节随机值的 Base64；妥善备份，丢失后无法恢复已有密钥 |

随后启动：

```powershell
npm run dev
```

访问终端实际输出的本地地址。`vite.config.ts` 根据 [.openai/hosting.json](.openai/hosting.json) 配置本地 Cloudflare 模拟环境，D1 绑定为 `DB`，R2 绑定为 `FILES`；本地状态保存在 `.wrangler` 等忽略目录中。数据库访问会通过 `ensureReviewSchema()` 初始化和兼容升级审查表。

本地页面启动不等于完整登录链路可用：`/signin-with-chatgpt` 等登录入口和可信身份头依赖 Sites 托管环境，仓库没有独立账号密码登录服务。当前仓库也没有独立的 Wrangler 部署配置或 `deploy` 脚本。

## 导入和自动同步

少量日志可在项目管理页手工上传。持续同步使用 [scripts/sync-local-reviews.mjs](scripts/sync-local-reviews.mjs)，配置样例见 [.env.example](.env.example)。

脚本默认读取 `$HOME/.codex/automations/zherp/review-portal.env`，也可通过 `REVIEW_PORTAL_CONFIG` 指定文件；已有进程环境变量优先。**脚本不会自动读取仓库根目录的 `.env`**，如使用它须显式指定。

| 同步端变量 | 是否必需 | 含义 |
| --- | --- | --- |
| `REVIEW_PORTAL_URL` | 是 | 目标站点地址 |
| `REVIEW_PORTAL_PROJECT_SLUG` | 是 | 目标项目标识，如 `zherp` |
| `REVIEW_PORTAL_SYNC_KEY` | 是 | 该项目的同步密钥，从项目管理获得 |
| `REVIEW_LOG_ROOT` | 是 | 本地审查日志根目录 |
| `REVIEW_PORTAL_DISPATCH_TOKEN` | 否 | 私有 Sites 站点的服务访问令牌 |

```powershell
# 先按 .env.example 准备本地 .env，填写实际配置
$env:REVIEW_PORTAL_CONFIG = Join-Path (Get-Location) '.env'
npm run sync:reviews -- --date 2026-09-12
```

此命令会向目标站点写入日志。指定日期时扫描 `<REVIEW_LOG_ROOT>/<日期>/`，不指定时递归扫描整个根目录；仅接收文件名为 `svn审查日志-*.md` 的文件。脚本以相对路径作为 `sourceKey`，通过 `POST /api/reviews` 携带项目标识及 `x-review-sync-key` 上传。同项目、同来源重复导入会合并日志，保留已有问题的处理状态及历史。

服务端主密钥不要复制到同步主机。实际 `.env`、`.dev.vars`、访问令牌和日志中的敏感信息不要提交到仓库。

## 构建与检查

```powershell
npx tsc --noEmit
npm run lint
npm run build
```

生产构建使用 vinext/Vite，产物写入 `dist`。`npm run start` 启动构建产物；构建成功不代表线上 D1/R2、登录或域名已配置。完整测试命令见 [AGENTS.md](AGENTS.md#测试与验证)，测试必须分 Node/jsdom 与 Workers 两种环境。

已有部署可执行只读冒烟检查：

```powershell
$env:REVIEW_PORTAL_URL = 'https://your-review-portal.example'
npm run smoke:production
```

冒烟命令直接读取进程环境变量，依次检查首页、旧管理地址重定向、项目管理入口认证保护、ZHERP 只读 API；不发送 Cookie、同步密钥或服务令牌。退出码 `0` 为通过、`1` 为检查失败、`2` 为配置错误；私有站点的外层访问保护可能使检查无法通过。

## 技术与开发文档

React 19、Next.js App Router 约定、vinext/Vite、TypeScript、Tailwind CSS 4；运行于 Cloudflare Workers，D1 保存结构化数据，R2 保存 Markdown 原文，Drizzle 管理 schema 和迁移文件。

- [开发代理与开发者指南](AGENTS.md)：源码地图、业务约束、测试分流、修改边界。
- [历史设计与计划](docs/superpowers/)：理解早期设计，不作为当前功能清单。
- [1.0 历史验证记录](docs/release/review-portal-1-0-validation.md)：仅代表记录日期的版本，导出格式和测试数量等以当前代码为准。

修改功能、运行命令或配置时，请同步更新本文和开发指南中受影响的说明。

## 反馈与贡献

项目由 [zhoupeixian](https://github.com/zhoupeixian) 及仓库贡献者维护。使用问题、缺陷和功能建议请通过 [GitHub Issues](https://github.com/zhoupeixian/zherp-svn-review-portal/issues) 提交，先检索是否已有相同问题。

- 缺陷报告请包含版本或提交号、运行环境、复现步骤、预期与实际结果，以及脱敏后的日志或截图。不要公开同步密钥、访问令牌或业务敏感原文。
- 开发前阅读 [AGENTS.md](AGENTS.md)，较大的功能或行为调整先在 Issue 中说明范围；提交 PR 时保持修改集中，并列明验证命令、结果及未验证部分。
- 文档修改检查链接、命令和配置说明；代码修改运行相关回归测试，并按影响补充类型检查、lint、构建和浏览器验证。

## 许可证

当前仓库尚未提供 `LICENSE` 文件，也未声明开源许可证。请勿将其视为已按 MIT、Apache-2.0 等许可证授权的项目；复用或分发前，请联系维护者确认授权范围。
