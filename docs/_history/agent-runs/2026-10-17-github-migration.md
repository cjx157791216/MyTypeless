# 2026-10-17 代码管理迁到 GitHub（D-031）

## 背景

负责人：“现在正式使用 github 做代码管理，然后走开源开发流程”。

## 操作

- 本机仓库：原 `origin`（公司 GitLab）改名 `gitlab`、本地分支改名 `gitlab-main`，作为只读存档；新 `origin` 指向 GitHub，`main` 跟踪 `origin/main`（开源快照）。迁移前其他会话未提交的改动（应用声音截取原型、新标志）先暂存，切换后原样恢复（逐行比对一致），仍未提交。
- GitHub 仓库设为公开；只允许 squash 合并、合并后删分支、关闭 Wiki；开启私密漏洞报告；加主题标签；`main` 分支保护：必须经 PR、状态检查 `check` 通过且基于最新 `main`、禁止强推和删除（不要求审批人数，管理员不强制）。
- 协作流程写入 AGENTS.md「代码协作（GitHub）」与 CONTRIBUTING.md「提交流程」；本次改动本身经 PR 合并。
