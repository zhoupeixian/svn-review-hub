# ZHERP SVN 审查日志站 1.0 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有审查日志展示 MVP 升级为团队可协作的 1.0：公开阅览、匿名更新问题状态和处理说明、日志归档/恢复与批量归档、服务端查询分页、CSV 导出及同步健康提示。

**Architecture:** 保留 Cloudflare D1（结构化索引与协作状态）+ R2（原始 Markdown）双存储。导入时以稳定问题键合并，绝不覆盖协作状态和历史；日志按“当前/归档”分区。页面仅请求服务端游标分页的数据，前端通过 URL 保存过滤条件并按需追加下一页。

**Tech Stack:** Next.js/Vinext、TypeScript、Drizzle ORM、Cloudflare D1/R2、Vitest、现有 ChatGPT 管理员认证。

**Spec:** `docs/superpowers/specs/2026-08-27-review-portal-1-0-design.md`

## 全局约束

- 审查原始数据（问题标题、严重级别、关联 Revision、原文）只读；任何接口与界面都不得提供修改或删除这些字段的能力。
- 所有人可匿名更新问题的状态和处理说明；操作历史记录时间、前后状态和说明，但不伪造或存储操作者身份。
- 仅现有 ChatGPT 管理员可归档、恢复及批量归档。归档日志和其中问题不得出现在首页或当前问题视图。
- 归档不受未关闭问题阻塞；执行前必须展示将影响的日志数、问题数和待处理问题数。
- 所有读列表必须在服务端过滤、排序和游标分页；默认 20 条，最大 50 条。不得在客户端加载全量日志或问题后再筛选。
- 保持自动同步脚本与管理员上传入口兼容；重复导入同一日志必须保留已存在问题的状态、说明和事件历史。
- 限制匿名更新输入、按 Cloudflare 请求 IP 的哈希值做短窗口限流且不持久化原始 IP；用版本号拒绝并发覆盖。
- 继续使用原生 `<a>` 做站内导航，禁止重新引入 `next/link`，避免已修复的线上点击失效问题回归。
- 不实现账号/SSO、身份审计、指派、截止日期/提醒、个人工作台或 AI 语义检索。

---

## Task 1：建立可测试的生命周期与查询契约

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `lib/issue-lifecycle.ts`
- Create: `lib/review-query.ts`
- Create: `test/issue-lifecycle.test.ts`
- Create: `test/review-query.test.ts`

- [ ] **步骤 1：先写失败测试，固定状态、输入与游标协议。**
  - `IssueStatus` 仅允许：`open`、`pending_review`、`resolved`、`invalid`、`by_design`、`deferred`。
  - `parseIssueUpdateInput` 要求非空 `status`、`version` 为非负整数、`note` 去首尾空格后最长 1,000 字符；错误信息固定为可供 API 使用的中文消息。
  - 游标仅包含排序日期/更新时间和整数 id，编码/解码必须互逆；伪造或不完整游标必须被拒绝，不能静默退回到首页。
  - 在测试中覆盖：`resolved` 正常解析、`closed` 被拒绝、1,001 字符说明被拒绝、游标往返、无效游标。

  ```ts
  expect(parseIssueUpdateInput({ status: 'resolved', note: '已在 r53701 修复', version: 3 }))
    .toEqual({ status: 'resolved', note: '已在 r53701 修复', version: 3 });
  expect(() => parseIssueUpdateInput({ status: 'closed', note: '', version: 1 }))
    .toThrow('不支持的问题状态');
  ```

- [ ] **步骤 2：执行测试并确认契约尚未实现。**

  ```powershell
  npm run test -- --run test/issue-lifecycle.test.ts test/review-query.test.ts
  ```

  预期：测试因模块或实现缺失而失败；记录失败原因，不以跳过测试代替。

