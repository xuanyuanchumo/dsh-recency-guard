/**
 * 视口原语 —— 缩放 / 平移 / 适配视图，全部**纯函数**。
 *
 * 为什么必须是纯函数而不是写在组件的 useState 里
 * ----------------------------------------------
 * 图区交互的三个真实缺陷形态，在组件里一个都测不出来：
 *
 * 1. **锚点算错**：滚轮缩放若不按「指针下的图坐标保持不动」算，而是简单乘
 *    比例，用户滚一下，视线里的那个节点就飞出屏幕 —— 用户只会说"缩放很难用"，
 *    而组件测试能看到的只有 `scale` 变大了（正确）。
 * 2. **边界不钳制**：用户可以一直滚到 `scale=0.01`，整张图塌成一个点，
 *    再也点不中"放大"按钮（它自己也缩在视口外）；或 `scale=99` 只剩一个圆。
 *    钳制逻辑写成纯函数才能对**每一档边界**断言。
 * 3. **平移无界**：拖拽能把整张图拖出视口，之后**没有任何手势能把它拖回来**
 *    —— 这是地图类控件最常见的死锁。
 *
 * 本文件只认数字：`Viewport = { scale, tx, ty }` 表示「世界坐标 → 屏幕坐标」
 * 的变换 `screen = world * scale + t`。它不知道 SVG、不知道指针、也不知道滚轮，
 * 因此能在无 DOM 的环境里逐条断言。
 */

/** 缩放上下限。0.25 时仍能看出结构；4 时单个节点足够点中。 */
export const SCALE_MIN = 0.25
export const SCALE_MAX = 4

/** 缩放步长。 */
export const ZOOM_STEP = 1.15

export interface Viewport {
  scale: number
  tx: number
  ty: number
}

export interface Size {
  width: number
  height: number
}

/** 世界坐标下的矩形。 */
export interface Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

/** 屏幕坐标点（指针位置）。 */
export interface Point {
  x: number
  y: number
}

/** 恒等视口。 */
export const IDENTITY: Viewport = { scale: 1, tx: 0, ty: 0 }

/** 非有限值（NaN / ±Infinity）回落到兜底 —— 一个 NaN scale 会让整张图消失。 */
function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/** 钳制缩放比例。 */
export function clampScale(scale: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, finite(scale, 1)))
}

/**
 * 以**屏幕坐标 anchor** 为不动点缩放：缩放前后 anchor 处的世界坐标不变。
 *
 * 推导：世界点 w 在屏幕上是 `w * s + t`。要求 `w * s0 + t0 === w * s1 + t1`，
 * 且 `w = (anchor - t0) / s0`，解得 `t1 = anchor - (anchor - t0) * s1 / s0`。
 * 按 `t1 = t0` 或按中心缩放都会让视线漂移。
 */
export function zoomAt(viewport: Viewport, anchor: Point, nextScale: number): Viewport {
  const s0 = clampScale(viewport.scale)
  const s1 = clampScale(nextScale)
  const ax = finite(anchor.x, 0)
  const ay = finite(anchor.y, 0)
  const ratio = s1 / s0
  return {
    scale: s1,
    tx: ax - (ax - viewport.tx) * ratio,
    ty: ay - (ay - viewport.ty) * ratio,
  }
}

/** 按倍数缩放，锚点同上。 */
export function zoomBy(viewport: Viewport, anchor: Point, factor: number): Viewport {
  return zoomAt(viewport, anchor, clampScale(viewport.scale) * finite(factor, 1))
}

/**
 * 双指捏合（v0.11.4 触屏交互补齐）。
 *
 * 语义：**两指中点下的世界点**在捏合前后保持不动 —— 与单指缩放同一不变式
 * （`zoomAt` 的推导），同时中点位移会带动画布平移（手指拖动画面）。
 *
 * 为什么不用 `zoomBy(中点)` 再 `panBy` 两步：两步各自把「中点」当屏幕坐标，
 * 但捏合过程中**中点在变**；先缩放再平移会以旧中点锚定，世界点会漂移。
 * 这里一次解出 `t1 = nextMid - world(prevMid) * s1` —— 缩放与跟随同时成立。
 *
 * 退化输入（两点重合 / 非有限值）返回原视口：捏合手势刚开始时两指可能
 * 几乎在同一像素，除零会得到 Infinity 并污染视口。
 */
