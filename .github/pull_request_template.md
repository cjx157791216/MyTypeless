## 改了什么 / What

## 为什么 / Why

关联 Issue / 决策（如 #12、D-010）：

## 检查 / Checks

- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] `npm run docs:check`
- [ ] 改了 `native/*.swift` 时 `npm run native`；改了 `native/win/` 时 `npm run native:win`（没有 Windows 电脑时看 CI 的 `check-windows`）
- [ ] 改了原生助手的参数 / 输出 / 退出码时，契约、macOS 与 Windows 两份实现、`test/native-helpers.test.ts` 已一起改
- [ ] 改了 IPC / 设置 / 表结构 / 原生协议时已同步 `docs/contracts/`
- [ ] 不涉及新增数据外发、录音落盘、扩大键盘监听（涉及请先开 Issue 讨论，见 CONTRIBUTING.md）

## 真机验证 / Manual testing

<!-- 快捷键、写入其他应用等需要真机的部分，说明在哪些应用里验证过 -->
