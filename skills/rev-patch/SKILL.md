---
name: rev-patch
description: 补丁与 license 校验分析，文件偏移换算、条件跳转改写、keygen 思路与回滚
whenToUse: 需要绕过或还原自有样本的注册校验/试用限制，或把逆向结论落成可复现的文件补丁、内存补丁、注册机时
---

# 补丁 / 注册机 / license 校验分析

适用范围：自有样本、授权靶场。对第三方生产系统只做分析与报告，不交付攻击载荷。

## 1 目标分类（先定性再动手）

| 类型 | 交付物 | 风险 |
| --- | --- | --- |
| 文件补丁 | 改后的 EXE/DLL + 补丁脚本 + diff | 破坏签名/校验和/自校验 |
| 内存补丁 | x64dbg 脚本 / loader | 进程级，重启失效 |
| 注册机 | 算法重实现（keygen） | 需要完整还原算法，常用于无服务端校验 |
| 试用重置 | 状态文件/注册表清理脚本 | 需确认持久化位置 |

## 2 定位校验点

1. `rev-pe-recon` 拿字符串（`serial/license/expire/trial/invalid`）与导入（注册表、文件、网络）。
2. IDA：`find_regex("serial|license|invalid|expire")` → `xrefs_to` → `decompile`。
3. 判据：函数里有「比较 + 条件跳转 + 成功/失败分支」，且成功分支触发 UI/功能解锁。
4. 动态确认：x64dbg 在比较指令处 `bp`，输入正确/错误值看分支走向（`rev-x64dbg`）。

## 3 文件偏移换算（补丁必用）

```text
RVA → 文件偏移：FileOffset = RVA - Section.VirtualAddress + Section.PointerToRawData
反推：RVA = FileOffset - PointerToRawData + VirtualAddress
```
```python
# 用 pefile 换算，避免手算错
import pefile, sys
pe = pefile.PE(r"C:\work\s\orig\sample.exe")
def off(rva):
    for s in pe.sections:
        if s.VirtualAddress <= rva < s.VirtualAddress + max(s.Misc_VirtualSize, s.SizeOfRawData):
            return rva - s.VirtualAddress + s.PointerToRawData
    raise ValueError(hex(rva))
print(hex(off(0x1234)))
```
- IDA 显示的地址多数即 RVA（先确认 ImageBase）；x64dbg 显示的是运行时 VA。
- 记录三件套：`RVA / 文件偏移 / 原始字节`。

## 4 文件补丁流程

1. 备份：`Copy-Item sample.exe patched\sample.orig.exe`，记 SHA256。
2. 写补丁脚本（Python 示例）：
   ```python
   import hashlib, shutil
   src = r"C:\work\s\orig\sample.exe"; dst = r"C:\work\s\patched\sample.exe"
   shutil.copyfile(src, dst)
   data = bytearray(open(dst, "rb").read())
   off = 0x1234                      # 文件偏移
   old = bytes(data[off:off+2])
   data[off:off+2] = b"\x90\x90"     # 原始字节 old 写入 notes.md
   open(dst, "wb").write(data)
   print("sha256", hashlib.sha256(data).hexdigest(), "old", old.hex())
   ```
3. 常见改写：
   - `jz short xxx`（`74 xx`）→ `jmp short xxx`（`EB xx`）
   - `jz` → `nop; nop`（`90 90`）
   - `jnz`（`75 xx`）→ `nop; nop`
   - 校验后返回值：把 `test eax,eax; jz fail` 改成 `mov eax,1` 序列（需确认寄存器与后续清理）
4. 改完检查：PE 校验和、Authenticode 签名（改动后签名失效，必要时移除签名或改用测试签名）、自校验（CRC/文件大小/双进程守护）。
5. 回归：原输入 → 期望行为；错误输入 → 仍失败；无崩溃。

## 5 内存补丁（x64dbg）

```text
asm 0x401000, "nop"                 # 汇编改写
asm 0x401000, "jmp 0x401020"
memset 0x401000, 0x90, 4            # 批量 NOP
savedata "C:\work\s\patched\dump.bin", 0x401000, 0x100
```
- 内存补丁只影响当前进程；要持久化就转文件补丁。
- 断点 + `asm` 后 `run`，观察是否触发目标分支；改坏就 `InstrUndo`（或重新加载）。

## 6 keygen（算法重实现）思路

1. 判断算法类别：哈希（MD5/SHA/HMAC）、对称（AES/DES/RC4/XOR）、非对称（RSA/ECC）、自定义（查表/位运算混淆）。
2. 抓输入输出对：动态在算法入口/出口 `dump` 输入缓冲与结果，至少 3 组。
3. 还原：IDA 反编译 + `rev-ida` 的 `trace_data_flow` 追密钥来源；密钥硬编码时直接导出。
4. 实现：Python 复刻（hashlib/cryptography 库），用抓到的对做单元测试。
5. 判据：多组输入全部匹配；边界（长度、字符集、大小写）与样本一致。

## 7 反校验与回滚

- 常见保护：文件 CRC/自校验、签名校验、双进程互检、时间检查、驱动级校验。先定位校验函数，再决定「补校验值 / 绕过 / 改回」。
- 补丁失败立即回滚：保留 `patched/sample.orig.exe`、`patches/<hash>.py`、`diff.txt`。
- 交付写清：改了什么偏移、原字节、新字节、验证命令与结果；结论只针对自有样本。

## 8 边界

- 不提供针对第三方软件/服务的破解补丁、卡密生成器或在线激活绕过载荷。
- 不修改或分发他人签名文件；测试签名仅用于自家样本。
- 分析结论优先用于修复与加固（把自己软件的校验做对），而不是绕过。
