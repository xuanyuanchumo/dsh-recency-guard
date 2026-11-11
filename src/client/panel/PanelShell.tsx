import { useState, type ReactElement } from 'react'
import { GuardPanel, type GuardPanelProps } from './GuardPanel.tsx'
import { PanelErrorBoundary } from './PanelErrorBoundary.tsx'

/**
 * 面板外壳 —— 把错误边界放在**整个面板之外**。
 *
 * 为什么不能只包内容区：GuardPanel 自己的 header 也在渲染快照字段
 * （profile / 分区路径 / 动作按钮），任何一处抛错都会让整棵子树卸载 ——
 * 内容区边界救不到 header。外壳用 epoch 作为 key：重试时整块重挂，
 * 比不重置 key 的「清了 error 又立刻被同一个错误捕获」更可靠
 * （后者在按钮上看起来就是「点了没反应」）。
 */
export function PanelShell(props: GuardPanelProps): ReactElement {
  const [epoch, setEpoch] = useState(0)
  return (
    <PanelErrorBoundary key={epoch} onRetry={() => setEpoch((current) => current + 1)}>
      <GuardPanel {...props} />
    </PanelErrorBoundary>
  )
}