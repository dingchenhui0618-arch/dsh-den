/**
 * Self-test for the tree walker.
 *
 * The walker is the measuring instrument for every panel interaction check, so a
 * bug in it reads as a bug in the product. This pins the two behaviours that were
 * actually got wrong, plus the duplication that the first fix introduced.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { allText, collect, createElement, findAll, textOf } from '../tools/panel-tree.mjs'

test('a function component is called, not recorded as a node', () => {
  const Inner = () => createElement('span', null, 'hello')
  const Outer = () => createElement(Inner, null)
  const tree = collect(createElement(Outer, null))
  assert.equal(allText(tree).trim(), 'hello')
  assert.equal(findAll(tree, (n) => n.type === 'span').length, 1)
})

test('children passed as createElement arguments are walked', () => {
  const tree = collect(createElement('button', { type: 'button' }, 'Grant'))
  const button = findAll(tree, (n) => n.type === 'button')[0]
  assert.equal(textOf(button), 'Grant')
})

test('children read from props.children are walked', () => {
  // This is the shape `Button` uses: it renders the label out of `props.children`.
  const Button = (props) => createElement('button', { type: 'button' }, props.children)
  const tree = collect(createElement(Button, null, 'Grant'))
  assert.equal(textOf(findAll(tree, (n) => n.type === 'button')[0]), 'Grant')
})

test('text is not duplicated when both places carry the same children', () => {
  // A component that spreads its own props through, which is how the duplication
  // appeared: the element and props.children referenced the same array.
  const Button = (props) => createElement('button', { type: 'button', ...props }, props.children)
  const Label = () => 'Grant'
  const tree = collect(createElement(Button, null, createElement(Label, null)))
  assert.equal(textOf(findAll(tree, (n) => n.type === 'button')[0]), 'Grant')
})

test('nested arrays and falsy children are handled', () => {
  const tree = collect(createElement('div', null, [createElement('span', null, 'a'), 'b'], null, false, 'c'))
  assert.equal(textOf(tree[0]), 'abc')
})

test('a null component output is a no-op, not a crash', () => {
  const Nothing = () => null
  const tree = collect(createElement('div', null, createElement(Nothing, null), 'x'))
  assert.equal(textOf(tree[0]), 'x')
})