export function pinchViewport(
  viewport: Viewport,
  prev: { a: Point; b: Point },
  next: { a: Point; b: Point },
): Viewport {
  const prevDx = finite(prev.b.x, 0) - finite(prev.a.x, 0)
  const prevDy = finite(prev.b.y, 0) - finite(prev.a.y, 0)
  const nextDx = finite(next.b.x, 0) - finite(next.a.x, 0)
  const nextDy = finite(next.b.y, 0) - finite(next.a.y, 0)
  const prevDist = Math.hypot(prevDx, prevDy)
  const nextDist = Math.hypot(nextDx, nextDy)
  if (!(prevDist > 0.01) || !Number.isFinite(nextDist)) return viewport
  const s0 = clampScale(viewport.scale)
  const s1 = clampScale((s0 * nextDist) / prevDist)
  const prevMid = { x: (finite(prev.a.x, 0) + finite(prev.b.x, 0)) / 2, y: (finite(prev.a.y, 0) + finite(prev.b.y, 0)) / 2 }
  const nextMid = { x: (finite(next.a.x, 0) + finite(next.b.x, 0)) / 2, y: (finite(next.a.y, 0) + finite(next.b.y, 0)) / 2 }
  // prevMid 下的世界点在缩放后必须落在 nextMid：w = (prevMid - t0) / s0。
  const worldX = (prevMid.x - viewport.tx) / s0
  const worldY = (prevMid.y - viewport.ty) / s0
  return { scale: s1, tx: nextMid.x - worldX * s1, ty: nextMid.y - worldY * s1 }
}

/** 视口中心（按钮缩放以视图中心为锚 —— 用户的注意力在画面中央）。 */
export function centerOf(size: Size): Point {
  return { x: finite(size.width, 0) / 2, y: finite(size.height, 0) / 2 }
}

/** 平移。 */
export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return {
    scale: clampScale(viewport.scale),
    tx: viewport.tx + finite(dx, 0),
    ty: viewport.ty + finite(dy, 0),
  }
}

/**
 * 平移边界钳制。
 *
 * 世界矩形缩放后若**比视口小**就居中（拖出空白没有意义，且另一侧的空白
 * 也拖不回来）；若比视口大，则允许拖动但保证**至少留 `margin` 像素的图可见**
 * —— 完全拖出屏幕后没有任何手势能把图找回来，那是死锁而不只是"不美观"。
 */
export function clampPan(viewport: Viewport, size: Size, bounds: Rect, margin = 48): Viewport {
  const scale = clampScale(viewport.scale)
  /**
   * 单轴钳制。
   *
   * `origin` 是该轴的世界原点（bounds.minX / bounds.minY）：世界矩形可能
   * 不从 0 开始（图布局有 padding）。两个边界都必须把原点算进去，
   * 否则内容会被平移半个原点的距离 —— 看起来「居中但偏了一点」。
   *
   * 两种情形：
   *   ① 内容比视口小 → **居中**（拖出空白没有意义，且另一侧的空白也拖不回来）。
   *   ② 内容比视口大 → 限制偏移，使「内容可见区」至少保留 margin 像素：
   *      左缘 = origin*scale + t ≤ viewportPx - margin  （不能整块拖到右边外）
   *      右缘 = origin*scale + t + worldPx ≥ margin     （不能整块拖到左边外）
   *      两条解出 t 的闭区间 [lo, hi]。
   */
  const clampAxis = (t: number, viewportPx: number, worldPx: number, origin: number): number => {
    if (worldPx <= viewportPx) return (viewportPx - worldPx) / 2 - origin * scale
    const hi = viewportPx - margin - origin * scale
    const lo = margin - origin * scale - worldPx
    return Math.min(hi, Math.max(lo, finite(t, hi)))
  }
  const width = finite(size.width, 0)
  const height = finite(size.height, 0)
  return {
    scale,
    tx: clampAxis(viewport.tx, width, bounds.width * scale, bounds.minX),
    ty: clampAxis(viewport.ty, height, bounds.height * scale, bounds.minY),
  }
}

