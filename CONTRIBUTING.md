# 参与贡献

问题反馈请使用 [Issue 模板](https://github.com/zhoupeixian/zherp-svn-review-portal/issues/new/choose)，提供版本、部署方式、复现步骤和脱敏日志。安全问题请使用 [私密报告渠道](SECURITY.md)。较大的功能或架构调整请先在 Issue 中说明使用场景和验收条件。

开发环境、目录职责及业务约束见 [AGENTS.md](AGENTS.md)。从最新 `main` 创建分支，使用 `npm ci` 安装依赖。提交应聚焦一个问题，修改行为时添加回归测试，并同步 README 或部署说明。

提交 PR 前运行：

```sh
npm run test:ci
npm run test:server
npm run typecheck
npm run lint
npm run build
npm run build:server
npm run verify:server
git diff --check
```

涉及镜像或部署脚本还需构建 Docker 镜像并执行 `node scripts/verify-server.mjs <image>`。该命令只创建本机临时测试实例，不接收远程站点地址。

PR 描述应说明具体问题、最终行为、验证结果和未验证边界。CI 全部通过后由维护者审查合并；不要提交密钥、真实业务数据、构建输出或依赖目录。贡献以项目的 [MIT 许可证](LICENSE) 提供，请确认提交内容具有相应授权。
