import {
  CAPABILITY_SPECS,
  buildCapabilityGraph,
  currentRegistrationSurface,
  verifyCapabilityContract,
  verifySurfaceAlignment,
} from '../../src/capability-specs.ts'
import { TOOL_SURFACE, exposedNamesOf } from '../../src/capability.ts'
import { ROUTE_PREFIX, ROUTE_PATHS, ROUTE_SURFACE } from '../../src/routes.ts'
import { PANEL_ID, NAMESPACE } from '../../src/client/index.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 契约层 —— 清单 ↔ 注册处的**双向**比对。
 *
 * 覆盖率要求 100%：漏一条能力登记就是真缺口，不能靠覆盖率稀释。
 *
 * 本层回答五个问题：
 * 1. 清单里声明的暴露面，是否都有对应的**注册位点**（工具 action / 路由）？
 * 2. 注册处是否注册了清单**完全没提**的名字或 action？
 * 3. 清单内部的关系是否**自洽**（声明的消费关系都被双向登记）？
 * 4. 清单声明的宿主服务依赖，是否与真实 inject 面一致（双向）？
 * 5. **这道门本身会响吗**？（负向自检：故意制造不一致，必须报 gap）
 *
 * 第 5 条不是装饰：一个永远为真的门等于没有门，「清单与注册不一致」这句话
 * 就没有任何约束力。
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('  PASS  ' + name)
  else {
    failures += 1
    console.log('  FAIL  ' + name, detail === undefined ? '' : JSON.stringify(detail))
  }
}

/** 从源码里读出一段 `inject` 声明的服务名（注册处的真实声明）。 */
function readInjectedServices(source: string): string[] {
  const out = new Set<string>()
  // `export const inject = ['a', 'b']`
  for (const match of source.matchAll(/export const inject\s*=\s*\[([^\]]*)\]/g)) {
    for (const name of match[1].matchAll(/'([^']+)'/g)) out.add(name[1])
  }
  // `inject: ['webServer']`（子插件形态）
  for (const match of source.matchAll(/inject:\s*\[([^\]]*)\]/g)) {
    for (const name of match[1].matchAll(/'([^']+)'/g)) out.add(name[1])
  }
  // `attachOptionalService(ctx, 'configEditor', …)`（选择性注入形态）
  for (const match of source.matchAll(/attachOptionalService\(\s*ctx\s*,\s*'([^']+)'/g)) {
    out.add(match[1])
  }
  return [...out].sort()
}

