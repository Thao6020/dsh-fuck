---
name: rev-unpack
description: 壳与混淆识别、UPX/ASPack 等常规脱壳、VMProtect/Themida 应对策略与 .NET 壳处理
whenToUse: 样本节区异常、导入极少、入口不在代码段、熵接近上限，或需要把加壳样本还原为可分析形态时
---

# 壳与混淆识别、脱壳

原则：脱壳是手段不是目的。壳硬到成本超过收益时，改走内存 dump + 动态行为分析，不要死磕。

## 1 先识别（10 分钟定性）

- 节区名：`UPX0/UPX1`、`.aspack`/`.adata`、`.MPRESS1/2`、`.vmp0/.vmp1`、`.themida`/`.winlice`、`.enigma1/2`、`.petite`、`.nsp*`。
- 入口点：不在 `.text`、落在可写可执行节 → 高概率壳（`rev-pe-recon` 里看过 EP 与节属性）。
- 导入表：少于 10 个且集中在 `LoadLibrary/GetProcAddress/VirtualAlloc/VirtualProtect` → 解析延迟。
- 熵：整段接近 8.0；`upx -l sample.exe` 能列出则基本确定是 UPX。
- 工具：Detect It Easy（DIE）、PE-bear、`diec.exe`（DIE 命令行）、`rabin2 -I -S`。

## 2 常规壳：UPX / ASPack / MPRESS

```powershell
upx -l .\sample.exe                    # 列出压缩信息
upx -d .\sample.exe -o .\unpacked.exe  # 解压；失败看报错
```
- `upx -d` 失败常见原因：魔数/版本被改、节头被裁剪、压缩流被二次处理。先记录报错原文。
- 手工脱 UPX 思路：
  1. 入口 `bp`，运行到 EP；`pushad` 后 `push` 一串值 → 记下栈顶，作为「ESP 定律」备案。
  2. 在解压循环结束后（栈平衡点）用 `bp`/`bpm` 停在 OEP 附近。
  3. `dump` 进程镜像 + Scylla 修复 IAT（`IAT Autosearch` → `Get Imports` → `Dump`）。
  4. 校验：脱壳文件能运行、节区正常、导入可用。
- ASPack/MPRESS 等同理：找 OEP → dump → 重建 IAT；不要强求「一键脱壳」。

## 3 通用脱壳流程（x64dbg）

1. 打开样本，停在 EP；记录各节区与内存映射（`memmap`）。
2. `bpx VirtualAlloc`：看解压/解密目标地址与大小；`bpm <目标地址>, <类型>`（写）设内存断点。
3. 命中后单步/条件 trace（`ticnd`）到解密完成；判断「代码区变为可执行」。
4. 找 OEP 的实用判据：
   - 32 位：入口 `pushad` → 解压尾 `popad`，随后 `jmp OEP`；或 ESP 定律（入口 ESP 下硬件断点，命中后附近 `F8` 找跳转）。
   - 64 位：`popad` 不存在，改看大块 `rep movs`/循环结束后的 `call/jmp` 到代码段。
   - 直接对代码段设 `bpm` 写断点，命中后看是否已解密完成。
5. `savedata` dump 关键区域，或 Scylla dump 整个模块；`Get Imports` 后检查 IAT 是否完整。
6. 判据：dump 文件 `dumpbin /imports` 有正常导入、可启动、关键功能可用；IAT 缺失则回第 4 步换 OEP。

## 4 VMProtect / Themida / WinLicense

- 这类是虚拟化保护，**不存在低成本完整脱壳**；强脱会得到一团 VM 字节码，分析价值低。
- 合理策略：
  1. 确认保护类型（DIE、节名、版本字符串、`VMProtect`/`Themida` 特征）。
  2. 不脱壳，直接在 VM 外部设 API 断点（网络、文件、注册表、`VirtualAlloc`），从参数与返回值重建行为。
  3. 关键判断用「外部可观测点」：进程行为、注册表、文件、网络、窗口消息。
  4. 若是自有/授权样本需要还原算法，优先找「保护外的明文接口」（导出函数、配置解密后的内存）再 dump 该结构。
- 输出写：「保护类型 + 放弃完全脱壳的理由 + 已获取的行为证据」，并给后续可执行方案。

## 5 .NET 壳 / 混淆器

- .NET Reactor、ConfuserEx、SmartAssembly、Eazfuscator、Dotfuscator：
  1. `de4dot.exe sample.exe -o deob.exe`（能去多少算多少）。
  2. dnSpyEx 打开：看类型/方法是否为空壳、字符串是否加密、控制流是否被拆散。
  3. 内存 dump：dnSpy 调试时 Dump Assembly；或运行时 hook `Assembly.Load` 保存模块。
  4. 方法体缺失/加密：结合 `rev-dotnet-unity` 的 dnlib/Cecil 脚本还原。
- 判据：反编译能看到真实方法体与字符串即算初步成功；`.NET Reactor` 的 native 部分转 `rev-x64dbg`。

## 6 回滚与交付

- 原样本 hash、壳类型、脱壳方法、工具版本、dump 偏移全部写进 `notes.md`。
- `unpacked/` 只放产物；任何 dump 都标注「dump 自哪个模块基址/何时」。
- 脱壳失败也是结论：记录失败点（哪一步不符预期），给出下一步（换工具链/放弃脱壳改行为分析）。
