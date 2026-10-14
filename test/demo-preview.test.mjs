import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `docs/demo.html` is a deliverable a human looks at, and it rots silently: the moment the panel
 * changes, the page keeps showing the previous design while every other check stays green — the same
 * failure mode this project keeps paying for in its own documentation (a test count hand-copied into
 * the README drifted through 307/309/316/319/320/322/323, each time fixed by hand).
 *
 * The contract is therefore not "someone remembers to re-generate it": it is that the committed page
 * and the renderer's current output are the same bytes. Regenerating with
 * `node tools/check-client-interaction.mjs --demo docs/demo.html` is all it takes to make this pass.
 */
test('the committed preview page is exactly what the renderer produces today', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'dsh-den-demo-'))
  try {
    const out = join(dir, 'demo.html')
    execFileSync(process.execPath, ['tools/check-client-interaction.mjs', '--demo', out], {
      cwd: root,
      stdio: 'pipe',
    })
    const normalize = (text) => text.replace(/\r\n/g, '\n')
    const fresh = normalize(readFileSync(out, 'utf8'))
    const committed = normalize(readFileSync(join(root, 'docs', 'demo.html'), 'utf8'))
    assert.equal(
      fresh,
      committed,
      'docs/demo.html is stale: run `node tools/check-client-interaction.mjs --demo docs/demo.html`',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
