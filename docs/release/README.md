# 版本发布流程

本项目同时提供 Cloudflare 托管源码与独立服务器 / Docker 部署。GitHub Release 固定源码和版本说明；GitHub Packages 提供经过验证的 linux/amd64 容器镜像。两者都不会自动更新服务器，部署操作见 [部署指南](../deployment.md)。

## 持续集成

`.github/workflows/ci.yml` 在推送到 `main`、向 `main` 提交 PR 或手动触发时运行：

1. Linux Node.js 22 / 24，以及 Windows Node.js 24，均执行 `npm ci`。
2. 分别执行 Node/jsdom、Workers 和 SQLite 适配器业务测试。
3. 执行 TypeScript、lint、Cloudflare 与 Next standalone 生产构建，并验收新建的本机实例；另用 Linux Docker 验收容器、持久卷、重启和备份恢复。
4. 上传 JUnit 测试报告，保存 14 天；不上传本地环境文件、数据库或业务日志。

所有矩阵任务成功后，`CI passed` 检查才成功。仓库规则如需设置必需检查，应使用此稳定名称。CI 使用只读仓库权限，不需要生产密钥或托管服务令牌，不执行线上部署。

## 创建 Release 草稿

1. 在计划发布的改动中同步更新 `package.json` 和 `package-lock.json` 的版本，新增 `docs/release/v<版本>.md`。版本保持一致；未准备正式稳定版时，不因已有旧设计文档而跳到 1.0。
2. 将经过审查的改动合入 `main`，查看 CI 结果。
3. 在 GitHub **Actions → Release draft → Run workflow** 中选择 `main`。命令行等价操作为：

   ```powershell
   gh workflow run release-draft.yml --ref main
   ```

4. 工作流对该次触发的提交重新运行完整 CI；通过后以 `package.json` 版本生成标签名，创建 Release **草稿**，目标固定为已验证的提交 SHA。
5. 在 Releases 中检查草稿说明、目标提交、迁移与兼容性限制。是否公开发布、是否标记为 prerelease，由维护者决定；工作流不会自动发布。已有同名 Release 时工作流报错，避免覆盖历史版本。

草稿不保证出现在匿名访客的 Releases 栏目中，公开发布后才会展示。后续维护者可从已发布 Release 下载 GitHub 自动生成的源码归档；Release 草稿不会触发容器发布。已存在的 v0.1.0 草稿固定在早期 CI 基线，不自动包含后续独立部署改动；正式发布前需重新决定版本、说明和目标提交，不能把旧草稿当作最新功能验收。

## 发布前核对

- 发布说明准确列出可用功能、限制及数据迁移要求；CI 通过不能代替生产数据库或浏览器验收。
- 检查本版本相关依赖告警和安全问题，记录尚未解决的风险；Dependabot PR 不会自动合并。
- 项目采用 MIT，确认发布分发物包含 LICENSE，第三方依赖遵循各自许可证。
- 部署与 Release 是独立操作，只有明确授权后才修改生产环境；部署后按 README 执行只读冒烟，并单独核对真实登录与 D1/R2。

## GitHub 首页栏目

- **Actions**：CI 与 Release draft 工作流；Suggested workflows 只是 GitHub 推荐的模板，无需逐个启用。
- **Releases**：维护可追溯的版本记录；草稿由有权限的维护者审阅。
- **Packages**：通过 Publish container 分发真正可部署的容器，使用完整 SHA 或摘要定位版本；本项目不发布 npm 包。
- **Languages**：由 GitHub Linguist 根据源码计算，当前 TypeScript / CSS / JavaScript 识别正常，不人为改变语言占比。

## 容器发布

在 main 手动运行 `gh workflow run container-publish.yml --ref main`，完整 CI 与实际镜像验收成功后发布 `ghcr.io/zhoupeixian/svn-review-hub:sha-<完整提交号>`。首次发布后在 Package settings 确认可见性为 Public，并验证匿名拉取。

维护者公开 Release 时，工作流核对标签与 package.json 版本一致，发布 `vX.Y.Z` 镜像。如果同一 SHA 镜像已存在，核对 revision 标签并重新验收后复用，避免重新构建覆盖历史镜像；已有版本标签拒绝覆盖。

每次发布均在成功日志中保存镜像摘要，部署时固定摘要。没有 latest 自动滚动标签；升级和数据库回滚由维护者控制。不要在重试失败工作流时随意删除旧标签或镜像。
