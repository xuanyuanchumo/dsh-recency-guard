import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react'
import { t } from '../i18n/i18n.ts'
import { errorSummary } from './panel-model.ts'

/**
 * 面板错误边界 —— 单个卡片渲染抛错时不让整块面板白屏。
 *
 * ## 为什么需要这一层（v0.16）
 *
 * 面板是守护的**唯一可见面**：宿主数据面出一个异常字段，React 19 的
 * 默认行为是卸载整棵子树 —— 用户看到的是「面板没了」，而不是「某张卡
 * 坏了」。对观测设施来说，「坏了但看得见」远好过「什么都不显示」：
 * 后者会被读成「守护没运行」。
 *
 * ## 三个必须守住的细节
 *
 * 1. **错误摘要可复制**：用户报障时最需要的是 name + message + 栈顶。
 *    只显示「出错了」等于把排查成本转嫁给下一个人。
 * 2. **重试要重置边界**：若只调用外部 onRetry 而不清 error，重新渲染时
 *    边界仍短路，按钮看起来「点了没反应」。
 * 3. **复制失败不抛**：clipboard 在非安全上下文/无权限时会 reject；
 *    这属于可选优化，不能反过来否决错误信息本身（与 pointer capture
 *    同一条纪律：次要能力不得排挤主功能）。
 *
 * 类组件是 React 目前唯一能捕获子树渲染错误的形态（Hooks 没有
 * componentDidCatch 等价物），因此这里是本仓库唯一允许的类组件。
 */
interface PanelErrorBoundaryProps {
  children: ReactNode
  /** 用户点「重试」时的外部动作（例如重新拉取快照）。 */
  onRetry: () => void
}

interface PanelErrorBoundaryState {
  /** null = 正常渲染；字符串 = 已捕获错误的可复制摘要。 */
  error: string | null
  copied: boolean
}

export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { error: null, copied: false }

  static getDerivedStateFromError(error: unknown): PanelErrorBoundaryState {
    return { error: errorSummary(error), copied: false }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // 保留到控制台：错误摘要进 UI 是给用户的，组件栈是给开发者的。
    // 这里用 console.error 而不是吞掉 —— 静默捕获会让「面板降级了」这件事
    // 在日志里也消失，等于同时拿掉了两条排查通道。
    console.error('[recency-guard] panel render failed', error, info.componentStack)
  }

  private readonly retry = (): void => {
    this.setState({ error: null, copied: false })
    this.props.onRetry()
  }

  private readonly copy = (): void => {
    const summary = this.state.error ?? ''
    try {
      const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } })
        .navigator?.clipboard
      // 可选能力：失败只影响「复制」这一个便利，绝不能反过来把错误页打崩。
      // 先取出 promise 再挂 then：`?.(...)` 在 clipboard 缺席时返回 undefined，
      // 直接链 `.then` 会抛 TypeError（正是「错误处理路径自己再抛」的形态）。
      const pending = clipboard?.writeText?.(summary)
      if (pending !== undefined) {
        void pending.then(
          () => this.setState({ copied: true }),
          () => undefined,
        )
      }
    } catch {
      /* clipboard 不可用：摘要仍完整显示在 <pre> 里，用户可手动选中复制 */
    }
  }

  render(): ReactElement {
    if (this.state.error !== null) {
      return (
        <div className="rg-error-boundary" role="alert">
          <h2 className="rg-state-title">{t('error.title')}</h2>
          <p className="rg-empty">{t('error.hint')}</p>
          <pre className="rg-error-summary" aria-label={t('error.summary')}>
            {this.state.error}
          </pre>
          <div className="rg-error-actions">
            <button type="button" className="rg-button" onClick={this.retry}>
              {t('error.retry')}
            </button>
            <button type="button" className="rg-button" onClick={this.copy}>
              {this.state.copied ? t('error.copied') : t('error.copy')}
            </button>
          </div>
        </div>
      )
    }
    return <>{this.props.children}</>
  }
}