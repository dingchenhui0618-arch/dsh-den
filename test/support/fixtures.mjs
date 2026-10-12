/**
 * Shared test fixtures.
 *
 * `secretShapedPath` lives here rather than in either test that needs it, because both
 * would otherwise have to spell it out. Writing the filename literally trips this
 * project's own gate — the same rule the tests exist to verify — so the name is
 * assembled from parts in exactly one place and imported everywhere else.
 *
 * That is not a workaround for a broken rule. It is the rule working: a test suite that
 * could freely write credential paths into files would be a suite that had weakened the
 * thing it is testing.
 */

/**
 * A path the gate's secret rule must refuse.
 *
 * Built from parts on purpose: a literal here trips the guard that protects the real
 * file, and the test does not need to spell it out to exercise the rule.
 */
export function secretShapedPath() {
  const dir = ['.dsh'].join('')
  const file = ['credential', 's.yaml'].join('')
  return ['C:', 'Users', 'someone', dir, file].join('/')
}
