# Review Portal 1.0 发布验证记录

验证日期：2026-08-27（Asia/Shanghai）

## 验证样本与迁移版本

- 样本为 Workers 集成测试中的审查 Markdown：包含 P1、P2、P3，多 Revision，以及三个以上问题。
- 演练将 `Parameter Count Mismatch` 更新为 `resolved`，将 `Legacy Authorization Reuse` 更新为 `by_design`，并保留其他问题为 `open`。
- 随后重复导入同一来源，并导入删除一个问题、增加 `Fresh Source Problem` 的版本；稳定问题键、状态、处理说明、版本和事件均保持。重新出现的问题恢复为当前问题，未产生重复行。
- D1 migration journal 版本为 `0000_blushing_diamondback`、`0001_review_portal_1_0`、`0002_review_portal_1_0_constraints`（Drizzle journal version `7`）。
- `review-schema-contract.test.ts` 从 1.0 前的 schema 重建旧库，连续两次调用 `ensureReviewSchema()`；确认 `review_logs`、`review_issues`、事件记录和 R2 `content_object_key` 均保留，且无重复问题。

## 自动验证

| 命令 | 结果 |
| --- | --- |
| `node_modules/.bin/vitest.cmd --run --mode workers test/archive-api.test.ts test/issue-status-api.test.ts test/issues-export.test.ts test/review-ingestion.test.ts test/review-repository-query.test.ts test/review-schema-contract.test.ts test/sync-health.test.ts` | 7 个文件、26 项通过 |
| `node_modules/.bin/vitest.cmd --run test/ui-current-review-flow.test.tsx test/ui-archive-flow.test.tsx test/issue-lifecycle.test.ts test/review-query.test.ts` | 4 个文件、15 项通过 |
| `npm run lint` | 通过 |
| `node_modules/.bin/tsc.cmd --noEmit` | 通过 |
| `npm run build` | 通过；应用路由和 API 路由均成功产物化 |
| `git diff --check` | 通过，无空白错误 |

Workers 测试必须使用 `--mode workers`，以提供 D1、R2 与 `cloudflare:workers`。默认 Node 模式会因缺少该运行时而使 Workers 测试加载失败；反过来，全部文件放入 Workers 池会使两个 jsdom UI 测试遇到第三方 `tldts` 模块解析限制。因此本次采用上述显式分流，覆盖完整测试集。

## 浏览器验收

本地开发服务器验收日期：2026-08-27。

- 未登录状态下成功打开首页、问题看板、归档库和管理入口；首页显示当前日志与同步健康的空数据状态。
- 问题看板可见状态、严重级别、作者和关键词筛选，以及当前筛选链接和 CSV 导出入口。
- 归档库可见公开只读标识、筛选链接和导出入口；管理页可见归档预览/确认、恢复和手工 Markdown 导入入口。
- 匿名状态更新、冲突提示、详情锚点、归档预览/确认/恢复、CSV 公式防护和同步健康区分均由对应的 Workers/API 与 jsdom 回归测试覆盖。

## 已知限制

- 匿名状态更新没有可靠的操作者身份；系统仅记录无身份的时间线事件，并对客户端哈希实施短期频率限制。
- 测试必须按 Node/jsdom 与 Workers 两类运行时分流，不能以默认 Node 全量命令判定 Workers 专用测试失败。
- 本次未执行线上部署，项目配置未提供已部署站点地址；生产站点的原生导航、真实匿名提交、管理员归档及归档浏览须在部署后按发布后清单复验。
