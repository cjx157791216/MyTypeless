# 2026-10-17 会议中整体重新归类在句子少于参会人数时报错

## 现象

Windows 上开会时主进程日志反复出现 `[meeting] live regroup failed: TypeError: Cannot read properties of undefined (reading 'n')`，会议进行中的说话人纠正（每 20 秒一次）失效。与平台无关。

## 原因与改动

`regroup` 已知人数时先切出 k 个主簇；有声纹的句子比参会人数少时（会议刚开始、某一路只有一两个人说过话）只能切出不到 k 个，但后面的重新归属循环仍按 k 取各簇，取到 `undefined`。改为按实际切出的簇数循环；“不能把某人的段全拉走”那一步跳过没有去处的段。

## 验证

- 新增单测：2 句 / 参会 4 人、1 句 / 参会 3 人时不报错且保持原归属（改前复现同一 TypeError）。
- `npm run test`、typecheck、build、docs:check 通过。
