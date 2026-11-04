/**
 * CSS 模块的类型声明。
 *
 * `allowArbitraryExtensions` 的约定：模块 `foo.css` 的类型由**同名**的
 * `foo.d.css.ts` 提供（`styles.css` → `styles.d.css.ts`）。
 *
 * 构建时 esbuild 的 `text` loader 把样式表作为**字符串**内联进产物
 * （运行时零 IO，且样式只有一份真相源）。
 */
declare const content: string
export default content
