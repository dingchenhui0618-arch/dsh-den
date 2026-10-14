/**
 * A minimal renderer for the panel's element tree.
 *
 * Shared by the interaction harness and its self-test, because the two must not
 * drift: a bug in this walker looks exactly like a bug in the panel.
 *
 * The panel's components are plain functions returning plain objects, so
 * "rendering" means calling a function component and flattening the result. Two
 * details are easy to get wrong and both were, on the first attempt:
 *
 *   1. A function `type` must be *called*, not recorded — otherwise the walker
 *      sees a tree of one node and all the panel's text reads as empty.
 *   2. `createElement(type, props, ...children)` keeps children on the element,
 *      but a component like `Button` reads them from `props.children`. Both
 *      places have to be walked.
 */

export function createElement(type, props, ...children) {
  return {
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }
}

/** Flatten an element tree into walkable nodes, executing function components. */
export function collect(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ kind: 'text', text: String(node) })
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (typeof node.type === 'function') {
    // Real React hands a component `props` *including* `children`. Calling it with
    // `node.props` alone silently drops every label a component renders out of
    // `props.children` — which is precisely how `Button` renders its text, so the
    // walker saw unlabelled buttons and could not address any of them.
    const props = { ...(node.props ?? {}) }
    if (node.children !== undefined && node.children.length) props.children = node.children
    return collect(node.type(props), out)
  }

  const entry = { kind: 'element', type: node.type, props: node.props ?? {}, children: [] }
  out.push(entry)

  // Children may arrive on the element (from `...children`) or on `props`
  // (because the component read them there). Walk whichever exist, and do not
  // double-walk the same array — that duplicates every text node in the tree.
  const fromElement = Array.isArray(node.children) ? node.children : []
  const fromProps = Array.isArray(node.props?.children)
    ? node.props.children
    : node.props?.children !== undefined
      ? [node.props.children]
      : []
  const primary = fromElement.length ? fromElement : fromProps
  const secondary = fromElement.length && fromProps.length && fromProps[0] !== fromElement[0] ? fromProps : []
  if (primary.length) collect(primary, entry.children)
  if (secondary.length) collect(secondary, entry.children)
  return out
}

export function findAll(tree, predicate, out = []) {
  if (Array.isArray(tree)) {
    for (const node of tree) findAll(node, predicate, out)
    return out
  }
  if (!tree || typeof tree !== 'object') return out
  if (tree.kind === 'element' && predicate(tree)) out.push(tree)
  if (tree.children) findAll(tree.children, predicate, out)
  return out
}

export function textOf(node) {
  if (!node) return ''
  if (node.kind === 'text') return node.text
  return (node.children ?? []).map(textOf).join('')
}

export function allText(tree) {
  return findAll(tree, () => true).map(textOf).join(' ')
}

/* --------------------------------------------------------------- static preview */

/**
 * Style properties whose bare number means pixels.
 *
 * Without this table `fontSize: 12` renders as `font-size:12` — an invalid declaration the browser
 * drops, so the preview page would be laid out in the browser's defaults while claiming to show the
 * panel. A preview that silently drops half its styles is worse than none: the whole reason to
 * generate one from the renderer is that it can be trusted to look like the real thing.
 */
const LENGTH_PROPS = new Set([
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'fontSize', 'gap', 'rowGap', 'columnGap', 'borderRadius', 'borderWidth',
  'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'top', 'right', 'bottom', 'left', 'letterSpacing', 'flexBasis',
])

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input'])

/** Escape text for HTML. Panel copy is plain text, but a preview must not execute what it shows. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
}

function styleOf(style) {
  if (!style || typeof style !== 'object') return ''
  const parts = []
  for (const [key, value] of Object.entries(style)) {
    if (value === null || value === undefined || value === false) continue
    const css = key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)
    const unit = typeof value === 'number' && LENGTH_PROPS.has(key) ? 'px' : ''
    parts.push(`${css}:${value}${unit}`)
  }
  return parts.join(';')
}

/** Serialize a collected tree (see `collect`) into HTML. */
export function toHtml(tree) {
  const nodes = Array.isArray(tree) ? tree : [tree]
  return nodes
    .map((node) => {
      if (!node) return ''
      if (node.kind === 'text') return escapeHtml(node.text)
      const type = typeof node.type === 'string' ? node.type : 'div'
      const props = node.props ?? {}
      const attrs = []
      if (props.className) attrs.push(`class="${escapeHtml(props.className)}"`)
      if (typeof props.type === 'string') attrs.push(`type="${escapeHtml(props.type)}"`)
      if (typeof props.placeholder === 'string') attrs.push(`placeholder="${escapeHtml(props.placeholder)}"`)
      if (props.value !== undefined && props.value !== null) attrs.push(`value="${escapeHtml(props.value)}"`)
      if (props.disabled) attrs.push('disabled')
      const style = styleOf(props.style)
      if (style) attrs.push(`style="${escapeHtml(style)}"`)
      const open = `<${type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`
      if (VOID_TAGS.has(type)) return open
      return `${open}${toHtml(node.children ?? [])}</${type}>`
    })
    .join('')
}