/**
 * 适配视图 —— 把整个图放进视口。
 *
 * @param margin 四周留白（像素）
 */
export function fitToView(bounds: Rect, size: Size, margin = 16): Viewport {
  const width = finite(size.width, 0)
  const height = finite(size.height, 0)
  if (bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) return IDENTITY
  const scale = clampScale(
    Math.min((width - margin * 2) / bounds.width, (height - margin * 2) / bounds.height),
  )
  return {
    scale,
    tx: margin - bounds.minX * scale + (width - margin * 2 - bounds.width * scale) / 2,
    ty: margin - bounds.minY * scale + (height - margin * 2 - bounds.height * scale) / 2,
  }
}

/** 世界坐标 → 屏幕坐标。 */
export function worldToScreen(viewport: Viewport, point: Point): Point {
  return { x: point.x * viewport.scale + viewport.tx, y: point.y * viewport.scale + viewport.ty }
}

/** 屏幕坐标 → 世界坐标。 */
export function screenToWorld(viewport: Viewport, point: Point): Point {
  return { x: (point.x - viewport.tx) / viewport.scale, y: (point.y - viewport.ty) / viewport.scale }
}

/**
 * 命中测试 —— 找出被点击的节点。
 *
 * 数据结构：把节点索引成**网格**（cell size = 节点最大尺寸），
 * 查询时只检查点击位置所在格与相邻格，而不是扫描全部节点。
 * 复杂度从 O(N) 降到 O(1)（节点均匀分布时）。
 *
 * @param nodes 节点（含 x/y 与尺寸）
 * @param point 世界坐标
 */
export interface HitNode {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** 命中测试的容差（世界坐标像素）。 */
export const HIT_TOLERANCE = 6

/**
 * 网格索引 —— 节点按所在格分组。
 *
 * 数据结构选择：哈希网格（Map<cellKey, node[]>）而非四叉树。
 * 理由：节点规模在几十~几百，网格的构建是 O(N)、查询是 O(1)，
 * 且**实现只有二十行**；四叉树在这个规模上收益微乎其微，
 * 却是数百行难以验证的代码。
 */
export class SpatialGrid {
  private readonly cells = new Map<string, HitNode[]>()
  private readonly cellSize: number

  constructor(nodes: readonly HitNode[], cellSize = 120) {
    this.cellSize = cellSize
    for (const node of nodes) {
      const key = this.keyOf(node.x + node.w / 2, node.y + node.h / 2)
      const list = this.cells.get(key) ?? []
      list.push(node)
      this.cells.set(key, list)
    }
  }

