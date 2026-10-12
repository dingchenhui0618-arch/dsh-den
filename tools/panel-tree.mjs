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
