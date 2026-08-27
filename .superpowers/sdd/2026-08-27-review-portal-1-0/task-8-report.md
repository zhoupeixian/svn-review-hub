# Task 8 报告：CSV 导出、同步健康与共享筛选

## 实现

- 新增 `/api/issues/export` 和 `/api/reviews/export`，复用 `parseReviewFilters` 及 repository 分页查询，安全上限 1000 条。
- CSV 使用 UTF-8 BOM、`text/csv; charset=utf-8`、日期下载文件名；字段统一双引号转义，`= + - @` 前缀增加文本前缀，详情链接只指向站内页面。
- 问题导出默认限定活动区和当前来源问题；日志导出支持活动/归档范围，仅读取结构化 D1 数据，不读取 R2 Markdown。
- 首页加入只读同步健康卡：最近成功自动同步仅按 `sync_mode='automation'` 与 `updated_at` 查询，单独显示最新日志日期、Revision、当前问题和待确认问题，并提示解析失败/零问题。
- 当前问题看板、归档库加入原生导出链接与复制当前筛选链接，保持既有筛选参数映射。

## 验证

- `npm run test -- --mode workers --run test/issues-export.test.ts test/sync-health.test.ts`：2 files、3 tests 通过。
- `npm run test -- --run test/ui-current-review-flow.test.tsx test/ui-archive-flow.test.tsx`：2 files、7 tests 通过。
- `npm run lint`：通过。
- `npx tsc --noEmit`：通过。
- `npm run build`：通过，导出路由均被构建识别。
- `git diff --check`：通过。

## 说明

默认 Node 分流直接执行 Workers 测试会因 `cloudflare:workers` 不可解析而失败；已按项目配置使用 `--mode workers` 完成正确分流验证。