- [ ] **步骤 3：以最小纯函数实现契约。**
  - 在 `lib/issue-lifecycle.ts` 导出状态常量、中文标签映射、输入解析和 `issueKey` 规范化辅助函数。
  - 在 `lib/review-query.ts` 导出 `PageCursor`、`PageResult<T>`、base64url 游标编码解码、20/50 条分页参数规范化函数。
  - 为 `package.json` 增加 `test` 脚本，以及 `vitest`、`@cloudflare/vitest-plugin`、`@testing-library/react`、`@testing-library/user-event` 和 `jsdom` 开发依赖。
  - `vitest.config.ts` 使用当前 Cloudflare Workers Vitest 插件：纯函数测试运行在 Node；D1、R2、路由测试运行在 Miniflare Workers 环境并通过 `applyD1Migrations` 加载迁移；TSX 交互测试显式使用 jsdom。

- [ ] **步骤 4：验证测试、类型检查和格式。**

  ```powershell
  npm run test -- --run test/issue-lifecycle.test.ts test/review-query.test.ts
  npm run build
  git diff --check
  ```

- [ ] **步骤 5：提交这一独立基础。**

  ```powershell
  git add package.json package-lock.json vitest.config.ts lib/issue-lifecycle.ts lib/review-query.ts test/issue-lifecycle.test.ts test/review-query.test.ts
  git commit -m "test: add review lifecycle contracts"
  ```

## Task 2：扩展 D1 模型并迁移历史数据

**Files:**
- Modify: `db/schema.ts`
- Modify: `lib/reviews.ts`
- Create: `drizzle/00xx_review_portal_1_0.sql`（由 Drizzle 生成，实际编号以现有 journal 为准）
- Modify: `drizzle/meta/_journal.json`（由 Drizzle 生成）
- Create: `test/review-schema-contract.test.ts`

- [ ] **步骤 1：编写失败的 schema/回填契约测试。**
  - 验证新问题默认 `open`、`source_current=1`、`version=0`，历史问题有稳定 `issue_key`。
  - 验证事件表保存 `from_status`、`to_status`、`note`、`created_at`，且问题记录不能缺失关联日志。
  - 验证一个 `(review_id, issue_key)` 始终只对应一条问题记录；问题撤回后再次出现时必须重新激活原记录，而不是新增重复记录。

- [ ] **步骤 2：执行测试，确认现有 schema 无法满足。**

  ```powershell
  npm run test -- --run test/review-schema-contract.test.ts
  ```

- [ ] **步骤 3：更新 Drizzle schema 与生成迁移。**
  - `review_logs` 增加 nullable `archived_at`。
  - `review_issues` 增加 `issue_key`、`status`、`status_note`、`status_updated_at`、`source_current`、`version`；原始字段仍保留并视为只读。
  - 新建 `review_issue_events`：`id`、`issue_id`、`from_status`、`to_status`、`note`、`created_at`。
  - 新建短期 `anonymous_update_limits` 表：仅存 `client_hash`、窗口开始时间和计数；每次限流检查清理过期窗口，不存原始 IP 或可识别身份字段。
  - 新建短期 `archive_operation_previews` 表：随机 `token`、管理员用户 id、已解析的日志 id JSON、三项影响数量、创建/过期时间；确认时仅消费该快照，过期后删除，避免按筛选确认时误包含新日志。
  - 新建 FTS5 虚表 `review_search`，索引日志标题、概览、范围、Revision、作者、提交说明、问题标题/详情和当前处理说明；不索引原始 Markdown 二进制对象。
  - 添加索引：`review_logs(archived_at, log_date, id)`、`review_issues(status, source_current, review_id)`、`review_issue_events(issue_id, created_at)`，以及 `issue_key` 的部分唯一索引。

  ```sql
  CREATE UNIQUE INDEX idx_review_issues_review_issue_key
    ON review_issues(review_id, issue_key)
    WHERE issue_key IS NOT NULL;
  ```

  - 在 `ensureReviewSchema()` 增加幂等旧库升级与回填：缺失状态补为 `open`，缺失 `source_current` 补为 1，缺失版本补为 0，使用稳定键填补 `issue_key`；不得删除旧问题或事件。
  - 使用现有 Drizzle 命令生成 SQL，禁止手改 journal 编号。

  ```powershell
  npm run db:generate -- --name review_portal_1_0
  ```

