---
name: rev-pe-recon
description: PE/EXE 静态侦察，hash、文件类型、节区、导入导出、字符串、签名、编译器与壳识别
whenToUse: 拿到一个 Windows PE 样本，需要在不运行的前提下建立第一张地图时
---

# PE/EXE 静态侦察

原则：全部只读；先记录再分析；每条结论附 `文件偏移 / RVA / 命令输出`。

## 1 身份与完整性

```powershell
Get-FileHash .\sample.exe -Algorithm SHA256 | Format-List
(Get-Item .\sample.exe) | Select-Object Name,Length,CreationTime,LastWriteTime
Format-Hex -Path .\sample.exe -Count 64          # 前 64 字节：MZ / e_lfanew
Format-Hex -Path .\sample.exe -Offset 0x80 -Count 64
```
- `MZ` 开头且偏移 `0x3C` 处的 dword 指向 `PE\0\0` → 正常 PE；不是则可能是脚本/壳的 loader/其他格式。
- 记录文件大小；`SizeOfImage` 与实际大小差过大 = 有 overlay 或资源追加。

## 2 头部与节区

```powershell
dumpbin /headers .\sample.exe > recon-headers.txt
```
```text
# 若没有 dumpbin，用 radare2 或 python pefile
rabin2 -I -S .\sample.exe
python -c "import pefile;pe=pefile.PE(r'sample.exe');[print(s.Name.decode().strip(chr(0)),hex(s.VirtualAddress),hex(s.PointerToRawData),hex(s.Misc_VirtualSize),hex(s.SizeOfRawData),hex(s.Characteristics)) for s in pe.sections]"
```
看什么：
- 节名/顺序：`.text/.rdata/.data` 正常；`UPX0/UPX1`、`.aspack`、`.MPRESS1`、`.vmp0/.vmp1`、`.themida`、`.enigma*` → 加壳（转 `rev-unpack`）。
- `EntryPoint` 落在哪个节：非 `.text` 且该节可写可执行（`W+E`）→ 高概率壳。
- `SizeOfRawData` 为 0 但 `VirtualSize` 很大 → 运行时解压区。
- 节区熵：接近 8.0 的段可能是压缩/加密载荷；`python` 用 `math.log2` 统计字节频率。

## 3 导入 / 导出 / 依赖

```powershell
dumpbin /imports .\sample.exe
dumpbin /exports .\sample.exe
dumpbin /dependents .\sample.exe
dumpbin /loadconfig .\sample.exe      # CFG / SafeSEH / GS 线索
dumpbin /clrheader .\sample.exe       # 有输出 = .NET 混合/纯托管
rabin2 -i -E .\sample.exe
```
判读：
- 导入极少（<10 个）且集中在 `LoadLibrary/GetProcAddress/VirtualAlloc/VirtualProtect` → 壳或动态解析。
- 导入含 `CreateProcessW/WriteProcessMemory/CreateRemoteThread` → 注入行为。
- 含 `WinHttp*/WinInet/socket/connect/send` → 网络行为（C2/更新/协议）。
- `_CorExeMain` + `/clrheader` 有输出 → .NET（转 `rev-dotnet-unity`）。
- 导出表为 0 但有 `DllMain` 风格入口 → DLL 侧载/服务。

## 4 字符串与资源

```powershell
strings.exe -n 6 -u .\sample.exe > strings-u.txt     # Sysinternals，-u 取 UTF-16
strings.exe -n 8 .\sample.exe > strings-a.txt
```
```text
# 资源提取（PE-bear GUI / Resource Hacker 亦可）
rabin2 -zz .\sample.exe | Select-String 'http|cmd|powershell|\.dll|AppData'
```
- 关注：URL/IP、文件路径、注册表键、互斥体名、错误文案、命令行模板、base64/hex 长串。
- 资源段里的 exe/dll/驱动 → 释放载荷（dropper）；图标/版本信息可用于样本家族聚类。

## 5 签名与编译痕迹

```powershell
sigcheck.exe -a -h -nobanner .\sample.exe
Get-AuthenticodeSignature .\sample.exe | Format-List Status,SignerCertificate
```
编译器判据（结合字符串与节区）：
- MSVC：`.text` 含 `\xCC` 对齐、Rich Header、`msvcp*.dll` / `vcruntime`。
- MinGW/GCC：`__mingw`、`libgcc`、`___main`；入口常见 `__mingw_WinMain`。
- Go：`.gopclntab`、`Go build ID`、`runtime.*` 字符串、大二进制；`go version -m sample.exe` 能直接读模块信息。
- Rust：`rust_eh_personality`、`.rustc`、`core::` 符号（未 strip 时）。
- Delphi：`Borland`、`TForm`、`System.Sysutils`、RTTI。
- .NET：`BSJB`、`mscoree.dll`、`_CorExeMain`、`#Strings` 流。

## 6 侦察产出表（回填 notes.md）

| 字段 | 值 |
| --- | --- |
| SHA256 / 大小 | |
| 架构 / PE 类型 | x86 / x64 / .NET / DLL / 驱动 |
| 编译器 / 是否加壳 | |
| 入口 RVA / 所在节 | |
| 导入特征簇 | 网络 / 进程 / 加密 / 文件 / 注册表 |
| 可疑字符串 | URL、路径、互斥体、错误文案 |
| 签名状态 | 无 / 有效 / 自签名 |
| overlay 大小 | 文件大小 - 节区 RawData 总和 |
| 下一步 | IDA 反编译 / 脱壳 / 动态调试 |

## 7 判据与坑

- 侦察阶段不运行样本；不双击、不 `Start-Process`。
- `dumpbin` 需要 VS 开发者环境（`vswhere` 找 `VC\Tools\MSVC` 下的 `dumpbin.exe`），没有就换 `rabin2` / `pefile`。
- 壳识别不要只看节名：改过节名的样本看 `EntryPoint`、导入数量、熵、`UPX!` 等 magic。
- 有数字签名的样本先验证签名是否被吊销/篡改，再决定是否信任版本信息。