/**
 * Wrap rendered trees in a standalone preview page.
 *
 * Honesty is built into the shape of this page, not bolted on: the markup is the panel's own (it
 * comes from the same renderer the checks use, so it cannot drift), the *data* is demo data, and
 * the page says so. The colours are the host's real palette: the twenty values below were extracted
 * from DSH's own tokens by the user's phone client (`dsh-in-hand-ui/lib/tokens.css`) and are copied
 * here rather than eyeballed, so the preview is not showing an approximation of the product's
 * colours. Only `--demo-page` is the preview's own canvas — the host sets that outside a component's
 * reach — and it is named separately so it cannot be mistaken for a token.
 */
export function demoPage({ title, note, sections, generatedBy }) {
  const styles = `
:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#fff;--dsw-alias-bg-layer-3:#fff;
--dsw-alias-border-l2:#0000001a;--dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#61666b;
--dsw-alias-label-tertiary:#81858c;--dsw-alias-state-success-primary:#22c55e;--dsw-alias-state-warn-primary:#f59e0b;
--dsw-alias-state-error-primary:#ec1313;--demo-page:#f7f8f9}
:root[data-theme=dark]{--dsw-alias-bg-layer-1:#232324;--dsw-alias-bg-layer-2:#2c2c2e;--dsw-alias-bg-layer-3:#353638;
--dsw-alias-border-l2:#ffffff1f;--dsw-alias-label-primary:#f9fafb;--dsw-alias-label-secondary:#cfd3d6;
--dsw-alias-label-tertiary:#adb2b8;--dsw-alias-state-success-primary:#22c55e;--dsw-alias-state-warn-primary:#f59e0b;
--dsw-alias-state-error-primary:#f25a5a;--demo-page:#1a1a1b}
*{box-sizing:border-box}
body{margin:0;padding:28px;background:var(--demo-page);color:var(--dsw-alias-label-primary);
font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
header{max-width:760px;margin:0 auto 20px}
h1{font-size:18px;margin:0 0 6px}
.meta{font-size:12px;color:var(--dsw-alias-label-secondary)}
.banner{margin:12px 0 0;padding:8px 10px;border-radius:6px;font-size:12px;
background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-state-warn-primary)}
/* A section is a positioning context on purpose. The floating window is absolutely positioned with
   its own inset, so with no positioned ancestor it anchors to the viewport instead: every window
   in the page stacked in the bottom-right corner, on top of one another, and the sections above it
   looked empty while actually holding the window. The tall class gives a window the room it needs without
   clipping it — a card can be 72vh, which no fixed height would fit. */
section{position:relative;max-width:760px;margin:22px auto;padding:16px;border-radius:10px;
background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2)}
section.tall{min-height:560px}
h2{font-size:13px;margin:0 0 4px;font-weight:600}
.hint{margin:0 0 12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
button{font:inherit}
input{font:inherit;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);
background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
#theme{position:fixed;top:18px;right:20px;padding:6px 12px;border-radius:999px;cursor:pointer;
border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
`
  const body = sections
    .map((section) => `  <section${section.tall ? ' class="tall"' : ''}>\n    <h2>${escapeHtml(section.label)}</h2>\n    <p class="hint">${escapeHtml(section.hint)}</p>\n    <div>${toHtml(section.tree)}</div>\n  </section>`)
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${styles}</style>
</head>
<body>
<button id="theme" type="button">切换亮色 / 暗色</button>
<header>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">${escapeHtml(generatedBy)}</p>
  <p class="banner">演示数据，非真实状态：下面的界面结构由扁平面板的同一个渲染器导出，不是手抄的 HTML；里面的数字与通知内容是为展示编的。</p>
</header>
${body}
<script>
document.getElementById('theme').addEventListener('click', function () {
  var root = document.documentElement
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'
})
</script>
</body>
</html>
`
}