- [ ] **步骤 4：在本地 D1/迁移测试库执行迁移与回填。**
  - 对同一份旧库连续执行两次，第二次不得新增重复 `issue_key` 或改变已有状态。
  - 检查 `PRAGMA table_info`、索引和 FTS 表存在；保存迁移输出。

- [ ] **步骤 5：运行验证并提交。**

  ```powershell
  npm run test -- --run test/review-schema-contract.test.ts
  npm run build
  git diff --check
  git add db/schema.ts lib/reviews.ts drizzle test/review-schema-contract.test.ts
  git commit -m "feat: add review lifecycle storage"
  ```

## Task 3：实现当前与归档的服务端查询、全文检索和分页

**Files:**
- Modify: `lib/reviews.ts`
- Modify: `lib/review-query.ts`
- Create: `test/review-repository-query.test.ts`

- [ ] **步骤 1：写 repository 失败测试。**
  - `getReviewPage({ scope: 'active' })` 只返回 `archived_at IS NULL` 的日志，按 `log_date DESC, id DESC` 排序，含 `items`、`nextCursor`、`hasMore`。
  - `getReviewPage` 在当前或归档范围内支持日期、作者、Revision、严重级别、问题状态和关键词过滤；问题状态过滤使用参数化 `EXISTS` 子查询，不能把原始问题详情载入列表。
  - `getIssuePage` 必须按 `scope=active|archived` 连接对应日志、默认 `source_current=1`，支持状态/严重级别/作者/Revision/关键词并按 `status_updated_at DESC, id DESC` 游标分页。
  - 全文检索词通过参数绑定进入 FTS5 或安全降级的 `LIKE` 查询，测试不得出现拼接用户输入的 SQL。

- [ ] **步骤 2：执行失败测试。**

  ```powershell
  npm run test -- --run test/review-repository-query.test.ts
  ```

- [ ] **步骤 3：在 `lib/reviews.ts` 增加查询接口。**
  - 导出 `ReviewScope`、`ReviewListFilters`、`IssueListFilters` 与 `PageResult<T>`；默认 `limit=20`，接口收到更大值时截断为 50。
  - `getReviewSummaries()` 改为复用 `getReviewPage`，但保留兼容调用方所需的最小适配，随后逐页替换调用方，避免一次性载入全表。
  - `getReviewDetail()` 允许读取当前或归档详情；只有点击详情时读取 R2 Markdown。
  - 建立 `rebuildReviewSearch(reviewId)`，每次导入完成后刷新该日志索引。

- [ ] **步骤 4：补齐边界验证。**
  - 空结果仍返回稳定结构与 `hasMore=false`。
  - 关键词、日期、作者和状态组合时结果不得跨越当前/归档分区。
  - 删除不存在的 FTS 行后重建必须恢复索引，不影响其他日志。

- [ ] **步骤 5：运行验证并提交。**

  ```powershell
  npm run test -- --run test/review-repository-query.test.ts
  npm run build
  git diff --check
  git add lib/reviews.ts lib/review-query.ts test/review-repository-query.test.ts
  git commit -m "feat: query review records by scope"
  ```

## Task 4：重构导入合并，保护已有处理状态

**Files:**
- Modify: `lib/review-parser.ts`
- Modify: `lib/reviews.ts`
- Modify: `scripts/sync-local-reviews.mjs`（仅在需要传递来源时间或同步结果时）
- Create: `test/review-ingestion.test.ts`

- [ ] **步骤 1：以同一日志两次导入写失败测试。**
  - 首次导入创建两个问题，均为 `open`。
  - 将第一个问题模拟更新为 `resolved` 并写入事件后，第二次导入同一个 Markdown，状态、说明、版本和事件数必须不变。
  - 新增的源问题必须创建为 `open`；源文件已不存在的问题仅标为 `source_current=0`，保留历史且不进入当前问题列表。
  - 严重级别、关联 Revision 或标题的空格、大小写与排列格式差异不得导致稳定键无谓变化；不同标题或关联 Revision 的问题不得被错误合并。

