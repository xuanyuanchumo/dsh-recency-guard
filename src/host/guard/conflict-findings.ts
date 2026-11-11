import type { ConflictFinding, DeclaredPlugin } from './conflict-declarations.ts'
import { satisfiesRange } from './conflict-declarations.ts'

/* ------------------------------------------------------------------------ *
 * finding 生成（纯函数）
 * ------------------------------------------------------------------------ */

/**
 * 由声明算出 findings（纯函数，输入输出皆可序列化）。
 *
 * 四类各有一段独立逻辑，顺序固定（输出顺序因此可复现）：
 * 1. `duplicate-service`：同一服务名被 ≥2 个插件声明；
 * 2. `declared-conflict`：A 的 conflicts 命中在场的 B；
 * 3. `dsh-version`：声明的 DSH 范围不满足宿主版本；
 * 4. `missing-dependency`：requires 里的包不在场。
 *
 * **不产生 finding 的情形**（任一）：插件未声明、范围不可判定、对手不在场。
 * 这样「没有声明」与「声明了但成立」在输出上可分（前者根本不出现在输出里）。
 *
 * @param plugins 扫描结果
 * @param hostVersion 宿主 DSH 版本（不可解析 ⇒ dsh-version 一律沉默）
 */
export function findingsFor(plugins: readonly DeclaredPlugin[], hostVersion: string | undefined): ConflictFinding[] {
  const findings: ConflictFinding[] = []
  const byName = new Map(plugins.map((p) => [p.name, p]))

  // 1) duplicate-service：先收集声明，再对 ≥2 的组各出一条。
  const serviceClaims = new Map<string, string[]>()
  for (const plugin of plugins) {
    for (const service of new Set(plugin.compat.services ?? [])) {
      const list = serviceClaims.get(service) ?? []
      list.push(plugin.name)
      serviceClaims.set(service, list)
    }
  }
  for (const [service, names] of serviceClaims) {
    if (names.length < 2) continue
    const first = byName.get(names[0] as string)
    findings.push({
      kind: 'duplicate-service',
      severity: 'error',
      plugins: [...names],
      message: `${names.join('、')} 重复提供 service ${service}（同名服务只能有一个 provider 生效）`,
      source: first?.source ?? { file: '', line: 0 },
      declaration: JSON.stringify({ service, services: first?.compat.services ?? [] }),
    })
  }

  for (const plugin of plugins) {
    if (!plugin.declared) continue

    // 2) declared-conflict：A 明确声明与 B 的某个版本范围冲突，且 B 在场并命中。
    for (const [otherName, range] of Object.entries(plugin.compat.conflicts ?? {})) {
      const other = byName.get(otherName)
      if (other === undefined) continue
      const verdict = satisfiesRange(other.version, range)
      if (!verdict.decidable || !verdict.ok) continue
      findings.push({
        kind: 'declared-conflict',
        severity: 'error',
        plugins: [plugin.name, otherName],
        message: `${plugin.name} 声明与 ${otherName}@${other.version ?? '?'} 冲突（范围 ${range}）`,
        source: plugin.source,
        declaration: JSON.stringify({ conflicts: { [otherName]: range } }),
      })
    }

    // 3) dsh-version：只认**声明里写的** DSH 范围；宿主版本无法解析 ⇒ 沉默。
    const declaredDshRanges: Array<{ range: string; label: string }> = []
    if (plugin.compat.dsh !== undefined) declaredDshRanges.push({ range: plugin.compat.dsh, label: 'dshCompat.dsh' })
    for (const [peerName, range] of Object.entries(plugin.peerDependencies ?? {})) {
      if (peerName === '@deepseek-ai/dsh' || peerName.startsWith('@deepseek-ai/dsh-')) {
        declaredDshRanges.push({ range, label: `peerDependencies.${peerName}` })
      }
    }
    for (const { range, label } of declaredDshRanges) {
      const verdict = satisfiesRange(hostVersion, range)
      if (!verdict.decidable || verdict.ok) continue
      findings.push({
        kind: 'dsh-version',
        severity: 'error',
        plugins: [plugin.name],
        message: `${plugin.name}@${plugin.version ?? '?'} 要求 ${label} ${range}，当前 DSH 为 ${hostVersion ?? '?'}`,
        source: plugin.source,
        declaration: JSON.stringify({ [label]: range }),
      })
    }

    // 4) missing-dependency：requires 指向的包不在 profile 里。
    //    严重度：**没装** = error（声明依赖却缺包，加载即失败）；
    //    **装了但被本次 profile 禁用** = warning（那是隔离的结果，不是缺陷）。
    for (const [depName, range] of Object.entries(plugin.compat.requires ?? {})) {
      const dep = byName.get(depName)
      if (dep === undefined) {
        findings.push({
          kind: 'missing-dependency',
          severity: 'error',
          plugins: [plugin.name],
          message: `${plugin.name} 需要 ${depName} ${range}，但 profile 里没有这个包`,
          source: plugin.source,
          declaration: JSON.stringify({ requires: { [depName]: range } }),
        })
        continue
      }
      if (dep.enabled) continue
      findings.push({
        kind: 'missing-dependency',
        severity: 'warning',
        plugins: [plugin.name],
        message: `${plugin.name} 需要 ${depName} ${range}，但该包当前被禁用`,
        source: plugin.source,
        declaration: JSON.stringify({ requires: { [depName]: range } }),
      })
    }
  }
  return findings
}

/** 只保留 error 级（贪心隔离的唯一输入分类）。 */
export function errorFindings(findings: readonly ConflictFinding[]): ConflictFinding[] {
  return findings.filter((f) => f.severity === 'error')
}

/** 一条 finding 是否仍成立（涉及的插件全都还在场且启用）。 */
export function findingActive(
  finding: ConflictFinding,
  active: ReadonlySet<string>,
): boolean {
  return finding.plugins.every((name) => active.has(name))
}