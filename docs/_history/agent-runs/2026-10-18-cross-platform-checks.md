# 2026-10-18 跨平台检查与原生协议对齐

## 范围

GAP-008 的工程约束：审查 macOS / Windows 代码结构与开发规范后的修正。刻意没做：根 `AGENTS.md`“已知陷阱”拆分到模块说明（改动面大，单独做）、`index.ts` 平台分支抽离。

## 改动

- 新增 `test/native-helpers.test.ts`：两个平台跑同一组原生助手协议用例（只测不发按键、不读输入框的路径）；`native-win.test.ts` 只留 Windows 独有部分。
- 写通用测试时发现 macOS 助手与 Windows 版不一致，按契约对齐：
  - `mt-focus`（Swift）：未知参数原先退出码 0（照常输出前台应用），`--caret-context` 负数照样读输入框；现在参数先校验，错误退出码 2，再检查权限。
  - `mt-inject`（Swift）：先检查权限后检查参数（无授权时参数错误报 3）；`--combo` 的未知修饰键被忽略、只发出字母。现在参数先校验，有不认识的键或修饰键时退出码 2、不发任何按键。
  - `mt-focus`（Windows）：`--caret-context` 的非整数参数原先按 0 处理，现在退出码 2。
- CI：macOS job 先 `npm run native` 再跑测试；修正 Windows job 中挂错行的注释。
- 文档：契约补“参数先于权限校验”与各参数错误；`native/AGENTS.md` 补 `mt-focus` 读文字的用法、改协议要同一 PR 同步两份实现；`src/main/AGENTS.md` 在线更新已支持 Windows；`STATUS.md` / 缺口账本 GAP-008 已随 v0.3.2 发布；根 `AGENTS.md` 完成标准、PR 模板、CONTRIBUTING 补 Windows 原生代码的检查要求。
- `main` 分支保护把 `check-windows` 加为必需检查。

## 验证

- `npm run native` 编译通过；`node --test test/native-helpers.test.ts` 本机 7/7 通过。
- `npm run typecheck`、`npm run test`、`npm run build`、`npm run docs:check`：见 PR。
- Windows C++ 改动只能由 CI 的 `check-windows` 编译与测试。

## 遗留

- 根 `AGENTS.md` 的会议 / Windows 细节移到 `src/main/meeting/AGENTS.md`（新建）与 `native/AGENTS.md`。