- [ ] **步骤 2：运行测试确认旧的“先 DELETE 再 INSERT”实现会失败。**

  ```powershell
  npm run test -- --run test/review-ingestion.test.ts
  ```

- [ ] **步骤 3：实现稳定键和 upsert 导入。**
  - 从标准化的严重级别、标题和关联 Revision 计算 `issue_key`，不以数据库自增 id 作为源身份。
  - 对目标日志的现有问题先设 `source_current=0`，再按 `(review_id, issue_key)` upsert 当前解析到的问题；只更新源字段与 `source_current`，不得更新 `status`、`status_note`、`version` 或历史事件。
  - 新问题插入 `open`、空说明、版本 0；导入完成后重建该日志的 FTS。
  - 保持 R2 原文先成功写入、D1 事务后更新元数据的失败语义；失败时返回明确错误，不能部分清空旧记录。

- [ ] **步骤 4：检查自动同步及管理员上传兼容。**
  - 用现有 `sync-local-reviews.mjs` 向测试端点同步一次，再同步同一文件一次。
  - 确认返回结果有创建/更新数和解析问题数，且不要求管理员 Cookie。

- [ ] **步骤 5：验证并提交。**

  ```powershell
  npm run test -- --run test/review-ingestion.test.ts
  npm run build
  git diff --check
  git add lib/review-parser.ts lib/reviews.ts scripts/sync-local-reviews.mjs test/review-ingestion.test.ts
  git commit -m "feat: preserve issue state during review sync"
  ```

## Task 5：提供匿名状态更新与受限 API

**Files:**
- Modify: `app/api/reviews/route.ts`
- Create: `app/api/issues/route.ts`
- Create: `app/api/issues/[id]/status/route.ts`
- Create: `app/api/reviews/archive/route.ts`
- Create: `app/api/reviews/restore/route.ts`
- Create: `lib/anonymous-rate-limit.ts`
- Create: `test/issue-status-api.test.ts`
- Create: `test/archive-api.test.ts`

- [ ] **步骤 1：为路由写失败测试。**
  - `PATCH /api/issues/:id/status` 接受 `{ status, note, version }`；只能变更状态、说明、更新时间和版本，并插入一条事件。
  - 错误输入返回 400；不存在、非当前源问题或已归档日志的问题返回 404；版本冲突返回 409 且带回当前版本；10 分钟超过 10 次匿名更新返回 429。
  - 管理员归档/恢复及批量归档必须调用现有 `allowAdministrator`；非管理员返回 403。
  - 归档预览返回 `previewToken`、`reviewCount`、`issueCount`、`openIssueCount`；确认只能消费对应管理员的未过期 token，范围变化返回 409，归档不因待处理问题失败。

- [ ] **步骤 2：执行失败测试。**

  ```powershell
  npm run test -- --run test/issue-status-api.test.ts test/archive-api.test.ts
  ```

- [ ] **步骤 3：最小化实现接口和并发控制。**
  - `GET /api/reviews` 映射列表过滤和游标；保持现有 `POST /api/reviews` 的同步密钥和管理员上传语义不变。
  - `GET /api/issues` 支持 `scope=active|archived`，默认只返回未归档、`source_current=1` 的当前问题；归档库显式传 `scope=archived`。
  - 用 D1 条件更新防止覆盖：

  ```sql
  UPDATE review_issues
  SET status = ?, status_note = ?, status_updated_at = ?, version = version + 1
  WHERE id = ? AND source_current = 1 AND version = ?;
  ```

  - 仅当更新影响一行时插入事件。事件记录为匿名，不增加姓名、Cookie 指纹或原始 IP。
  - 以 `CF-Connecting-IP` 的不可逆哈希作为限流键，使用 D1 短期窗口表；窗口过期后删除，日志与 API 响应不输出原始 IP。
  - `POST /api/reviews/archive` 接受 `mode: 'preview'|'confirm'`：预览接收显式 `ids` 或已验证过滤条件，解析并保存精确日志 id 快照，返回 `previewToken`、`reviewCount`、`issueCount`、`openIssueCount`；确认只接受未过期 token，在同一事务中验证所有日志仍为当前后写入 `archived_at`，数量变化则返回 409 并要求重新预览。
  - `POST /api/reviews/restore` 只清空指定已归档日志的 `archived_at`。

