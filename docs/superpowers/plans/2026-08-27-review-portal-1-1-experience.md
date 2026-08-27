# ZHERP SVN 审查日志站 1.1 体验与导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline in one session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将审查日志站升级为可舒适阅读、快速检索并可直接在 Excel 分派跟进的 1.1 版本。

**Architecture:** 保持 D1/R2、匿名状态更新、归档和服务端筛选不变。新增 Worker 兼容的 XLSX 写出层，所有导出数据继续从 `getIssueExportRows` 读取；使用根元素主题令牌和一个小型客户端切换器统一全站视觉，页面通过共享筛选/卡片样式收敛信息层级。

**Tech Stack:** Next.js/Vinext、React、TypeScript、Vitest（Node/jsdom 与 Workers 分开运行）、`xlsx-js-style`（Workers 兼容的 XLSX 二进制与单元格样式写出）、Tailwind CSS 4、Cloudflare Workers/D1/R2。

**Spec:** `docs/superpowers/specs/2026-08-27-review-portal-1-1-experience-design.md`

## Global Constraints

- 保持原始审查内容只读、匿名协作者只能更新状态/处理说明、仅管理员可归档/恢复的 1.0 权限边界。
- 保持原生 `<a>` 站内导航；不得改为 `next/link`。
- 筛选、分页和导出复用服务器端过滤，最大导出 1,000 条；不得向客户端载入全量问题。
- “导出当前筛选”固定下载 `.xlsx`，工作表名为“问题跟进”，不在 UI 暴露 CSV。
- 默认主题是“柔和办公”，主题偏好仅使用浏览器 `localStorage`，不写入 D1。
- 不增表、不改迁移、不改自动同步鉴权、归档 API 或匿名状态 API。
- 只做必要测试与一次最终整体回归；不派发子代理、不进行逐任务外部审查。

---

### Task 1: 修复日志计数解析并交付 Excel 跟进工作表

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `lib/review-parser.ts`
- Modify: `lib/reviews.ts`
- Modify: `app/api/issues/export/route.ts`
- Modify: `app/issues/issue-explorer.tsx`
- Modify: `test/review-ingestion.test.ts`
- Modify: `test/issues-export.test.ts`

**Interfaces:**
- Consumes: `parseReviewMarkdown(markdown): ParsedReview`、`getIssueExportRows(filters): Promise<ReviewExportRow[]>`、`parseReviewFilters(url): ReviewListFilters`。
- Produces: `toIssueWorkbook(rows: ReviewExportRow[], origin: string): Uint8Array`；导出路由返回 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` 和 `.xlsx` 文件名。

- [ ] **Step 1: 写入解析与工作表的失败测试。**

  在 `test/review-ingestion.test.ts` 增加下面断言，固定自动上传日志的另一种审查范围文案：

  ```ts
  expect(parseReviewMarkdown([
    '# 日志', '日期：2026-08-27',
    '审查范围：共 24 个 revision，其中 22 个可审查，2 个按默认规则跳过',
  ].join('\n'))).toMatchObject({
    revisionCount: 24, reviewedCount: 22, skippedCount: 2,
  });
  ```

  在 `test/issues-export.test.ts` 用已导入的当前问题调用导出路由，使用 `XLSX.read(await response.arrayBuffer())` 断言：工作表 `问题跟进` 存在，首行是 `严重级别` 至 `详情链接` 的十列，数据行状态为 `待处理`，详情链接单元格有 `l.Target`，且 `!autofilter.ref` 存在。再写一条处理说明为 ` =SUM(A1)` 的记录，断言导出值仍以单引号文本前缀开始。

- [ ] **Step 2: 运行这两个测试，确认新契约尚未满足。**

  ```powershell
  npm test -- --run test/review-ingestion.test.ts test/issues-export.test.ts --mode workers
  ```

  预期：可审查措辞的计数为 0，且导出仍是 CSV 文本/无法读取为 XLSX。

- [ ] **Step 3: 安装最小 XLSX 依赖并实现解析兼容。**

  ```powershell
  npm install xlsx-js-style
  ```

  在 `lib/review-parser.ts` 将计数抽取改为“先匹配 `实际审查`，否则匹配 `可审查`”，跳过数继续匹配 `跳过`：

  ```ts
  const reviewedCount = countFrom(scopeText, /实际审查\s*(\d+)\s*个/i)
    || countFrom(scopeText, /(\d+)\s*个\s*可审查/i);
  const skippedCount = countFrom(scopeText, /(?:跳过|规则跳过)\s*(\d+)\s*个|(?:其中\s*)?(\d+)\s*个[^，。]*跳过/i);
  ```

  将 `countFrom` 扩展为返回匹配中第一个非空数字捕获组，确保两种跳过语序均可读；没有任何计数时仍返回 `0`。

- [ ] **Step 4: 在 `lib/reviews.ts` 写出唯一的 Excel 工作表构造函数。**

  新增 `toIssueWorkbook(rows, origin)`：使用 `xlsx-js-style` 从二维数组创建 `问题跟进`；将状态通过 `ISSUE_STATUS_LABELS` 转为中文；用现有公式防护规则处理每个文本单元格；将详情 URL 规范成 `${origin}/reviews/${reviewId}#issue-${id}`，将显示文本改为“打开详情”。

  为工作表设置以下元数据：

  ```ts
  worksheet['!autofilter'] = { ref: `A1:J${rows.length + 1}` };
  worksheet['!cols'] = [
    { wch: 10 }, { wch: 12 }, { wch: 42 }, { wch: 18 }, { wch: 28 },
    { wch: 13 }, { wch: 24 }, { wch: 42 }, { wch: 20 }, { wch: 14 },
  ];
  ```

  为首行设置加粗、主题底色和浅色文字；为“问题标题”“处理说明”设置换行。二进制写出使用 `XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })`，不使用 Node 文件系统 API。

