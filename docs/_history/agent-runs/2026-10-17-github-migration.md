# 2026-10-17 代码管理迁到 GitHub（D-031）

## 背景

负责人：“现在正式使用 github 做代码管理，然后走开源开发流程”。

## 操作

- 本机仓库：原 `origin`（公司 GitLab）改名 `gitlab`、本地分支改名 `gitlab-main`，作为只读存档；新 `origin` 指向 GitHub，`main` 跟踪 `origin/main`（开源快照）。迁移前其他会话未提交的改动（应用声音截取原型、新标志）先暂存，切换后原样恢复（逐行比对一致），仍未提交。
- GitHub 仓库设为公开；只允许 squash 合并、合并后删分支、关闭 Wiki；开启私密漏洞报告；加主题标签；`main` 分支保护：必须经 PR、状态检查 `check` 通过且基于最新 `main`、禁止强推和删除（不要求审批人数，管理员不强制）。
- 协作流程写入 AGENTS.md「代码协作（GitHub）」与 CONTRIBUTING.md「提交流程」；本次改动本身经 PR 合并。

## 发布改到代码仓库（D-032）

负责人：“releases 也可以在这个 git 项目中发版了”。

- 更新地址改为 `cjx157791216/MyTypeless/releases/latest/download`；`npm run release` 在代码仓库建 Release，标签打在构建所用的提交上。
- `npm run dist` 写 `release/build-info.json`（完整提交、是否有未提交改动）；`npm run release` 拒绝有未提交改动或提交未合并到 GitHub `main` 的构建——开源后发布的安装包必须能对应到公开代码。
- 0.2.1 读旧发布仓库：每次发布在 `mytypeless-releases` 同步一个只含 `latest-mac.yml` 的 Release（安装包地址指向代码仓库），旧版本更新一次后改读新地址，安装包不用传两份。
