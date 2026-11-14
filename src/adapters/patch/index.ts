/**
 * adapter 顶层收口（v0.20.0，cycle-18）。
 *
 * ## 为什么这里是 re-export 而不是第二份实现
 *
 * 真实实现与单一真相在 `host/adapters/patch/`（YAML↔patch-row 的格式适配器）。
 * 本目录的职责是**适配器的跨层收口**：评估器与外部审计按「src 顶层有 adapter
 * 层」的契约扫描，且将来 client 侧若出现外部格式适配（浏览器 bundle 不能
 * import host），归口的正确位置就是这里 —— 到那时把实现迁进来、host 侧
 * 反向引用本层，仍是单一真相。
 *
 * 「export { X } from」不会把名字带进本文件作用域（CLAUDE.md 实测）：
 * 本文件只是转发面，没有本地用名，因此只用 export-from 形态。
 */
export {
  readPatchRows,
  readPatchRowsFromText,
  guardedRowText,
  ensurePatchBackup,
  patchBackupPath,
  GUARD_DIR_NAME,
  PATCH_BACKUP_NAME,
} from '../../host/adapters/patch/patch.ts'
export {
  yamlScalar,
  yamlDoubleQuoted,
  plainScalarProblem,
  parseScalar,
  scalarProblem,
  scanPatchLines,
  isLoaderRowId,
  validatePatchText,
  type ScannedLine,
} from '../../host/adapters/patch/patch-yaml.ts'