- [ ] **Step 5: 将导出路由和前端链接改为 XLSX。**

  路由从请求 URL 取得 `origin`，调用 `toIssueWorkbook` 并返回：

  ```ts
  new Response(bytes, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="ZHERP-审查问题-${date}.xlsx"`,
    },
  });
  ```

  问题看板的按钮文本改为“导出 Excel 跟进表”，说明文字改为“导出最多包含 1,000 条问题”。保留既有筛选参数和 `scope=active` 的生成方式。

- [ ] **Step 6: 运行定向测试并提交。**

  ```powershell
  npm test -- --run test/review-ingestion.test.ts test/issues-export.test.ts --mode workers
  npx tsc --noEmit
  git diff --check
  git add package.json package-lock.json lib/review-parser.ts lib/reviews.ts app/api/issues/export/route.ts app/issues/issue-explorer.tsx test/review-ingestion.test.ts test/issues-export.test.ts
  git commit -m "feat: export review issues as Excel workbook"
  ```

### Task 2: 建立全局主题与统一筛选/问题展示层级

**Files:**
- Create: `app/components/theme-switcher.tsx`
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`
- Modify: `app/issues/page.tsx`
- Modify: `app/issues/issue-explorer.tsx`
- Modify: `app/archive/archive-explorer.tsx`
- Modify: `app/components/issue-status-panel.tsx`
- Modify: `app/reviews/[id]/page.tsx`
- Modify: `test/ui-current-review-flow.test.tsx`
- Modify: `test/ui-archive-flow.test.tsx`

**Interfaces:**
- Consumes: 现有 `IssueExplorer`、`ArchiveExplorer` 的 URL 参数、API 请求与 `IssueStatusPanel` 保存逻辑。
- Produces: `ThemeSwitcher` 写入 `document.documentElement.dataset.theme` 和 `localStorage['review-portal-theme']`；共享 CSS 类 `filter-panel`、`issue-card`、`status-panel`、`meta-chip`。

- [ ] **Step 1: 写 UI 失败测试固定主题与筛选交互。**

  在 `test/ui-current-review-flow.test.tsx` 渲染 `ThemeSwitcher`，点击“夜间专注”后断言根元素 `data-theme === 'night'` 和本机存储值为 `night`；重新渲染后断言选择被恢复。

  在现有问题看板测试中断言有“更多条件”按钮；展开后能看到作者、开始日期、结束日期和 Revision；点击“重置”后所有输入为空且请求 URL 只保留默认当前范围。归档测试增加同样的“应用筛选/重置”断言，确保不改变现有防竞态 request id 行为。

- [ ] **Step 2: 运行 UI 测试，确认主题切换器和分组控件缺失。**

  ```powershell
  npm test -- --run test/ui-current-review-flow.test.tsx test/ui-archive-flow.test.tsx
  ```

  预期：找不到主题按钮、“更多条件”与“重置”。

