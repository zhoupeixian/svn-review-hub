# 开发代理与开发者指南

本文是仓库根目录的代理开发指引，适用于整个项目；若子目录新增 `AGENTS.md`，修改该目录时还需读取其更具体的约定。产品使用、配置与同步操作见 [README.md](README.md)。

项目将外部 SVN 审查 Markdown 导入多项目门户：React/TypeScript 页面使用 Next.js App Router 约定，经 vinext/Vite 运行于 Cloudflare Workers；D1 存储结构化记录，R2 保存原文。主要工作包括解析和导入、问题协作、项目隔离与管理。

## 开始工作

1. 阅读任务和适用的上层指令；使用中文沟通，中文文件保存为 UTF-8。
2. 执行 `git status --short --branch`，确认工作目录、分支与已有改动。不要覆盖他人的工作，也不要修改 `.worktrees` 内其他工作树。
3. 按下方源码地图阅读相关实现和测试，再确定最小修改范围。历史 PR、设计稿和验证记录只能提供背景，以当前代码和实测为准。
4. 新环境先 `npm ci`，避免 `npx` 临时安装不同版本的测试工具。修改后先运行相关测试，再按影响执行类型检查、lint 和构建。

不擅自提交、推送、创建或合并 PR、部署、执行远端数据写入。删除文件或目录前须确认目标并获得用户确认，使用回收站。普通本地修改和验证在已授权范围内继续完成，无需为细枝末节反复确认。

## 代码约定

- 沿用现有 TypeScript 严格模式、ES modules、两空格缩进、单引号和分号；以相邻文件及 `eslint.config.mjs` 为准，不做无关格式化。
- React 使用函数组件；需要客户端交互的组件才声明 `'use client'`。遵循 `app/` 路由约定，复用 `lib/` 现有业务函数，不在页面中另建一套鉴权或数据访问逻辑。
- SQL 保留绑定参数和项目范围限制；API 参数校验、响应和异常处理遵循同类路由，不通过放宽校验消除测试失败。
- 测试放在 `test/`，命名为 `*.test.ts` 或 `*.test.tsx`，按已有 Vitest 和 Testing Library 写法验证行为。UI 样式沿用 Tailwind 和 `app/globals.css` 的现有模式。
- 不手改 `dist/`、`.next/`、`.vinext/`、`.wrangler/`、`node_modules/` 或 `tsconfig.tsbuildinfo`；不读取或输出真实 `.env`、`.dev.vars` 密钥，配置说明以样例文件为入口。

## 源码地图

| 位置 | 职责与阅读入口 |
| --- | --- |
| `app/page.tsx`、`app/projects/[slug]/` | 项目目录、项目日志/问题/归档/管理/详情页面 |
| `app/components/` | 项目切换、状态面板、筛选分享等 UI 组件 |
| `app/review-explorer.tsx`、`app/issues/issue-explorer.tsx`、`app/archive/archive-explorer.tsx` | 日志、问题与归档的交互和分页 |
| `app/api/projects/[slug]/` | 按项目限定的查询、状态更新、上传、归档、恢复、导出与原文 API |
| `app/api/reviews/route.ts` | 旧 ZHERP 查询兼容入口及带 `projectSlug` 的自动同步入口 |
| `app/api/admin/` | 全站项目管理和审计 API |
| `lib/review-parser.ts` | Markdown 解析、Revision 范围证据、问题和严重级计数 |
| `lib/reviews.ts` | 运行时 schema 升级、项目同步密钥、导入合并、查询、同步健康、管理员登记 |
| `lib/review-query.ts`、`lib/review-filters.ts` | 查询参数及筛选语义 |
| `lib/issue-lifecycle.ts`、`lib/issue-status-update.ts`、`lib/anonymous-rate-limit.ts` | 状态、版本冲突、匿名来源摘要及限流 |
| `lib/project-administration.ts` | 项目生命周期、密钥管理、删除和审计 |
| `lib/project-api.ts`、`lib/global-admin-api.ts`、`lib/project-review-*.ts` | API 边界与上传/导出共用逻辑 |
| `app/chatgpt-auth.ts` | 读取托管平台身份头及生成登录跳转 |
| `db/schema.ts`、`drizzle/` | Drizzle 表定义和迁移历史 |
| `vite.config.ts`、`.openai/hosting.json` | vinext、Sites、Cloudflare 与本地绑定 |
| `vitest.config.ts`、`test/apply-migrations.ts` | 测试运行环境、D1 测试迁移 |
| `scripts/` | 本地日志同步与生产只读冒烟命令 |

## 数据流和必须保留的行为

