---
name: rev-ghidra
description: Ghidra headless 批量分析与脚本，反编译导出、版本跟踪、与 IDA 结果对照
whenToUse: 需要批量分析多个样本、无 IDA 环境、或要用 Ghidra 脚本/版本跟踪做对照与 patch diff 时
---

# Ghidra headless 与脚本

环境：Ghidra 安装目录由 `GHIDRA_HOME` 环境变量指定（默认形如 `C:\ghidra_11.x_PUBLIC`）；本机路径见设置里的 Ghidra 项 `{{ghidra}}`。需要 JDK 21+，`analyzeHeadless.bat` 在 `support\` 下。

## 1 headless 基本命令

```powershell
$env:GHIDRA_HOME = "C:\ghidra_11.3.2_PUBLIC"
& "$env:GHIDRA_HOME\support\analyzeHeadless.bat" `
  "C:\work\ghidra" proj1 `
  -import "C:\work\s\orig\sample.exe" `
  -overwrite -deleteProject `
  -scriptPath "C:\work\s\scripts" `
  -postScript DumpFunctions.java `
  -log "C:\work\ghidra\import.log"
```
常用参数：
- `-import <file>` / `-recursive <dir>`：导入单文件或批量目录。
- `-postScript` / `-preScript`：分析后/分析前运行脚本（`-scriptPath` 指定脚本目录）。
- `-noanalysis`：只导入不分析（快速看结构）。
- `-processor x86:LE:64:default`：自动识别失败时指定架构。
- `-loader <loader>`：格式识别失败时指定 loader（如 `PeLoader`）。
- `-analysisTimeoutPerFile 600`：大文件限时，避免卡死。
- `-readOnly`：只读打开已有项目，不写回。
- `-deleteProject`：分析完删项目（批量跑完不留垃圾）。
- `-max-cpu 4`：限制并行度。

## 2 Java 脚本（headless 最稳）

```java
// DumpFunctions.java：导出函数名/地址/被调用者到 CSV
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;

public class DumpFunctions extends GhidraScript {
    @Override
    public void run() throws Exception {
        FunctionManager fm = currentProgram.getFunctionManager();
        StringBuilder sb = new StringBuilder("addr,name,size,callers\n");
        for (Function f : fm.getFunctions(true)) {
            int callers = 0;
            for (var it = f.getCallingFunctions(monitor); it.hasNext(); ) { it.next(); callers++; }
            sb.append(f.getEntryPoint()).append(',')
              .append(f.getName()).append(',')
              .append(f.getBody().getNumAddresses()).append(',')
              .append(callers).append('\n');
        }
        java.nio.file.Files.writeString(
            java.nio.file.Path.of("C:/work/s/evidence/ghidra-functions.csv"), sb.toString());
    }
}
```
- 脚本用 `getScriptArgs()` 收参数（`-postScript A.java arg1 arg2`）。
- 反编译 API：`DecompInterface` + `decompileFunction(f, 60, monitor)` 拿 C 代码。
- 批量导出：`-recursive` + 脚本按 `currentProgram.getName()` 分目录写文件。

## 3 Python 脚本（Jython，版本较老）

```python
# strings_refs.py：列出含关键字的字符串及其引用函数
from ghidra.program.model.data import StringDataType
listing = currentProgram.getListing()
refs = currentProgram.getReferenceManager()
for data in listing.getDefinedData(True):
    v = data.getValue()
    if v is not None and any(k in str(v) for k in ("http", "license", "serial", "cmd")):
        print(str(data.getAddress()), v)
        for r in refs.getReferencesTo(data.getAddress()):
            print("  <-", r.getFromAddress(), getFunctionContaining(r.getFromAddress()))
```
- Jython 2.7 语法；慢，但适合一次性批处理。
- 复杂逻辑优先用 Java 脚本或 `pyhidra`（真实 CPython 桥接）。

## 4 UI 用法（需要交互时）

- 分析选项：打开时选 `Analysis` 默认配置；反编译失败时改 `Decompiler` 参数（超时、简化风格）。
- 数据类型管理器：先建结构体/枚举，再应用（对应 IDA 的 `declare_type`/`set_type`）。
- 版本跟踪（Version Tracking）：两版样本做 diff，定位补丁改动；配合 `patch-diff` 思路找修复点。
- 与 IDA 对照：Ghidra 伪代码更啰嗦但结构清晰，便于校验 IDA 的类型重建是否有误。

## 5 判据与常见坑

| 现象 | 处理 |
| --- | --- |
| `analyzeHeadless` 报 JDK 版本错 | 装 JDK 21+，设 `JAVA_HOME` |
| 导入失败/识别成 raw | 指定 `-processor` 与 `-loader` |
| 大文件分析超时 | `-analysisTimeoutPerFile`，先 `-noanalysis` 看导入导出 |
| 项目被锁 | 换新项目目录，别复用；`-readOnly` 只读访问 |
| 脚本无输出 | headless 的 `print` 进日志；显式写文件 |
| 中文路径 | 用引号包路径；项目目录尽量放纯英文路径 |

## 6 交付

- `evidence/ghidra-*.csv`、导出的 C 伪代码、脚本本体（含调用命令）。
- 结论注明 Ghidra 版本、JDK 版本、分析参数；与 IDA 结果不一致处单独列「差异与原因」。
- Ghidra 适合批量与对照，单样本深挖仍以 IDA 为主；两者结论互为校验。