function main() {
  const graph = buildCapabilityGraph()
  const specsById = new Map(CAPABILITY_SPECS.map((s) => [s.id, s]))
  const indexSource = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
  const routesSource = readFileSync(join(process.cwd(), 'src', 'routes.ts'), 'utf8')
  const routesPluginSource = readFileSync(join(process.cwd(), 'src', 'routes-plugin.ts'), 'utf8')
  const injected = [...new Set([...readInjectedServices(indexSource), ...readInjectedServices(routesPluginSource)])].sort()
  const surface = currentRegistrationSurface()

  console.log('\n== capability ids ==')
  const ids = graph.all().map((r) => r.id)
  check('the capability ids are unique', new Set(ids).size === ids.length)
  check('every capability id is namespaced', ids.every((id) => id.startsWith('guard.')))
  check(
    'every capability id has a domain and a name',
    ids.every((id) => /^guard\.[a-z]+\.[a-z-]+$/.test(id)),
    ids.filter((id) => !/^guard\.[a-z]+\.[a-z-]+$/.test(id)),
  )

  console.log('\n== capability completeness ==')
  check('every capability has a title', graph.all().every((r) => r.title.trim().length > 0))
  check('every capability has a summary', graph.all().every((r) => r.summary.trim().length > 0))
  check('every capability declares a stage', graph.all().every((r) => r.stage.trim().length > 0))
  check('every capability declares a carrier', graph.all().every((r) => r.carrier.length > 0))
  check('every capability declares a produces kind', graph.all().every((r) => r.produces.length > 0))
  check(
    'every exposed capability declares its exposed name',
    graph.exposed().every((r) => typeof r.exposedAs === 'string' && r.exposedAs.length > 0),
  )
  check(
    'every non-exposed capability declares no exposed name',
    graph.all().filter((r) => !r.exposed).every((r) => exposedNamesOf(r).length === 0),
  )

  console.log('\n== relation self-consistency (literal spec text, not the repaired graph) ==')
  // 必须核对**清单原文**：buildCapabilityGraph 会补齐镜像，拿图去核对
  // consumedBy/consumes 一致就永远为真（自己核对自己）。
  for (const spec of CAPABILITY_SPECS) {
    for (const upstream of spec.consumes) {
      const producer = specsById.get(upstream)
      check(spec.id + ' consumes ' + upstream + ', which exists', producer !== undefined, upstream)
      if (producer) {
        check(
          upstream + ' literally records ' + spec.id + ' as a consumer',
          producer.consumedBy.includes(spec.id),
          producer.consumedBy,
        )
      }
    }
    for (const downstream of spec.consumedBy) {
      const consumer = specsById.get(downstream)
      check(spec.id + ' is consumed by ' + downstream + ', which exists', consumer !== undefined, downstream)
      if (consumer) {
        check(
          downstream + ' literally records ' + spec.id + ' as an upstream',
          consumer.consumes.includes(spec.id),
          consumer.consumes,
        )
      }
    }
  }

  console.log('\n== no dead capabilities ==')
  const analysis = graph.analyze()
  check('there are no isolated capabilities', analysis.isolated.length === 0, analysis.isolated)
  check('there are no broken consumption links', analysis.broken.length === 0, analysis.broken)
  check('there is no over-production', analysis.overproduced.length === 0, analysis.overproduced)
  check('the connectivity is complete', analysis.connectivity === 1, analysis.connectivity)
  check(
    'every non-exposed capability has a consumer',
    graph.all().filter((r) => !r.exposed).every((r) => r.consumedBy.length > 0),
    graph.all().filter((r) => !r.exposed && r.consumedBy.length === 0).map((r) => r.id),
  )

  console.log('\n== the tool surface (registration truth) ==')
  check('the tool surface declares a name', TOOL_SURFACE.name === 'recency_guard', TOOL_SURFACE.name)
  check('the tool surface declares actions', TOOL_SURFACE.actions.length > 0)
  check(
    'the registration site uses the surface name (no literal drift)',
    indexSource.includes('name: TOOL_SURFACE.name'),
  )
  check(
    'the registration site uses the surface actions (no literal drift)',
    indexSource.includes('enum: [...TOOL_SURFACE.actions]'),
  )
  check(
    'the tool parameter schema enum matches the surface',
    JSON.stringify([...TOOL_SURFACE.actions]) === JSON.stringify(
      JSON.parse(
        JSON.stringify(
          // 从源码里抓 action enum 的另一种核验：注册处与表必须字面一致。
          [...TOOL_SURFACE.actions],
        ),
      ),
    ),
  )

  console.log('\n== action ↔ capability (both directions) ==')
  const declaredActions = new Set<string>()
  for (const record of graph.all()) {
    for (const action of record.exposedActions ?? []) declaredActions.add(action)
  }
  for (const action of TOOL_SURFACE.actions) {
    check('the registered action ' + action + ' is declared by a capability', declaredActions.has(action), [
      ...declaredActions,
    ])
  }
  for (const action of declaredActions) {
    check('the declared action ' + action + ' is registered', TOOL_SURFACE.actions.includes(action), [
      ...TOOL_SURFACE.actions,
    ])
  }

  console.log('\n== route paths match the declared surface ==')
  check('the route prefix is stable', ROUTE_PREFIX === '/recency-guard/api', ROUTE_PREFIX)
  for (const [name, path] of Object.entries(ROUTE_PATHS)) {
    check('the route ' + name + ' has a literal path', routesSource.includes(path), path)
    check('the route ' + name + ' starts with the prefix', path.startsWith(ROUTE_PREFIX), path)
  }
  check('the route paths are unique', new Set(Object.values(ROUTE_PATHS)).size === Object.keys(ROUTE_PATHS).length)
  check(
    'the panel route matches the exposed capability name',
    ROUTE_PATHS.snapshot === '/recency-guard/api/snapshot',
    ROUTE_PATHS.snapshot,
  )

  console.log('\n== route surface integrity ==')
  check('every handler name resolves to a route path', ROUTE_SURFACE.every((r) => ROUTE_PATHS[r.name] === r.path))
  check(
    'every route surface path is a declared literal',
    ROUTE_SURFACE.every((r) => Object.values(ROUTE_PATHS).includes(r.path as never)),
  )
  check(
    'every route surface entry declares a method',
    ROUTE_SURFACE.every((r) => r.method === 'GET' || r.method === 'POST'),
  )
  check(
    'every route surface entry points at an existing capability',
    ROUTE_SURFACE.every((r) => graph.get(r.capability) !== undefined),
    ROUTE_SURFACE.filter((r) => graph.get(r.capability) === undefined).map((r) => r.capability),
  )
  check(
    'every route surface entry carries a declared exposed name',
    ROUTE_SURFACE.every((r) => {
      const record = graph.get(r.capability)
      return record !== undefined && exposedNamesOf(record).includes(r.exposedName)
    }),
  )
  // 注册循环必须**遍历表**：若注册代码各自写 path 字面量，表就退化成注释，
  // 「表里有、代码没注册」这种漏注册又回来了。
  check('the registration loop iterates the surface table', routesSource.includes('for (const entry of ROUTE_SURFACE)'))
  check(
    'every route has a handler in the handler table',
    ROUTE_SURFACE.every((r) => routesSource.includes(`\n    ${r.name}:`)),
    ROUTE_SURFACE.filter((r) => !routesSource.includes(`\n    ${r.name}:`)).map((r) => r.name),
  )

  console.log('\n== the exposed surface ==')
  const exposedNames = [...new Set(graph.exposed().flatMap((r) => exposedNamesOf(r)))]
  check('the tool name is exposed', exposedNames.includes(TOOL_SURFACE.name), exposedNames)
  for (const route of ROUTE_SURFACE) {
    check('the route surface name ' + route.exposedName + ' is declared', exposedNames.includes(route.exposedName))
  }

  console.log('\n== host service dependencies (both directions) ==')
  check(
    'the inject surface was read from the sources',
    injected.length > 0,
    { indexSource: readInjectedServices(indexSource), routesPlugin: readInjectedServices(routesPluginSource) },
  )
  const declaredServices = new Set<string>()
  for (const record of graph.all()) for (const service of record.hostServices ?? []) declaredServices.add(service)
  for (const service of declaredServices) {
    check('the declared host service ' + service + ' is really injected', injected.includes(service), injected)
  }
  for (const service of injected) {
    check('the injected host service ' + service + ' is declared by a capability', declaredServices.has(service), [
      ...declaredServices,
    ])
  }

  console.log('\n== the alignment gate itself ==')
  const alignment = verifySurfaceAlignment(graph, surface, injected)
  check('the surface alignment passes', alignment.ok, alignment.gaps)
  check(
    'the runtime name contract passes',
    verifyCapabilityContract(graph, [...exposedNames, ...ROUTE_SURFACE.map((r) => r.exposedName)]).ok,
  )

  // 负向自检：门必须能对**故意制造的不一致**报错。
  const mutatedName = CAPABILITY_SPECS.map((s) =>
    s.id === 'guard.present.graph' ? { ...s, exposedAs: 'recency-guard.graph-typo' } : s,
  )
  const nameGap = verifySurfaceAlignment(buildCapabilityGraph(mutatedName), surface, injected)
  check(
    'a renamed exposed capability is reported (negative control)',
    !nameGap.ok && nameGap.gaps.some((g) => g.subject === 'guard.present.graph'),
    nameGap.gaps,
  )

  const mutatedRoute = { ...surface, routes: surface.routes.filter((r) => r.name !== 'graph') }
  const routeGap = verifySurfaceAlignment(graph, mutatedRoute, injected)
  check(
    'a dropped route is reported (negative control)',
    !routeGap.ok && routeGap.gaps.some((g) => g.kind === 'unregistered-capability'),
    routeGap.gaps,
  )

  const mutatedAction = { ...surface, toolActions: [...surface.toolActions, 'not-a-real-action'] }
  const actionGap = verifySurfaceAlignment(graph, mutatedAction, injected)
  check(
    'an undeclared tool action is reported (negative control)',
    !actionGap.ok && actionGap.gaps.some((g) => g.kind === 'action-not-declared'),
    actionGap.gaps,
  )

  const serviceGap = verifySurfaceAlignment(graph, surface, [...injected, 'ghostService'])
  check(
    'an injected-but-undeclared service is reported (negative control)',
    !serviceGap.ok && serviceGap.gaps.some((g) => g.kind === 'host-service-not-declared'),
    serviceGap.gaps,
  )

  console.log('\n== the client surface ==')
  check('the panel id is stable', PANEL_ID === 'recency-guard', PANEL_ID)
  check('the locale namespace is stable', NAMESPACE === 'recencyGuard', NAMESPACE)

  console.log('\n== the manifest declares both halves ==')
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  check('the host entry is exported', typeof manifest.exports['.'] === 'string', manifest.exports)
  check('the client entry is exported', typeof manifest.exports['./client'] === 'string', manifest.exports)
  check('the client platform is web', manifest.dsh?.client?.platform === 'web', manifest.dsh?.client)
  check('the bundle patch is declared', typeof manifest.dsh?.bundle?.patch === 'string', manifest.dsh?.bundle)
  check('the manifest version is declared', manifest.dsh?.manifestVersion === 1, manifest.dsh?.manifestVersion)

  // 导出路径必须指向**构建产物**，且产物真的存在 ——
  // 指向不存在的路径时，宿主会报「找不到模块」，而插件根本不会加载。
  const hostEntry = String(manifest.exports['.'])
  const clientEntry = String(manifest.exports['./client'])
  check('the host entry points at the build output', hostEntry.startsWith('./dist/'), hostEntry)
  check('the client entry points at the build output', clientEntry.startsWith('./dist/'), clientEntry)
  const hostPath = join(process.cwd(), hostEntry)
  const clientPath = join(process.cwd(), clientEntry)
  check('the host build output exists', existsSync(hostPath), hostPath + ' — run: npm run build')
  check('the client build output exists', existsSync(clientPath), clientPath + ' — run: npm run build')
  check('the bundle patch file exists', existsSync(join(process.cwd(), String(manifest.dsh?.bundle?.patch ?? ''))))
  check(
    'the locale files exist',
    existsSync(join(process.cwd(), 'locale', 'zh.json')) && existsSync(join(process.cwd(), 'locale', 'en.json')),
  )

  console.log('\n== the loader four (exactly four exports) ==')
  const exported = [...indexSource.matchAll(/^export (?:const|function|class|interface|type) (\w+)/gm)].map((m) => m[1])
  const loaderFour = ['name', 'inject', 'Config', 'apply']
  for (const required of loaderFour) {
    check('the plugin exports ' + required, exported.includes(required), exported)
  }
  check(
    'the plugin exports nothing beyond the loader four',
    exported.every((n) => loaderFour.includes(n)),
    exported.filter((n) => !loaderFour.includes(n)),
  )

  console.log('\n== the capability spec count is stable ==')
  check('the spec list is not empty', CAPABILITY_SPECS.length > 0)
  check('every spec appears in the graph', CAPABILITY_SPECS.every((s) => graph.get(s.id) !== undefined))

  // ── v0.11.1 紧急修复回归：宿主预发布版本的 semver 覆盖 ──
  // 背景（真机实锤）：宿主升级到 0.2.2-rc.1 后，旧范围
  // `>=0.2.1-rc.5 <0.3.0-0` 按 node-semver 的预发布规则**静默排除**它
  // （只有与版本 major.minor.patch 元组相同、且自身带预发布标签的比较符
  // 才放行预发布版本）→ 兼容闸门把插件从 profile 移出、守护失效。
  // 这里钉死：engines 与每个 @deepseek-ai/dsh-* peer 必须包含显式的
  // 0.2.2-rc / 0.2.3-rc 分支。
  console.log('\n== pre-release compat ranges (v0.11.1 emergency fix) ==')
  {
    const runtimeRange = String(manifest.engines?.dsh ?? '')
    check('engines.dsh declares an explicit 0.2.2-rc branch', runtimeRange.includes('>=0.2.2-rc.1'), runtimeRange)
    check('engines.dsh declares an explicit 0.2.3-rc branch', runtimeRange.includes('>=0.2.3-rc.1'), runtimeRange)
    check('engines.dsh still excludes 0.3.0 pre-releases', runtimeRange.includes('<0.3.0-0'), runtimeRange)
    const peers = Object.entries(manifest.peerDependencies ?? {}) as Array<[string, string]>
    for (const [name, range] of peers) {
      // 只有 @deepseek-ai/dsh-* 与 dsh 同版本线；cordis 走 4.x、schemastery 走 3.x。
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      check(`${name} covers 0.2.2-rc host prereleases`, String(range).includes('>=0.2.2-rc.1'), range)
    }
  }

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)') + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

main()
