import test from 'node:test'
import assert from 'node:assert/strict'
import { decide } from '../src/gate.js'

const mk = (risk, destination, rule) => ({ risk, rule, destination, reason: 'test' })
const find = (kind, destination, rule) =>
  [1, 2, 3, 4].find((risk) => decide(mk(risk, destination, rule)).kind === kind)

/**
 * Calibrated against the gate itself rather than a copied constant: whichever risk level it treats
 * as "ask" is the level at which the loopback exception has to be visible. A test that hard-codes
 * the number would keep passing after the threshold moved, which is the one thing it must not do.
 */
test('a loopback upload passes; anything else keeps the human in the loop', () => {
  const ask = find('ask', 'example.com', 'outbound:curl-upload')
  assert.ok(ask !== undefined, 'some risk level must classify a remote upload as ask')

  assert.equal(decide(mk(ask, '127.0.0.1:10086', 'outbound:curl-upload')).kind, 'allow')
  assert.equal(decide(mk(ask, 'localhost:3080', 'outbound:curl-upload')).kind, 'allow')
  assert.equal(decide(mk(ask, 'example.com', 'outbound:curl-upload')).kind, 'ask')
  assert.equal(
    decide(mk(ask, '', 'outbound:curl-upload')).kind,
    'ask',
    'an unnamed destination must not travel as permission',
  )
  assert.equal(
    decide(mk(ask, '127.0.0.1:1', 'tool:edit')).kind,
    'ask',
    'the exception covers outbound rules only',
  )
})

test('an allowed destination never rescues a denied action', () => {
  const deny = find('deny', 'example.com', 'outbound:curl-upload')
  assert.ok(deny !== undefined, 'some risk level must classify a remote upload as deny')
  assert.equal(decide(mk(deny, '127.0.0.1:10086', 'outbound:curl-upload')).kind, 'deny')
})