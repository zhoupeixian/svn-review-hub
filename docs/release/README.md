# 版本发布流程

本项目发布的是依赖 Sites / Cloudflare Workers、D1 和 R2 的门户源码版本。GitHub Release 用于固定可追溯的源码和说明，不等于生产站点已部署，也不是可独立运行的 npm 包或 Docker 镜像。

## 持续集成

`.github/workflows/ci.yml` 在推送到 `main`、向 `main` 提交 PR 或手动触发时运行：

1. Linux Node.js 22 / 24，以及 Windows Node.js 24，均执行 `npm ci`。
2. 分别执行 Node/jsdom 与 Workers 全量测试。
3. 执行 TypeScript、lint 和生产构建。
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

草稿不保证出现在匿名访客的 Releases 栏目中，公开发布后才会展示。后续维护者可从已发布 Release 下载 GitHub 自动生成的源码归档；当前没有可脱离托管环境使用的安装包，因此不创建 Packages 条目。

## 发布前核对

- 发布说明准确列出可用功能、限制及数据迁移要求；CI 通过不能代替生产数据库或浏览器验收。
- 检查本版本相关依赖告警和安全问题，记录尚未解决的风险；Dependabot PR 不会自动合并。
- 首次正式开源发布前明确许可证。当前仓库尚未声明许可证，发布源码版本不会自动授予开源许可。
- 部署与 Release 是独立操作，只有明确授权后才修改生产环境；部署后按 README 执行只读冒烟，并单独核对真实登录与 D1/R2。

## GitHub 首页栏目

- **Actions**：CI 与 Release draft 工作流；Suggested workflows 只是 GitHub 推荐的模板，无需逐个启用。
- **Releases**：维护可追溯的版本记录；草稿由有权限的维护者审阅。
- **Packages**：留待有独立软件包或容器分发需求时启用；构建和测试产物使用 Actions artifacts，不为填充栏目发布无用包。
- **Languages**：由 GitHub Linguist 根据源码计算，当前 TypeScript / CSS / JavaScript 识别正常，不人为改变语言占比。
