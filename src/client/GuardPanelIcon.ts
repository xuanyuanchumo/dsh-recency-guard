import { createElement, type ReactElement } from 'react'
import { t } from './i18n.ts'

/**
 * 侧栏图标 —— 守护面板的入口。
 *
 * 席位 `sidebar.panellist` 的 ownerProps 是
 * `{ size: number; active: boolean }`：**宿主告诉图标该画多大**，
 * 以及当前是否被选中。图标必须按传入的 size 绘制（不写死像素），
 * 否则在不同密度/折叠态下会比例失真。
 *
 * 图标是**原创**几何图形（盾 + 心跳线），不复制任何第三方美术资源。
 */
export interface GuardPanelIconProps {
  /** 宿主请求的方形边长（像素）。 */
  size?: number
  /** 是否是当前选中的面板。 */
  active?: boolean
}

export function GuardPanelIcon(props: GuardPanelIconProps): ReactElement {
  const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20
  const active = props.active === true
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      role: 'img',
      'aria-label': t('panel.title'),
      'aria-hidden': active ? undefined : 'true',
    },
    createElement('title', { key: 'title' }, t('panel.title')),
    // 盾牌轮廓：守护的隐喻。
    createElement('path', {
      key: 'shield',
      d: 'M12 2.5 4.5 5.2v6.1c0 4.6 3.1 8.9 7.5 10.2 4.4-1.3 7.5-5.6 7.5-10.2V5.2L12 2.5Z',
      stroke: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
      strokeWidth: 1.6,
      strokeLinejoin: 'round',
      fill: active ? 'var(--dsw-alias-brand-primary)' : 'none',
      fillOpacity: active ? 0.14 : 0,
    }),
    // 心跳线：崩溃检测的隐喻。
    createElement('path', {
      key: 'pulse',
      d: 'M6.8 12h2.6l1.5-3.4 2 6.2 1.6-2.8h2.7',
      stroke: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      fill: 'none',
    }),
  )
}
