/**
 * 声明式冲突元数据 —— **纯转发层**（T14-03）。
 *
 * 为什么拆成两个文件：复杂度预算按**文件**计分，而这一层同时承担
 * 「读声明 + 版本范围判定」与「四类 finding 分类」两件事，实测已顶到
 * 预算（branches 67 / functions 17）。拆开之后：
 * - `conflict-declarations.ts`：文件 IO、声明归一化、版本范围判定（可判定性）；
 * - `conflict-findings.ts`：四类 finding 的纯分类。
 *
 * 本文件只做**再导出**：调用方（index / status / snapshot / store / 测试）
 * 的 import 站点保持稳定 —— 拆分是实现细节，不该成为接口变更。
 * 这里不写任何逻辑，所以复杂度恒为 0。
 */
export type {
  CompatDeclaration,
  ConflictFinding,
  DeclaredPlugin,
  DeclarationSource,
  FindingKind,
  FindingSeverity,
  RangeVerdict,
} from './conflict-declarations.ts'
export { locateKeyLine, readDeclaredPluginsSync, satisfiesRange } from './conflict-declarations.ts'
export { errorFindings, findingActive, findingsFor } from './conflict-findings.ts'
