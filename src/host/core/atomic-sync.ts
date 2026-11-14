/**
 * 同步原子写 —— 崩溃路径专用。
 *
 * 为什么需要它（isolation-dev 的跨进程实测抓到的真实缺陷）
 * --------------------------------------------------------
 * `decision.ts` 原本用 `writeFileSync` 写指针文件与决策文件。
 * `writeFileSync` 在 `open(path,'w')` 那一刻就把目标**截断为 0 字节**，
 * 然后才写入内容。另一个进程恰好在这个窗口里读，就会读到空文件：
 *
 * ```
 * 首次撕裂证据: {"at":"...","bytes":0,"content":""}
 * 采样 507 次：空文件 4（不是推断，是实测）
 * ```
 *
 * 后果不是「读到一个旧值」，而是**读到一个空值**：守护行表达式读到空指针
 * ⇒ `catch` ⇒ 返回 false（放行）⇒ 该轮守护整体失效 ⇒ 崩溃重演。
 *
 * 为什么不用 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic`
 * ---------------------------------------------------------------
 * 它是 **async**（内部 await 句柄与 fsync）。而本项目的崩溃路径有一条硬纪律：
 * **守护行安装、启动记录、崩溃决策全部同步 IO**（异步会输给崩溃 ——
 * 进程在 await 之后已经死了）。所以这里必须是同步实现。
 *
 * 同步原子提交的标准形态是「同目录临时文件 + rename」：
 * - 同目录：保证 rename 不跨文件系统（跨设备 rename 会 EXDEV 且非原子）；
 * - rename：POSIX 保证目标要么是旧内容、要么是新内容，**没有中间态**；
 * - 临时名带 pid + 序号：避免两个进程的临时文件互相覆盖。
 *
 * v0.20.0 升级（cycle-18，取经 dsh-compat-guardian 的 atomicWrite）——补上
 * 「断电幸存」三件：**'wx' 独占创建 + fsyncSync + 0600 权限**：
 * - 'wx'：独占创建（已存在即 EEXIST）。防止两个进程的临时文件同名互踩——
 *   pid+序号是进程内唯一，跨进程仍可能撞（重名概率低但后果是内容互覆）。
 * - fsyncSync：把数据真正推到存储层。rename 原子性只保证「名字换过去了」，
 *   不保证数据已落盘——崩溃/断电后 rename 的目标可能是**空文件**（ext4/NTFS
 *   都有此窗口）。崩溃决策文件恰是断电后重启最需要完整的那份载荷。
 * - 0600：守护决策/指针文件含 profile 路径等本机信息，权限收紧到属主。
 */
import { existsSync, fsyncSync, mkdirSync, openSync, closeSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** 临时文件序号：同进程内多次写同一目标时避免复用同一个临时名。 */
let sequence = 0

/** 决策/指针类文件的权限位：属主读写，组与其他无权限。 */
const OWNER_ONLY = 0o600

/**
 * 原子提交一段文本（同步）。
 *
 * 失败语义：写临时文件失败或 rename 失败都会**抛出**——调用方自己决定
 * 是降级（best-effort）还是让异常上抛（守护行安装失败不该拖垮宿主，
 * 所以那里的调用方会 catch）。
 */
export function writeFileAtomicSync(path: string, content: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  sequence += 1
  // 临时文件必须与目标同目录：跨目录/跨设备 rename 不是原子操作。
  // 'wx' 独占创建：跨进程撞名时直接失败（走 catch 清理重试由调用方决定），
  // 而不是悄悄覆盖对方的临时文件。
  const temporary = `${path}.${process.pid}.${sequence}.tmp`
  let handle: number | undefined
  try {
    handle = openSync(temporary, 'wx', OWNER_ONLY)
    // 循环写满：writeSync 可能部分写入（尤其大 payload），必须按返回的字节数推进。
    const buffer = Buffer.from(content, 'utf8')
    let written = 0
    while (written < buffer.length) {
      written += writeSync(handle, buffer, written, buffer.length - written)
    }
    // fsync：不落这道，断电后 rename 过去的可能是空文件（见头注释）。
    fsyncSync(handle)
    closeSync(handle)
    handle = undefined
    renameSync(temporary, path)
  } catch (error) {
    // 失败时清掉临时文件，避免长期积累（.tmp 残留在 profile 里会被当成用户资产）。
    // 句柄先关再删：Windows 上未关闭的句柄会让 rmSync 报 EBUSY，掩盖原始错误。
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {
        /* 关闭失败不改变主错误 */
      }
    }
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* 清理失败不改变主错误：抛出原始原因更有诊断价值 */
    }
    throw error
  }
}