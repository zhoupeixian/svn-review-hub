# 完成筛选控件修复报告

## 变更

- 问题看板新增开始日期、结束日期和 Revision 控件，复用现有 URL/API 参数映射；筛选变更清空旧结果并重置分页，加载更多沿用全部筛选。
- 归档库新增日期、严重级别、问题状态、Revision、提交人和关键词控件；应用筛选后更新公开 URL、刷新首屏，加载更多保持当前归档范围与筛选。
- 归档库仍为公开只读，未增加管理写操作。

## 验证

- `npx vitest run test/ui-current-review-flow.test.tsx test/ui-archive-flow.test.tsx`：11/11 通过。
- `npm run lint`：通过。
- `npx tsc --noEmit`：通过。
- `npm run build`：通过，`Build complete`。
- `git diff --check`：通过。
- `npm test -- --run`：UI 测试通过；6 个 Workers 套件因当前运行环境无法解析 `cloudflare:workers` 而未加载。