- [ ] **步骤 4：执行安全和回归验证。**
  - 手工检查 API 响应与数据库更新列，确认原始问题字段未出现在 PATCH 可写白名单。
  - 并发提交相同 `version` 两次，仅一条成功，另一条收到 409。
  - 无 `CF-Connecting-IP` 时使用固定匿名桶，仍不绕开限流。

- [ ] **步骤 5：运行验证并提交。**

  ```powershell
  npm run test -- --run test/issue-status-api.test.ts test/archive-api.test.ts
  npm run build
  git diff --check
  git add app/api lib/anonymous-rate-limit.ts test/issue-status-api.test.ts test/archive-api.test.ts
  git commit -m "feat: add anonymous issue updates and archiving api"
  ```

## Task 6：交付当前日志首页、问题看板与详情协作体验

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/review-explorer.tsx`
- Modify: `app/reviews/[id]/page.tsx`
- Create: `app/issues/page.tsx`
- Create: `app/issues/issue-explorer.tsx`
- Create: `app/components/issue-status-panel.tsx`
- Create: `app/components/paged-load-more.tsx`
- Modify: `app/globals.css`（仅增加本功能所需样式）
- Create: `test/ui-current-review-flow.test.tsx`

- [ ] **步骤 1：写 UI 行为测试。**
  - 首页只渲染 API 返回的当前日志；统计卡只统计未归档日志和其中当前源问题。
  - 问题看板可按 URL 中的 `status`、`severity`、`author`、`revision`、`from`、`to`、`q` 恢复筛选；点击“加载更多”追加下一页且不重置已有项。
  - 详情中的状态面板提交成功后显示新状态、处理说明、更新时间和时间线；409 时保留用户填写的说明并提示重新加载。
  - 每个问题有 `id="issue-<数据库id>"`，从列表跳转至详情可直接定位。

- [ ] **步骤 2：运行失败测试。**

  ```powershell
  npm run test -- --run test/ui-current-review-flow.test.tsx
  ```

- [ ] **步骤 3：实现当前协作浏览。**
  - 首页服务端请求 `scope=active` 首页，客户端 `review-explorer` 仅通过 API 请求下一页；不再把所有摘要注入页面；统计明确显示当前日志数、待处理/待确认问题数及 P1/P2 风险数。
  - 新建 `/issues` 当前问题看板，默认仅显示“待处理、待确认”问题，卡片或表格同时显示状态、严重级别、日志日期、作者、关联 Revision、问题摘要和处理说明；任何行均可链接到原日志锚点。
  - 在详情页只将状态和说明作为可编辑控件；状态文案采用任务 1 的中文映射，提供“待处理、待确认、已解决、误判、设计如此、暂不处理”。
  - 用 `URLSearchParams` 读写筛选条件，并生成可复制的当前筛选链接。
  - 所有站内跳转保持原生 `<a href>`；失败、加载中、无结果和加载完毕均有清晰中文状态。

- [ ] **步骤 4：验证可访问性和性能边界。**
  - 表单控件具有关联标签、键盘可提交、焦点可见；状态颜色不能是唯一含义。
  - 在模拟 1,000 条日志/10,000 个问题的数据下，首屏请求最多读取 20 条结果并不含 R2 Markdown 正文。
  - 浏览器验证：首页、问题看板、详情锚点、加载更多、状态变更及 409 提示均可完成。

- [ ] **步骤 5：运行验证并提交。**

  ```powershell
  npm run test -- --run test/ui-current-review-flow.test.tsx
  npm run build
  git diff --check
  git add app/page.tsx app/review-explorer.tsx app/reviews app/issues app/components app/globals.css test/ui-current-review-flow.test.tsx
  git commit -m "feat: add current review collaboration views"
  ```

## Task 7：交付归档库、恢复与批量归档管理

**Files:**
- Create: `app/archive/page.tsx`
- Create: `app/archive/archive-explorer.tsx`
- Modify: `app/admin/page.tsx`
- Create: `app/admin/archive-manager.tsx`
- Create: `test/ui-archive-flow.test.tsx`

- [ ] **步骤 1：写归档与批量操作失败测试。**
  - `/archive` 仅查询 `scope=archived`，可按日期、作者、Revision、关键词及问题状态筛选和游标分页。
  - 管理员可勾选多条当前日志或按当前筛选归档，预览准确的影响数量，确认后才调用携带 `previewToken` 的归档接口。
  - 归档完成后首页/问题看板不含这些记录；恢复后日志与源问题恢复到当前视图，原有状态与事件不变。
  - 无管理员会话不能看到或调用管理操作；归档库仍保持公开只读。

- [ ] **步骤 2：执行失败测试。**

  ```powershell
  npm run test -- --run test/ui-archive-flow.test.tsx
  ```

- [ ] **步骤 3：实现归档体验。**
  - `/archive` 使用与当前日志相同的服务端筛选/分页组件，但明确标记为“归档库”；详情页可查看归档原文与历史，不能匿名改状态。
  - 管理页增加归档管理器：列表选择、全选当前页、清空选择、影响预览、明确确认按钮、成功/失败反馈和恢复单条日志。
  - 批量选择只基于显式 id；若以筛选全部归档，必须展示服务端计算的总数，并让管理员再次确认后执行。
  - 归档和恢复后使当前列表、归档列表和问题统计重新请求，不能仅在本地乐观隐藏。

- [ ] **步骤 4：浏览器验证。**
  - 用一个包含待处理问题的日志执行单条归档和恢复。
  - 用至少两条日志执行批量归档；在首页、问题页和归档库分别复查可见性。

- [ ] **步骤 5：运行验证并提交。**

  ```powershell
  npm run test -- --run test/ui-archive-flow.test.tsx
  npm run build
  git diff --check
  git add app/archive app/admin test/ui-archive-flow.test.tsx
  git commit -m "feat: add archived review library"
  ```

## Task 8：提供 CSV 导出、同步健康提示和共享筛选

**Files:**
- Create: `app/api/issues/export/route.ts`
- Create: `app/api/reviews/export/route.ts`
- Modify: `lib/reviews.ts`
- Modify: `app/page.tsx`
- Modify: `app/issues/issue-explorer.tsx`
- Modify: `app/archive/archive-explorer.tsx`
- Create: `test/issues-export.test.ts`
- Create: `test/sync-health.test.ts`

- [ ] **步骤 1：写导出和健康数据失败测试。**
  - 使用与 `/api/issues` 相同的过滤参数导出当前问题；归档问题不能混入默认导出。
  - 使用与 `/api/reviews` 相同的过滤参数导出当前或归档日志摘要；输出不读取 R2 Markdown 正文。
  - CSV 包含问题键、状态、处理说明、更新时间、严重级别、标题、Revision、作者、日志日期和详情链接；字段中换行、逗号和双引号必须正确转义。
  - 返回 UTF-8 BOM、`text/csv; charset=utf-8` 和带日期的下载文件名。
  - 健康指标包含最近成功自动同步时间、最近日志日期、最近 Revision、日志数、当前问题数、待处理数与解析失败/零问题提示。

- [ ] **步骤 2：执行失败测试。**

  ```powershell
  npm run test -- --run test/issues-export.test.ts test/sync-health.test.ts
  ```

- [ ] **步骤 3：实现导出与健康卡。**
  - `GET /api/issues/export` 和 `GET /api/reviews/export` 均复用已验证的筛选解析，不复制一套筛选 SQL；导出采用分页流式或设定安全上限并在界面明确说明。
  - 首页展示只读的同步健康卡和异常提示；以现有 `sync_mode='automation'` 与 `updated_at` 查询最近成功自动同步，管理员上传不得伪装成自动同步。
  - 当前问题和归档库筛选器提供“复制当前筛选链接”与“导出当前筛选”操作。

- [ ] **步骤 4：验证边界。**
  - 用含中文、换行和公式前缀字符的处理说明生成 CSV；对以 `=`, `+`, `-`, `@` 开头的单元格做文本前缀保护，避免表格公式注入。
  - 导出、健康卡和筛选链接都不暴露同步密钥、管理员信息或原始 IP。

- [ ] **步骤 5：运行验证并提交。**

  ```powershell
  npm run test -- --run test/issues-export.test.ts test/sync-health.test.ts
  npm run build
  git diff --check
  git add app/api/issues/export app/api/reviews/export app/page.tsx app/issues app/archive lib/reviews.ts test/issues-export.test.ts test/sync-health.test.ts
  git commit -m "feat: add review export and sync health"
  ```

## Task 9：全链路回归、迁移演练和发布门禁

**Files:**
- Modify only if validation exposes a direct defect: the smallest affected implementation/test file
- Create: `docs/release/review-portal-1-0-validation.md`

- [ ] **步骤 1：准备可重复的验证数据。**
  - 导入一份含多严重级别、多 Revision 和至少三个问题的 Markdown；其中一个问题改为 `resolved`，一个改为 `by_design`，保留一个 `open`。
  - 重复导入同一文件，再导入移除一个问题且新增一个问题的版本；记录问题键、状态、说明、版本和事件数。

- [ ] **步骤 2：运行自动验证。**

  ```powershell
  npm run test -- --run
  npm run build
  git diff --check
  ```

  - 必须无失败测试、构建成功、无 diff 空白错误；若任一步失败，先补最小回归测试并修复，再从本步骤重跑。

- [ ] **步骤 3：迁移演练。**
  - 从 1.0 前的 D1 schema 副本执行 migration 和 `ensureReviewSchema()` 两次。
  - 确认无重复问题、无状态丢失、无历史事件丢失，迁移不删除 review_logs/review_issues/R2 原文。

- [ ] **步骤 4：浏览器验收与线上回归。**
  - 验收匿名状态更新、说明、冲突提示、首页排除归档、问题看板筛选/分页、详情锚点、归档搜索、批量归档/恢复、CSV 和同步健康提示。
  - 在已部署站点复验首页、历史、管理、详情的原生导航，确保不出现点击无反应。
  - 以无管理员会话复验：可浏览、可匿名更新当前问题、不能归档或恢复；以管理员会话复验归档操作。

- [ ] **步骤 5：记录发布证据并提交。**
  - 在 `docs/release/review-portal-1-0-validation.md` 写入所用样本、migration 版本、测试/构建命令与结果、浏览器验收日期、已知限制（匿名更新无可靠操作者身份）。不得记录密钥、Cookie 或个人 IP。

  ```powershell
  git add docs/release/review-portal-1-0-validation.md
  git commit -m "docs: record review portal 1.0 validation"
  ```

## 发布后验收清单

- [ ] 当前首页只显示未归档日志；其中问题总览仅含未归档且 `source_current=1` 的问题。
- [ ] 匿名用户只可修改状态和处理说明，且每次成功修改都有无身份的时间线事件。
- [ ] 状态可在六种已批准状态之间任意切换并可重新打开。
- [ ] 同一日志反复同步后，匹配问题的状态、说明、版本和历史不丢失。
- [ ] 管理员可在有待处理问题时单条/批量归档，公开归档库可搜索、分页、查看详情；恢复后数据完整回到当前视图。
- [ ] 所有日志/问题列表使用服务端过滤与游标分页，首屏没有全量 Markdown/R2 读取。
- [ ] CSV 与 URL 筛选一致，含中文且不触发表格公式；同步健康卡能区分自动同步和管理员上传。
- [ ] 生产站点核心导航、匿名更新、管理员归档和归档浏览均实测可用。

## 实施顺序与依赖

任务 1 是所有协议与测试基础；任务 2 依赖任务 1；任务 3 和任务 4 依赖任务 2；任务 5 依赖任务 3、4；任务 6、7、8 均依赖任务 5；任务 9 在所有前序任务之后执行。每个任务只在前一任务的测试和构建证据为绿色后开始。
