---
name: rev-x64dbg
description: x64dbg 动态调试，断点、条件断点、内存断点、调用栈、trace、脚本与反调试对抗
whenToUse: 需要运行样本验证静态假设、抓关键参数、定位解密后内存或确认分支走向时
---

# x64dbg 动态调试

环境：x64dbg（`x64dbg.exe` 调试 64 位、`x32dbg.exe` 调试 32 位，位数必须匹配）；本机路径见设置里的 x64dbg 项 `{{x64dbg}}`，未配置时按解压目录/`PATH` 探测。建议装 ScyllaHide 插件对抗常见反调试。

## 1 启动与附加

```text
# GUI：File → Open，可填 Command line / 工作目录
# 命令框：
init "C:\work\s\orig\sample.exe"
attach 1234          # 按 PID 附加到已在运行的进程
detach               # 分离，保留进程
run / r              # F9
pause
```
- 先复制样本到 `work\` 再调试；原始样本只读。
- 记录模块基址：`lm`（Memory Map / 模块列表）；`VA = 模块基址 + RVA`。
- 模块内地址表达式：`mod.base("sample.exe")+0x1000`（表达式函数见帮助 → Expression functions）。

## 2 断点（本机命令已按 x64dbg 文档核对）

| 目的 | 命令 |
| --- | --- |
| 地址断点 | `bp 0x401000`、`bp mod.base("sample.exe")+0x1000` |
| API 断点 | `bpx CreateFileW`、`bpx WinHttpSendRequest`（SetBPX 支持 API 名） |
| 条件断点 | `bpcond 0x401000, rax==0x1234`，或 `bpcond mod.base("sample.exe")+0x1000, [rsp+8]==1` |
| 日志断点（不停机） | `bplog 0x401000, "hit rax={rax}"`，日志在 Log 窗口 |
| 内存断点 | `bpm <地址>, <类型>`（SetMemoryBPX；GUI 断点属性里选 Access/Write/Execute 更直观） |
| 硬件断点 | `bph <地址>`（执行，最多 4 个）、`bphws <地址>, "w"`（写） |
| 管理 | `bplist` 列表、`bc` 删除、`bd` 禁用、`be` 启用、`bpcnd` 改名/改条件 |
| 异常断点 | 菜单 Options → Exceptions 勾选要断的异常，或 `SetExceptionBPX` |

判据：断点应命中在你预期的调用路径上；不命中先查「是不是被反调试改了字节 / 走了另一分支 / 函数根本没被调用」，不要原地猜。

## 3 单步、运行与调用栈

- `sti`（F7 步入）、`sto`/`step`/`st`（F8 步过）、`rtr`（步出当前函数）、`skip`（跳过当前指令）。
- `rtu`（Run to user code）：从系统库返回自己的代码，适合跳出 `CreateThread`/`LoadLibrary`。
- 调用栈：GUI 的 Call Stack 视图（Ctrl+K 打开栈窗口）；参数按 x64 调用约定看 `rcx/rdx/r8/r9` + 栈，x86 看 `[esp+4]` 起的栈参数。
- 返回值：x64 在 `rax`，x86 在 `eax`；浮点在 `xmm0`。

## 4 内存与数据

```text
dump 0x401000                 # 十六进制视图跟随该地址
db 0x401000; dw 0x401000; dd 0x401000; dq 0x401000
savedata "C:\work\s\dump.bin", 0x401000, 0x2000
memmap                        # 内存映射（也看当前权限）
setpagerights 0x401000, "rwx"
alloc 0x1000                  # 申请内存，结果在 $result
memset 0x1000000, 0x90, 0x100
memcpy 0x1000000, 0x401000, 0x200
```
- 解密/解压完成后：先 `bpm` 或 `bp` 停在解密结束处，再 `savedata` 导出，交给 Scylla 修复 IAT。
- 反调试常改页权限（`VirtualProtect`）：断 `bpx VirtualProtect` 看目标页与新旧权限，能快速识别自修改代码。

## 5 Trace（批量记录执行流）

```text
ticnd <条件>, <最大步数>        # 条件步入 trace，命中即停
tocnd <条件>, <最大步数>        # 条件步过 trace
opentrace / tc                  # 开始/停止 run trace 记录
TraceSetLog "..." / TraceSetLogFile "C:\work\trace.log"
```
- 条件表达式里可用 `$breakpointcounter`、寄存器、内存解引用。
- 小步数 trace 配合 `bplog` 日志断点，比单步快得多；trace 文件可能很大，限制条件与步数。

## 6 脚本化

- 命令框与 Script 面板使用同一套命令；脚本按行执行，`;` 可在同一行串多条。
- 常用脚本骨架：`bp ...` → `run` → 在断点处 `log` 参数 → `sti`/`sto` 推进 → `savedata` 落盘。
- 脚本放在 `work\s\scripts\`，与 `notes.md` 里的命令一一对应，保证可复现。

## 7 反调试与对抗

- ScyllaHide 预设按样本表现选：PEB/TEB 清理、`NtQueryInformationProcess`、`NtSetInformationThread`、时间检查、父进程检查。
- 手动定位：`bpx IsDebuggerPresent`、`bpx NtQueryInformationProcess`、`bpx CheckRemoteDebuggerPresent`，看命中后返回分支；读 `PEB.BeingDebugged` 的代码用 `dump fs:[30]`（x86）或 `dump gs:[60]`（x64）。
- TLS 回调先于入口执行：在 TLS 回调地址下 `bp`（IDA 的 TLS 目录 / `dumpbin /headers` 里找），别只看 EP。
- 硬件断点会被部分壳检测（`GetThreadContext` 读 Dr 寄存器），必要时改用 `bpm` 或临时补丁。

## 8 收尾与判据

- 每个动态结论回填 `notes.md`：断点地址（RVA+模块）、命中次数、参数值、返回值、截图路径。
- 判定「验证通过」= 断点命中时机、参数、分支走向与静态假设一致，且可重复一次。
- 退出前 `detach`/`stop`，确认无残留调试进程；不改原样本，补丁只写 `patched/`。