- [ ] **Step 3: 实现主题令牌和切换器。**

  在 `app/globals.css` 以 `:root` 定义柔和办公令牌，并为 `[data-theme='green']` 和 `[data-theme='night']` 覆盖：`--page`、`--surface`、`--surface-muted`、`--border`、`--text`、`--text-muted`、`--accent`、`--accent-contrast`、`--focus`、`--risk-p1`、`--risk-p2`、`--risk-p3`。页面主容器、卡片、边框和交互控件改用令牌；添加 `.filter-panel`、`.issue-card`、`.status-panel`、`.meta-chip` 的紧凑样式和窄屏换行规则。

  `ThemeSwitcher` 使用三个明确文本按钮。首次挂载读取本机存储，默认 `office`；选择后设置 dataset 和本机存储。用 `aria-pressed` 标识当前主题，并在 `app/layout.tsx` 的全局导航中渲染。

- [ ] **Step 4: 以最小结构调整收敛筛选与详情。**

  将问题/归档筛选器改为 `filter-panel`：第一行状态、严重级别、关键词；点击“更多条件”显示日期、作者、Revision；所有表单只写 draft state，点击“应用筛选”后才调用既有 `update`/`applyFilters` 请求。增加“重置”清空 draft 与 active 参数并加载默认列表。

  将问题列表每项改为 `issue-card`，按“风险+状态、标题、辅助元数据、Revision 芯片、打开原日志”顺序渲染。详情页将每项问题的长文本置于可读行宽容器，路径/代码段用 `overflow-x-auto`，状态面板加 `status-panel`，不改状态 API 的 payload 或归档只读判断。

- [ ] **Step 5: 运行 UI 测试、构建并提交。**

  ```powershell
  npm test -- --run test/ui-current-review-flow.test.tsx test/ui-archive-flow.test.tsx
  npm run lint
  npx tsc --noEmit
  npm run build
  git diff --check
  git add app/components/theme-switcher.tsx app/layout.tsx app/globals.css app/issues/page.tsx app/issues/issue-explorer.tsx app/archive/archive-explorer.tsx app/components/issue-status-panel.tsx app/reviews/[id]/page.tsx test/ui-current-review-flow.test.tsx test/ui-archive-flow.test.tsx
  git commit -m "feat: polish review portal reading experience"
  ```

### Task 3: 补主页快捷查询、统计导航与最终回归

**Files:**
- Create: `app/components/home-quick-search.tsx`
- Modify: `app/page.tsx`
- Modify: `app/review-explorer.tsx`
- Modify: `test/ui-current-review-flow.test.tsx`

**Interfaces:**
- Consumes: `/issues` 已支持的 `q`、`revision`、`from` 查询参数和统计 `getCurrentReviewStats()`。
- Produces: 统计导航 URL、`HomeQuickSearch` 的 `GET /issues?...` 跳转，以及 1.1 验证记录。

- [ ] **Step 1: 写主页导航失败测试。**

  在 `test/ui-current-review-flow.test.tsx` 断言：首页的“待处理问题”链接为 `/issues?status=open`、“待确认问题”链接为 `/issues?status=pending_review`、“P1/P2 风险”链接包含风险过滤入口；提交快捷检索 `关键词=质检`、`Revision=53734`、`日期=2026-08-27` 后断言导航目标为 `/issues?q=%E8%B4%A8%E6%A3%80&revision=53734&from=2026-08-27&to=2026-08-27`。

- [ ] **Step 2: 运行主页 UI 测试确认链接/表单尚未实现。**

  ```powershell
  npm test -- --run test/ui-current-review-flow.test.tsx
  ```

  预期：首页统计仍是不可点击容器，缺少快捷检索表单。

- [ ] **Step 3: 实现轻量查询和统计可点击卡片。**

  `HomeQuickSearch` 用普通 GET form 提交到 `/issues`，字段名固定为 `q`、`revision`、`date`；提交时把单一 `date` 转成 `from` 与 `to`，空字段不写入 URL。`app/page.tsx` 把四张卡片渲染为 `<a>`，当前日志跳 `#history`，待处理/待确认跳精确状态，风险卡跳问题页并预置 `severity=P1&severity=P2`。

  `ReviewExplorer` 继续只渲染当前日志分页，但将摘要收敛为单一查看动作、风险芯片与简短元数据，且所有长文本使用现有截断/换行样式。

