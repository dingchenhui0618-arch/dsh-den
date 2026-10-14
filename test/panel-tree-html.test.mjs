import test from 'node:test'
import assert from 'node:assert/strict'
import { collect, createElement, demoPage, escapeHtml, toHtml } from '../tools/panel-tree.mjs'

test('a bare number becomes pixels only where a length is meant', () => {
  const tree = collect(
    createElement('div', { style: { fontSize: 12, marginTop: 14, lineHeight: 1.7, color: 'red' } }, 'x'),
  )
  const html = toHtml(tree)
  assert.match(html, /font-size:12px/)
  assert.match(html, /margin-top:14px/)
  assert.match(html, /line-height:1\.7(?!px)/)
  assert.match(html, /color:red/)
})

test('the preview escapes what the panel says instead of executing it', () => {
  const tree = collect(createElement('div', {}, '<img src=x onerror=alert(1)>'))
  const html = toHtml(tree)
  assert.ok(!html.includes('<img'), 'markup in panel copy must not become markup in the page')
  assert.match(html, /&lt;img/)
  assert.equal(escapeHtml('a & "b"'), 'a &amp; &quot;b&quot;')
})

test('inputs stay void elements, and a generated page carries the honesty banner', () => {
  const tree = collect(createElement('input', { type: 'text', placeholder: '自检名' }))
  const html = toHtml(tree)
  assert.match(html, /^<input /)
  assert.ok(!html.includes('</input>'), 'a void element must not be closed')

  const page = demoPage({
    title: 't',
    note: 'n',
    generatedBy: 'the same renderer the checks use',
    sections: [{ label: 'l', hint: 'h', tree }],
  })
  assert.ok(page.startsWith('<!doctype html>'))
  assert.match(page, /演示数据，非真实状态/)
  assert.match(page, /<input /)
  assert.match(page, /the same renderer the checks use/)
})
