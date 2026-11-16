---
name: rev-ida
description: IDA Pro 静态分析，含本机 ida-pro-mcp MCP 工具用法、反编译、xref、类型重建与 IDAPython
whenToUse: 需要在 IDA Pro 里反编译、重建函数语义、追交叉引用或批量脚本化分析 PE/ELF/SO 时
---

# IDA Pro 静态分析

本机环境：IDA 9.3 + `ida-pro-mcp` MCP（streamable-http，默认 `http://127.0.0.1:13337/mcp`，DSH 服务器名 `ida-pro-mcp`，工具调用前缀 `mcp__ida-pro-mcp__`，底层工具名如 `survey_binary`、`decompile`、`py_eval`）。

## 0 前置检查

1. MCP 工具可列出、能返回健康状态；IDB 已载入目标（GUI 打开或 `idb_open`）。
2. 没有数据库绑定（`No database bound`）→ 先开库，别反复重试。
3. 工具里没有 `py_eval` 时，退回 GUI 的 Script file 或 `idat64 -S script.py -A target`。

## 1 概览（先看地图）

```text
mcp__ida-pro-mcp__survey_binary(detail_level="minimal")
mcp__ida-pro-mcp__list_funcs(queries=[{"offset":0,"limit":50}])
mcp__ida-pro-mcp__entity_query(kind="imports", filter="Create")
mcp__ida-pro-mcp__entity_query(kind="strings", filter="http")
```
- `survey_binary` 给架构、入口、函数数、字符串统计、段、导入分类、高 xref 函数——先记到 notes。
- 按导入簇找重点：网络（`socket/WinHttp/send`）、进程（`CreateProcess/WriteProcessMemory`）、加密（`Crypt*/BCrypt*`）、文件（`CreateFileW/ReadFile`）。

## 2 定位关键函数

```text
mcp__ida-pro-mcp__find_regex(pattern="error|fail|invalid|license|serial", limit=30)
mcp__ida-pro-mcp__xrefs_to(addrs=["0x404000"])          # 谁引用该字符串/函数
mcp__ida-pro-mcp__xref_query(addr="0x401000", direction="to")
mcp__ida-pro-mcp__find_bytes(patterns=["48 8B 05 ?? ?? ?? ??"], limit=10)
mcp__ida-pro-mcp__search_text(pattern="call    sub_")
```
判据：
- 失败提示字符串 → xref → 判断分支附近通常就是校验函数。
- 导入函数 xref 集中处 = 封装层（网络封装、文件封装），其调用者才是业务逻辑。

## 3 反编译与语义重建

```text
mcp__ida-pro-mcp__analyze_function(addr="main", include_asm=false)   # 伪代码+常量+调用者+被调用者+基本块
mcp__ida-pro-mcp__decompile(addr="sub_140001000")
mcp__ida-pro-mcp__disasm(addr="0x401000", max_instructions=100)
mcp__ida-pro-mcp__func_profile(queries=["main", "sub_401000"])
mcp__ida-pro-mcp__callgraph(roots=["verify_license"], max_depth=3)
mcp__ida-pro-mcp__trace_data_flow(addr="0x401050", direction="backward", max_depth=5)
```
重建顺序：函数签名 → 全局变量 → 结构体 → 局部变量 → 注释。
```text
mcp__ida-pro-mcp__declare_type(decls=[{"name":"PacketHeader","decl":"struct PacketHeader { uint32_t magic; uint16_t type; uint16_t length; uint8_t data[0]; };"}])
mcp__ida-pro-mcp__set_type(edits=[{"addr":"sub_401000","type":"int __fastcall decrypt(void *buf, int size, const char *key)"}])
mcp__ida-pro-mcp__rename(batch={"func":[{"addr":"sub_401000","name":"decrypt_payload"}],"global":[{"addr":"0x405000","name":"g_key"}],"local":[{"func":"decrypt_payload","old":"v1","name":"plaintext_buf"}]})
mcp__ida-pro-mcp__set_comments(items=[{"addr":"0x401000","comment":"XOR 解密循环"}])
mcp__ida-pro-mcp__infer_types(addrs=["sub_401000"])
```
类型对了伪代码才对；先重建网络包/配置结构，很多「看不懂」会自己消失。

## 4 IDAPython（批量活）

```text
mcp__ida-pro-mcp__py_eval(code="import idautils, ida_funcs; print(len(list(idautils.Functions())))")
mcp__ida-pro-mcp__py_eval(code="import idautils; print([hex(x.frm) for x in idautils.XrefsTo(0x404000)])")
mcp__ida-pro-mcp__py_eval(code="import ida_bytes; print(ida_bytes.get_bytes(0x401000, 32).hex())")
```
常见批处理：导出全部函数名+地址、按字符串反查引用、批量反编译某命名前缀的函数、提取 switch 跳表、导出结构体到 C 头文件。
```text
mcp__ida-pro-mcp__export_funcs(addrs=["main","decrypt_payload"], format="c_header")
mcp__ida-pro-mcp__make_signature_for_function(addrs=["decrypt_payload"])
```
进制换算一律用工具，不心算：`mcp__ida-pro-mcp__int_convert(inputs=["0x401000","4198400"])`。

## 5 与动态联动

- 静态给 RVA，动态给 VA：`VA = 运行时模块基址 + RVA`。x64dbg 用 `lm` 看模块基址，模块内偏移即 RVA。
- 关键函数记下 `RVA + 函数大小`，动态里直接 `bp <模块名>+<RVA>` 验证。
- 动态确认后的名字/类型回写 IDA（rename/set_type），保持静态库干净。

## 6 常见问题与判据

| 现象 | 处理 |
| --- | --- |
| `No database bound` | 先开库；确认当前 session |
| 工具超时（大文件/大函数） | 加超时，换 `disasm` 局部看，不要一次性导出 |
| 伪代码错乱 | 先 `set_type` 修函数签名，再 `declare_type` 补结构体 |
| 函数识别不全 | 入口附近 `create function`（GUI）或 `py_eval` 调 `ida_funcs.add_func` |
| 名称丢失 | 用 `make_signature_for_function` 生成签名，跨样本匹配后用 `rename` 批量恢复 |
| 看不到字符串引用 | 检查是否为 UTF-16 或解密后运行时生成；转 `rev-x64dbg` 断点读内存 |

## 7 交付

- 导出关键函数的伪代码到 `evidence/`，标注地址与重建后的签名。
- 输出地图：函数名 → 地址 → 作用 → 证据（字符串/xref/动态验证）。
- 有争议的结论写「待动态验证」，不要硬下结论。
