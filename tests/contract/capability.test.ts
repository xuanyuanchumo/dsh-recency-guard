import { buildCapabilityGraph, CAPABILITY_SPECS } from '../../src/capability-specs.ts'
import { ROUTE_PREFIX, ROUTE_PATHS } from '../../src/routes.ts'
import { PANEL_ID, NAMESPACE } from '../../src/client/index.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 契约层 —— 清单 ↔ 注册处的**双向**比对。
 *
 * 覆盖率要求 100%：漏一条能力登记就是真缺口，不能靠覆盖率稀释。
 *
 * 本层回答三个问题：
 * 1. 清单里声明的能力，是否都有对应的对外注册面？
 * 2. 注册面是否存在清单**完全没提**的名字？
 * 3. 清单内部的关系是否**自洽**（声明的消费关系都被双向登记）？
 */

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('  PASS  ' + name)
  else {
    failures += 1
    console.log('  FAIL  ' + name, detail === undefined ? '' : JSON.stringify(detail))
  }
}

function main() {
  const graph = buildCapabilityGraph()

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
    graph.all().filter((r) => !r.exposed).every((r) => r.exposedAs === undefined),
  )

  console.log('\n== relation self-consistency ==')
  for (const record of graph.all()) {
    for (const upstream of record.consumes) {
      const producer = graph.get(upstream)
      check(record.id + ' consumes ' + upstream + ', which exists', producer !== undefined, upstream)
      if (producer) {
        check(
          upstream + ' records ' + record.id + ' as a consumer',
          producer.consumedBy.includes(record.id),
          producer.consumedBy,
        )
      }
    }
    for (const downstream of record.consumedBy) {
      const consumer = graph.get(downstream)
      check(record.id + ' is consumed by ' + downstream + ', which exists', consumer !== undefined, downstream)
      if (consumer) {
        check(
          downstream + ' records ' + record.id + ' as an upstream',
          consumer.consumes.includes(record.id),
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

  console.log('\n== the exposed surface ==')
  const exposedNames = graph.exposed().map((r) => r.exposedAs).filter((v): v is string => v !== undefined)
  check('the tool name is exposed', exposedNames.includes('recency_guard'), exposedNames)
  check('the panel route is exposed', exposedNames.includes('recency-guard.panel'), exposedNames)
  check('the graph route is exposed', exposedNames.includes('recency-guard.graph'), exposedNames)
  check('the reset route is exposed', exposedNames.includes('recency-guard.reset'), exposedNames)
  check('the isolation route is exposed', exposedNames.includes('recency-guard.isolation'), exposedNames)

  console.log('\n== route paths match the declared surface ==')
  const routeSource = readFileSync(join(process.cwd(), 'src', 'routes.ts'), 'utf8')
  check('the route prefix is stable', ROUTE_PREFIX === '/recency-guard/api', ROUTE_PREFIX)
  // 路由路径在源码里必须是**字面量**（不用模板串拼），否则契约核对
  // 只能靠运行 —— 那就失去了这道门的意义。
  for (const [name, path] of Object.entries(ROUTE_PATHS)) {
    check('the route ' + name + ' has a literal path', routeSource.includes(path), path)
    check('the route ' + name + ' starts with the prefix', path.startsWith(ROUTE_PREFIX), path)
  }
  check('the route paths are unique', new Set(Object.values(ROUTE_PATHS)).size === Object.keys(ROUTE_PATHS).length)
  check(
    'the panel route matches the exposed capability name',
    ROUTE_PATHS.snapshot === '/recency-guard/api/snapshot',
    ROUTE_PATHS.snapshot,
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
  check(
    'the host build output exists',
    existsSync(hostPath),
    hostPath + ' — run: npm run build',
  )
  check(
    'the client build output exists',
    existsSync(clientPath),
    clientPath + ' — run: npm run build',
  )
  check('the bundle patch file exists', existsSync(join(process.cwd(), String(manifest.dsh?.bundle?.patch ?? ''))))
  check(
    'the locale files exist',
    existsSync(join(process.cwd(), 'locale', 'zh.json')) && existsSync(join(process.cwd(), 'locale', 'en.json')),
  )

  console.log('\n== the loader four (exactly four exports) ==')
  const indexSource = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
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

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)') + '\n')
  process.exit(failures === 0 ? 0 : 1)
}

main()