- 自动化先生成 Markdown，同步脚本上传；服务端鉴权、解析和接收校验后，R2 保存原文，D1 保存日志、Revision、问题及事件。不要用内存聚合替换已有数据库筛选和分页。
- 项目是数据边界。查询、详情、状态更新、归档预览/确认、导出和原文读取都要验证归属；旧无项目路径只对应 `zherp`，不能凭 ID 访问其他项目。保留跨项目 404 和无副作用的回归约束。
- 日志按项目与 `sourceKey` 合并；问题稳定键用于保留状态、说明、版本与事件。源文删除的问题保留历史并设为非当前，重新出现时恢复为当前；不要整批删除重建问题。
- 严重级计数来自解析出的 `issues`，不能从“3 项 P1”之类摘要推测。零问题告警检查最新自动同步日志实际持久化且 `source_current = 1` 的问题；手工上传不能冒充自动同步时间。
- 状态更新必须保留版本并发检查、事件写入和匿名限流。匿名来源使用服务端密钥做 HMAC 摘要，不代表登录身份；归档内容只读。
- `ensureReviewSchema()` 必须可重复执行并兼容已有数据。修改表结构需同时核对 `db/schema.ts`、`drizzle/` 和运行时升级逻辑，不能只修改一处。`npm run db:generate` 只生成迁移，不等于已应用到部署数据库。
- 通用 schema 初始化不能要求同步主密钥可用。旧 `REVIEW_SYNC_KEY` 的一次迁移在 `authorizeProjectSync()` 路径执行，普通读取和手工上传不能被旧密钥迁移阻塞。
- `REVIEW_SYNC_MASTER_KEY` 只供服务端加密项目密钥；同步客户端持有单项目密钥。不要输出、提交密钥或在业务审计中保存明文/密文。项目管理与相应审计的事务行为、项目删除后审计保留都需维持。
- 身份来自 Sites 的可信代理头，不能将可任意伪造头的直连服务视为已受保护的生产登录系统。管理员首次登记行为见 README 和 `allowAdministrator()`。

修改解析器时，用真实支持格式和生产接收链路建立回归；仅验证解析函数不代表持久化计数正确。修复旧数据需单独确认重导入或迁移范围，代码更新不会自动重写所有历史记录。

## 测试与验证

在仓库根目录执行以下 PowerShell 命令；需已安装 `rg`（ripgrep）。按当前测试文件的运行时导入进行分流，旧管理路由测试单独放入有 `@` 别名的 Workers 环境。

```powershell
npm ci

$workerTests = @(rg -l 'cloudflare:test|cloudflare:workers' test -g '*.test.ts')
npx vitest run --mode workers --exclude '**/.worktrees/**' @workerTests test/legacy-admin-route.test.ts

$nodeTests = @(rg --files-without-match 'cloudflare:test|cloudflare:workers' test -g '*.test.ts' -g '*.test.tsx' | Where-Object { $_ -notmatch 'legacy-admin-route' })
npx vitest run @nodeTests

npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

逐项检查退出码；PowerShell 不会因上一个原生命令失败而自动停止。新增测试时重新核对分流列表，间接依赖 Workers 的测试未必含上述导入字符串，不能只靠脚本推断环境。

| 修改范围 | 优先测试 |
| --- | --- |
| 解析、接收、重复导入 | `review-parser-corpus`（Node）；`review-ingestion`、`review-schema-contract`（Workers） |
| 查询、同步健康 | `review-query`（Node）；`review-repository-query`、`sync-health`（Workers） |
| 项目切换、看板、归档交互 | `ui-current-review-flow`、`ui-archive-flow`（jsdom） |
| 状态、跨项目隔离 | `issue-lifecycle`（Node）；`issue-status-api`、`project-issue-collaboration`（Workers） |
| 项目管理、归档、删除 | `ui-project-admin`（jsdom）；`project-admin-api`、`project-log-admin`、`project-deletion`、`archive-api`（Workers） |
| 同步、密钥、冷启动 | `project-sync`、`project-sync-schema-init`（Workers）；`sync-local-reviews-command`（Node） |
| 浏览、导出、旧路由、冒烟 | `project-browsing-api`、`issues-export`、`legacy-admin-route`（Workers）；`smoke-production-command`（Node） |

表中名称对应 `test/<名称>.test.ts`，UI 文件为 `.test.tsx`。例如：

```powershell
npx vitest run test/review-parser-corpus.test.ts test/ui-current-review-flow.test.tsx
npx vitest run --mode workers --exclude '**/.worktrees/**' test/sync-health.test.ts
```

常见验证陷阱：

- `cloudflare:workers` 无法加载：先检查是否漏用 `--mode workers`，不要改业务实现来适应错误环境。
- Workers 默认发现范围可能混入 `.worktrees` 的旧测试；文件过滤是匹配路径，不保证排除同名旧文件，保留显式 `--exclude`。
- 默认 Node 配置没有 `@` 别名，`legacy-admin-route.test.ts` 会加载失败；当前使用 Workers 模式验证。不要把这一既有配置限制报告为新功能回归。
- 不要用一次默认 `npm test -- --run` 代替上述分流全量检查，也不要把 jsdom 测试全部放进 Workers。
- 依赖漏洞以当前审计结果为准，不要未经任务授权执行 `npm audit fix --force`。

生产构建、jsdom 测试不证明浏览器布局、生产数据修复或线上认证正常。涉及窄屏、键盘交互等改动，应补真实浏览器验收；涉及线上冒烟，使用 README 的命令并报告实际目标和结果。未经执行不要声称部署或线上验证完成。

## 交付和文档维护

- 只修改任务需要的内容，不顺手重构相邻模块、不擅自升级依赖、不编辑生成产物或其他工作树。
- 报告具体行为变化、测试命令/结果、未验证边界及已有故障；不要沿用旧 PR 的测试数量作为当前结果。
- 产品能力、页面入口、配置、操作命令变更时更新 `README.md`；源码职责、业务约束、测试方法变更时更新本文。避免把同一操作说明维护在两处。
- `docs/superpowers/` 和 `docs/release/` 是带日期的历史资料，不覆盖当前实现，也不应被悄悄改写成新版本验证记录。