  private keyOf(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)}:${Math.floor(y / this.cellSize)}`
  }

  /** 命中测试：返回点击位置上的节点（没有则 null）。 */
  hit(point: Point, tolerance = HIT_TOLERANCE): HitNode | null {
    const cx = Math.floor(point.x / this.cellSize)
    const cy = Math.floor(point.y / this.cellSize)
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const list = this.cells.get(`${cx + dx}:${cy + dy}`)
        if (!list) continue
        for (const node of list) {
          if (
            point.x >= node.x - tolerance &&
            point.x <= node.x + node.w + tolerance &&
            point.y >= node.y - tolerance &&
            point.y <= node.y + node.h + tolerance
          ) {
            return node
          }
        }
      }
    }
    return null
  }
}

/**
 * 把线段端点裁剪到矩形边界 —— 边的箭头贴在节点卡片边缘而不是扎进卡片中心。
 *
 * 数学：把线段参数化为 P(t) = A + t·(B−A)，对节点的四条边界各解一次
 * 线性方程，取**靠近 B 端**的合法 t（0≤t≤1），没有交点就退回原端点。
 *
 * 为什么不用「按中心角旋转」的近似：矩形不是圆，角度法在长边中点处
 * 会留出肉眼可见的缝隙或穿模；解析求交是 O(1) 且逐像素精确。
 */
export function clipToRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rect: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
  const dx = bx - ax
  const dy = by - ay
  // 四条边界：x = rect.x、x = rect.x+w、y = rect.y、y = rect.y+h。
  const candidates: Array<{ t: number }> = []
  if (dx !== 0) {
    candidates.push({ t: (rect.x - ax) / dx })
    candidates.push({ t: (rect.x + rect.w - ax) / dx })
  }
  if (dy !== 0) {
    candidates.push({ t: (rect.y - ay) / dy })
    candidates.push({ t: (rect.y + rect.h - ay) / dy })
  }
  // 合法交点：参数在 [0,1] 且交点确实落在矩形上（浮点容差 1e-6）。
  // 取**最小** t —— 线段第一次触碰矩形边界的地方（进入点）。
  // 取最大 t 会得到「离开点」：B 在矩形内部时它就是 B 自己，等于没裁。
  let best = Infinity
  for (const { t } of candidates) {
    if (t < 0 || t > 1) continue
    const x = ax + t * dx
    const y = ay + t * dy
    const inside =
      x >= rect.x - 1e-6 && x <= rect.x + rect.w + 1e-6 && y >= rect.y - 1e-6 && y <= rect.y + rect.h + 1e-6
    if (inside && t < best) best = t
  }
  if (!Number.isFinite(best)) return { x: bx, y: by }
  return { x: ax + best * dx, y: ay + best * dy }
}

/**
 * 邻接追溯 —— 从某个节点出发，沿边找到可达的其它节点。
 *
 * 算法：**BFS**（广度优先）而非 DFS —— BFS 给出的是「最少跳数可达」，
 * 正好对应用户心里的「直接相关」；DFS 会先走到很远的节点，用户会以为
 * 「这个和那个没关系」。
 *
 * 复杂度 O(V + E)。
 */
export function traceFrom(
  startId: string,
  edges: ReadonlyArray<{ from: string; to: string }>,
  direction: 'outgoing' | 'incoming' | 'both' = 'outgoing',
): Set<string> {
  const adjacency = new Map<string, string[]>()
  const push = (from: string, to: string): void => {
    const list = adjacency.get(from) ?? []
    list.push(to)
    adjacency.set(from, list)
  }
  for (const edge of edges) {
    if (direction === 'outgoing' || direction === 'both') push(edge.from, edge.to)
    if (direction === 'incoming' || direction === 'both') push(edge.to, edge.from)
  }
  const visited = new Set<string>([startId])
  const queue: string[] = [startId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      queue.push(next)
    }
  }
  return visited
}

/**
 * 曲线边的 SVG 路径 —— 二次贝塞尔（Q 指令）。
 *
 * 为什么用二次而不是三次贝塞尔：一条边的形状只需要一个控制点来表达
 * 「往哪边弯、弯多少」，二次贝塞尔的中间点公式（t=0.5 时 0.25A+0.5C+0.25B）
 * 也是闭式的，标签定位无需数值积分。三次贝塞尔多出的一个控制点在这里
 * 只会增加「两个端各调一个参数」的对齐负担。
 *
 * curvature 为 0（或两端重合）时退化为直线 —— 与旧行为逐字节一致，
 * 老测试不用改。
 */
export function curveControl(ax: number, ay: number, bx: number, by: number, curvature: number): Point {
  const dx = bx - ax
  const dy = by - ay
  const length = Math.hypot(dx, dy)
  if (curvature === 0 || length < 1e-6) return { x: (ax + bx) / 2, y: (ay + by) / 2 }
  // 单位法向量（垂直于连线方向）：把控制点从线段中点沿法线推开。
  const nx = -dy / length
  const ny = dx / length
  return { x: (ax + bx) / 2 + nx * curvature, y: (ay + by) / 2 + ny * curvature }
}

export function curveEdgePath(ax: number, ay: number, bx: number, by: number, curvature = 0): string {
  const c = curveControl(ax, ay, bx, by, curvature)
  if (curvature === 0) return `M ${ax} ${ay} L ${bx} ${by}`
  return `M ${ax} ${ay} Q ${c.x} ${c.y} ${bx} ${by}`
}

/**
 * 平行边索引 —— 同一对端点（不分方向）之间已有多少条同伙边。
 *
 * 纯函数：输入边的顺序即遍历顺序，输出与输入同长；第 i 条边的值 =
 * 在它之前与它共享同一端点对（from-to 或 to-from 视为同一对）的边数。
 * 供 parallelCurvature 把同一对端点的多条边错开成不同弯曲方向。
 */
export function parallelIndexes(edges: ReadonlyArray<{ from: string; to: string }>): number[] {
  const seen = new Map<string, number>()
  const out: number[] = []
  for (const edge of edges) {
    const key = edge.from < edge.to ? `${edge.from}\u0000${edge.to}` : `${edge.to}\u0000${edge.from}`
    const index = seen.get(key) ?? 0
    out.push(index)
    seen.set(key, index + 1)
  }
  return out
}

/** 二次贝塞尔在 t=0.5 处的点（闭式：0.25·A + 0.5·C + 0.25·B）。 */
export function midpointOfQuadratic(
  ax: number,
  ay: number,
  cx: number,
  cy: number,
  bx: number,
  by: number,
): Point {
  return {
    x: 0.25 * ax + 0.5 * cx + 0.25 * bx,
    y: 0.25 * ay + 0.5 * cy + 0.25 * by,
  }
}

/**
 * 平行边的曲率分配 —— 同一对端点之间的第 i 条边弯向交替、幅度递增。
 *
 * 序列：i=0 → 0（直线），i=1 → +18，i=2 → −18，i=3 → +36 ……
 * 奇偶交替保证两条平行边一左一右分开，而不是挤在同一次弯曲里。
 * 返回 0 表示用直线（与唯一边一致），因此常见情形（无平行边）零成本。
 */
export function parallelCurvature(parallelIndex: number, unit = 18): number {
  if (parallelIndex <= 0) return 0
  const magnitude = Math.ceil(parallelIndex / 2) * unit
  return parallelIndex % 2 === 1 ? magnitude : -magnitude
}

/**
 * 搜索匹配 —— 按 id / 标签 / 引用对象做大小写不敏感的子串匹配。
 *
 * 返回按「id 精确 → 前缀 → 子串」优先级排序的节点列表：输入 `panel`
 * 时精确 id 优先于标签里碰巧含 panel 的节点，避免「定位」跳到错误的节点。
 */
export function matchNodes<T extends { id: string; label: string; ref?: string }>(
  nodes: readonly T[],
  query: string,
  limit = 8,
): T[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const scored: Array<{ node: T; rank: number }> = []
  for (const node of nodes) {
    const id = node.id.toLowerCase()
    const label = node.label.toLowerCase()
    const ref = (node.ref ?? '').toLowerCase()
    let rank: number | null = null
    if (id === q || ref === q) rank = 0
    else if (id.startsWith(q) || ref.startsWith(q)) rank = 1
    else if (label.startsWith(q)) rank = 2
    else if (id.includes(q) || ref.includes(q) || label.includes(q)) rank = 3
    if (rank !== null) scored.push({ node, rank })
  }
  scored.sort((a, b) => a.rank - b.rank || a.node.id.localeCompare(b.node.id))
  return scored.slice(0, limit).map((s) => s.node)
}

/**
 * 把一个世界坐标点放到视口中央。
 *
 * 推导：screen = world·scale + t ⇒ t = center − world·scale。
 * 不在这里做边界钳制：钳制是视口策略（clampPan），居中是定位原语，
 * 组合责任留给调用方（组件统一走 apply()）。
 */
export function centerOn(viewport: Viewport, size: Size, world: Point, targetScale?: number): Viewport {
  const scale = clampScale(targetScale ?? viewport.scale)
  return {
    scale,
    tx: finite(size.width, 0) / 2 - world.x * scale,
    ty: finite(size.height, 0) / 2 - world.y * scale,
  }
}
