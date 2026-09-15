# PallasAI GitHub App

GitHub App 配置保存在 `config/github-app.json`，用于仓库克隆、分支推送和 Pull Request 操作。

## 已记录的 App 信息

- 名称：`PallasAI Coding Agent`
- Slug：`pallasai-coding-agent`
- App ID：`4160442`
- Installation ID：`142953590`
- 所属组织：`pallas-ai-geo`
- 仓库权限：`contents: write`、`pull_requests: write`、`metadata: read`

以上为迁移时保留的配置记录，未重新查询线上设置。

## 私钥与本地凭据

本地凭据放在 `.secrets/`，该目录除 README 外均被 Git 忽略。私钥路径或私钥内容的环境变量名称见配置文件。

不要提交私钥、installation token、client secret 或 webhook secret。
