---
name: rev-workflow
description: 逆向工程总流程与交付标准，先静态后动态、证据链、可回滚补丁
whenToUse: 开始一个新样本的逆向任务，或需要把逆向过程整理成可复现交付时
---

# 逆向总流程与交付标准

## 1 立案（10 分钟内完成）

- 建工作目录：`work\<短hash>\{orig,unpacked,patched,scripts,evidence}`。
- 原样本只读：先算 hash 再复制，复制品才动。
  ```powershell
  $h = (Get-FileHash .\sample.exe -Algorithm SHA256).Hash
  New-Item -ItemType Directory -Force ".\work\$($h.Substring(0,8))" | Out-Null
  Copy-Item .\sample.exe ".\work\$($h.Substring(0,8))\orig\sample.exe"
  "SHA256=$h" | Set-Content ".\work\$($h.Substring(0,8))\notes.md"
  ```
- 写清目标与判据：脱壳？定位校验？重建协议？找崩溃点？把「什么算完成」先写下来。
- 环境：VM 快照 + 断网 + 无共享目录；记录 OS 版本、工具版本（IDA 9.x / x64dbg 版本号 / Ghidra 版本）。

## 2 静态基线（先地图，后细节）

1. `rev-pe-recon`：架构、编译器、节区、导入导出、字符串、签名、overlay。
2. `rev-ida` 或 `rev-ghidra`：入口、main 定位、字符串交叉引用、可疑 API 簇。
3. 产出地图：关键函数清单（地址/大小/作用/置信度 高/中/低）。

判据：不看动态也能说出「样本大概做什么、入口在哪、哪些是危险函数」。做不到就继续静态，不要急着上调试器碰运气。

## 3 动态验证

- `rev-x64dbg`：断点位置从静态假设来（`bp <addr>` 或 `bpx <api>`），每个断点配预期值与退出条件。
- 先跑通正常路径，再构造边界输入；记录寄存器/参数/返回值与本进程模块基址。
- VA 与 RVA 换算一律写公式：`VA = ImageBase(运行时) + RVA`；IDA 里多数地址即 RVA，x64dbg 里是 VA。

## 4 结论与补丁

- 补丁前先建基线：原文件 hash、行为、关键分支走向。
- `rev-patch`：文件补丁优先，内存补丁次之；每改一处单独记录偏移与原始/新字节。
- 补丁后回归：同一组输入重跑，对比差异；保留 `patched/` 与 `.diff`，保证可回滚。

## 5 交付物（缺一不算完成）

| 文件 | 内容 |
| --- | --- |
| `notes.md` | 时间线：命令、地址、假设、验证结果、结论 |
| `evidence/` | 反编译片段、断点日志、内存 dump、抓包 |
| `scripts/` | IDAPython / x64dbg 脚本 / 解密脚本（能直接重跑） |
| `patches/` | 补丁脚本 + 原始字节 + 新字节 + 偏移 |
| `report.md` | 结论、证据链、影响面、复现步骤、未解问题 |

证据粒度：每条结论给出 `样本SHA256 / 模块 / RVA / 文件偏移 / 命令 / 输出摘要`。

## 6 质量闸门

- 地址必须能在同一样本上重现；换机/换基址要写明 ImageBase。
- 反编译结果只做参考，字节级结论必须对汇编或动态数据。
- 没验证的写成「假设」，不要写成结论；缺工具写「缺什么、怎么补」。
- 全程禁网；样本不落地宿主机持久目录，结束后销毁快照或清理 `work/`。

## 7 与其他技能的衔接

- 先 `rev-pe-recon` → 需要反编译走 `rev-ida` / `rev-ghidra` → 需要动态走 `rev-x64dbg` → 加壳走 `rev-unpack` → .NET/Unity 走 `rev-dotnet-unity` → 补丁/注册机走 `rev-patch` → 恶意样本走 `rev-malware`。
- 多个技能可叠加使用，但每步结束都要回填 `notes.md`，不许只在脑子里推进。
