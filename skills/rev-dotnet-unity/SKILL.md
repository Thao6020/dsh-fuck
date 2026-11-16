---
name: rev-dotnet-unity
description: .NET 程序集与 Unity il2cpp 逆向，dnSpy/ILSpy/de4dot、Il2CppDumper 与 IDA 恢复符号
whenToUse: 目标是 .NET 程序集、Unity 游戏（GameAssembly.dll/libil2cpp.so/global-metadata.dat）或需要还原 il2cpp 方法名与结构时
---

# .NET 与 Unity il2cpp 逆向

## 1 .NET 识别

```powershell
dumpbin /clrheader .\sample.exe          # 有输出 = 有 CLR 头
Format-Hex .\sample.exe -Count 128       # 找 BSJB 签名（元数据根）
```
- 纯托管：导出/导入围绕 `mscoree.dll` → `_CorExeMain`。
- 混合模式（C++/CLI、.NET Reactor native）：同时有 native EP 与 CLR 头。
- 判断目标框架：`dnSpyEx` 的 Assembly 属性页，或 `ildasm /text` 里的 `.assembly extern mscorlib/System.Runtime`。

## 2 工具与命令

| 工具 | 用法 |
| --- | --- |
| dnSpyEx | GUI：加载 → 搜索类型/方法/字符串 → 调试（Attach / 启动）→ 编辑方法 IL |
| ILSpy | `ilspycmd sample.exe -o .\decomp`、`ilspycmd -il sample.exe`（看 IL）、`-p` 出工程 |
| de4dot | `de4dot.exe sample.exe -o deob.exe`，识别 ConfuserEx/Reactor/SmartAssembly 等 |
| ILDasm/ILAsm | `ildasm sample.exe /out=sample.il` → 修改 → `ilasm sample.il /output=new.exe` |
| dnlib / Mono.Cecil | 写脚本批量改 IL、解字符串、去控制流 |
| dnSpy 调试器 | 断点、调用栈、局部变量、Dump Assembly（内存模块） |

流程：`de4dot` → ILSpy 快速通读 → dnSpy 定位关键方法 → 动态下断验证 → 需要改则 IL 补丁或内存补丁。

## 3 常见 .NET 保护与处理

- **ConfuserEx**：控制流扁平化、常量加密、反调试、资源加密。先 `de4dot`；剩余用 dnSpy 动态断在字符串解密函数，或写 Cecil 脚本还原。
- **.NET Reactor**：方法加密 + native 壳。托管部分用 de4dot/dnSpy，native 部分转 `rev-x64dbg`；必要时 dump 运行时程序集。
- **SmartAssembly/Eazfuscator**：字符串加密与代理调用多；dnSpy 断在解密点抓明文，再批量替换。
- **Dotfuscator**：重命名 + 字符串加密；重命名不影响逻辑，按调用关系恢复命名即可。
- 判据：能看到真实方法体、字符串明文、逻辑分支可读，即算脱保护成功；不要为了「全部还原」无限堆时间。

## 4 Unity il2cpp 结构

| 平台 | 常见布局 |
| --- | --- |
| Windows | `Game.exe` + `Game_Data\il2cpp_data\Metadata\global-metadata.dat` + `GameAssembly.dll` |
| Android | `lib\arm64-v8a\libil2cpp.so` + `assets\bin\Data\Managed\Metadata\global-metadata.dat` |
| iOS | `UnityFramework` / `UnityFramework.framework` + 内嵌 metadata |

关键点：方法名、类名、字段偏移都在 `global-metadata.dat`；代码在 `GameAssembly.dll`/`libil2cpp.so`，导出符号极少。

## 5 Il2CppDumper（核心工具）

```powershell
# Windows：GameAssembly.dll + global-metadata.dat
.\Il2CppDumper.exe .\GameAssembly.dll .\Game_Data\il2cpp_data\Metadata\global-metadata.dat .\il2cpp-out
# Android：libil2cpp.so + global-metadata.dat
.\Il2CppDumper.exe .\libil2cpp.so .\global-metadata.dat .\il2cpp-out
```
- 自动识别 metadata 版本；失败时用 `-v <版本号>` 指定（版本号在 Dumper 报错信息里给出）。
- 产物：`dump.cs`（类/方法 + RVA/Offset 注释）、`DummyDll/`（可给 dnSpy 看结构）、`script.json`、`il2cpp.h`、`ida_with_struct_py3.py`。
- 判据：`dump.cs` 里能搜到目标类/方法，且 RVA 与 IDA 里函数地址对得上。

## 6 把符号灌回 IDA（本机 MCP 环境）

本机 IDA 9.3 + `ida-pro-mcp`（`mcp__ida-pro-mcp__*`）当前就在分析 `libil2cpp.so` 这类目标：

1. IDA 打开 `libil2cpp.so` / `GameAssembly.dll`，等自动分析完成。
2. 执行 Dumper 生成的 IDA 脚本：`ida_with_struct_py3.py`（恢复函数名 + 结构体）或 `ida_py3.py`（只恢复函数名）。
   ```text
   mcp__ida-pro-mcp__py_eval(code="exec(open(r'C:\\work\\il2cpp-out\\ida_with_struct_py3.py').read())")
   ```
   脚本运行后会弹对话框选项；无人值守时用 GUI 的 File → Script file 更稳。
3. 验证：`list_funcs` / `entity_query(kind="names")` 里出现 `ClassName__MethodName` 形式的函数名。
4. 之后用正常 IDA 流程分析：`decompile`、`xrefs_to`、`trace_data_flow`。

## 7 动态定位 Unity 方法

- `dump.cs` 里方法注释有 `RVA: 0x...`，运行时地址 = `mod.base("GameAssembly.dll") + RVA`。
- x64dbg：`bp mod.base("GameAssembly.dll")+0x1A2B3C`，命中后看参数（il2cpp 方法首参通常是 `this`/`MethodInfo*`）。
- 字段偏移：`dump.cs` 的 `Offset: 0x...` 是对象内偏移，配合 `this` 指针读值。
- 加密字符串/配置：断在 `il2cpp::vm::String::New` 或 `il2cpp_codegen_string_new_utf16` 等构造点读明文。

## 8 交付与边界

- 产出：`il2cpp-out/`、恢复符号后的 IDB、关键方法伪代码、字段偏移表、动态验证记录。
- 结论注明：metadata 版本、Dumper 版本、模块基址、RVA 换算方式。
- 只对自有/授权样本操作；不发布他人游戏的破解补丁或在线服务攻击载荷。