- [ ] **Step 4: 运行主页定向验证。**

  ```powershell
  npm test -- --run test/ui-current-review-flow.test.tsx
  npx tsc --noEmit
  ```

- [ ] **Step 5: 提交完成版本。**

  ```powershell
  git add app/components/home-quick-search.tsx app/page.tsx app/review-explorer.tsx test/ui-current-review-flow.test.tsx
  git commit -m "feat: add review portal quick navigation"
  ```

### Task 4: 让 P1/P2 风险链接精确表达多级别筛选

**Files:**
- Modify: `app/api/reviews/route.ts`
- Modify: `app/issues/page.tsx`
- Modify: `app/issues/issue-explorer.tsx`
- Modify: `lib/reviews.ts`
- Modify: `test/review-repository-query.test.ts`
- Modify: `test/ui-current-review-flow.test.tsx`
- Modify: `docs/release/review-portal-1-0-validation.md`

**Interfaces:**
- Consumes: 既有 `severity?: 'P1' | 'P2' | 'P3'` 过滤和 `/issues` URL 参数。
- Produces: `severities?: Array<'P1' | 'P2' | 'P3'>`；重复 `severity` 查询参数表示并集，单一参数继续兼容。

- [ ] **Step 1: 写出多风险级别筛选失败测试。**

  在 repository 测试导入 P1、P2、P3 三个当前问题，调用 `getIssuePage({ severities: ['P1', 'P2'] })`，断言只返回 P1/P2。路由参数测试传入 `?severity=P1&severity=P2`，断言 `parseReviewFilters` 返回 `severities: ['P1', 'P2']`；传入 `severity=P4` 返回 400。主页测试断言风险卡 URL 恰为 `/issues?severity=P1&severity=P2`。

- [ ] **Step 2: 运行失败测试。**

  ```powershell
  npm test -- --run test/review-repository-query.test.ts --mode workers
  npm test -- --run test/ui-current-review-flow.test.tsx
  ```

  预期：筛选类型和重复 severity 参数未实现。

- [ ] **Step 3: 以参数化 `IN` 查询实现多级别语义。**

  `parseReviewFilters` 用 `url.searchParams.getAll('severity')` 收集并校验；单个级别同时赋值给兼容字段 `severity`，两个或以上赋值给 `severities`。在 `getIssuePage` 和日志摘要的严重级别 `EXISTS` 条件中优先使用：

  ```ts
  const levels = filters.severities?.length ? filters.severities : filters.severity ? [filters.severity] : [];
  if (levels.length) {
    where.push(`i.severity IN (${levels.map(() => '?').join(', ')})`);
    values.push(...levels);
  }
  ```

  问题页首屏从 `searchParams.getAll('severity')` 构造 `severities`；`IssueExplorer` 在导出和后续请求中保留全部重复 `severity` 参数。状态下拉仍只支持单选，严重级别控件改为“全部/P1/P2/P3/P1 + P2”五个明确选项，后者写入两条 severity 参数。

- [ ] **Step 4: 运行一次完整必要回归并记录结果。**

  ```powershell
  npm test -- --run test/review-repository-query.test.ts --mode workers
  npm test -- --run test/ui-current-review-flow.test.tsx test/ui-archive-flow.test.tsx
  npm test -- --run test/review-ingestion.test.ts test/issues-export.test.ts --mode workers
  npm run lint
  npx tsc --noEmit
  npm run build
  git diff --check
  ```

  在发布验证文档追加 1.1 条目，记录解析 24/22/2、Excel 工作表、主题恢复、筛选/主页跳转和上述命令结果；不得记录密钥、Cookie 或个人 IP。

  ```powershell
  git add app/api/reviews/route.ts app/issues/page.tsx app/issues/issue-explorer.tsx lib/reviews.ts test/review-repository-query.test.ts test/ui-current-review-flow.test.tsx docs/release/review-portal-1-0-validation.md
  git commit -m "feat: support combined risk filtering"
  ```

## 最终交付

- 在同一功能分支上保留所有提交；未跟踪的 `tsconfig.tsbuildinfo` 不纳入版本控制。
- 只完成一次整体代码审查和一次最终部署，不为每个任务重复审查或部署。
- 最终发布前使用 Sites 的现有站点和当前分支 HEAD 保存版本、部署并确认正式 URL。
