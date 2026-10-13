/**
 * One way for a probe to talk to the running Host's panel route.
 *
 * This uses `node:http` with `agent: false` rather than the global `fetch` **on purpose**.
 * `fetch` is undici, which keeps a keep-alive connection pool; calling `process.exit()`
 * while that pool is tearing down trips a libuv assertion on Windows Node 24:
 *
 *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
 *
 * The probe still ran every check, still printed `RESULT: PASS`, and still exited with
 * -1073740791. That is the worst possible shape for a check: it reports success in the
 * output a human reads and failure in the one a script reads. Three probes had it, and it
 * went unnoticed because the RESULT line was read and the exit code was not.
 *
 * A connection this module opens is closed before it returns, and no pool outlives the
 * call, so a probe can end with `process.exitCode` and exit cleanly.
 *
 * @param {object} options
 * @param {number} options.port port the Host's web server listens on
 * @param {string} options.route route path, e.g. `/dsh-den`
 * @param {string} options.action panel action name, one of `PANEL_ACTIONS`
 * @param {object} [options.input] action input, merged with the action name
 * @param {string} [options.method] HTTP method, `POST` by default
 * @param {number} [options.timeoutMs] per-request timeout
 * @returns {Promise<{status: number, body: string, envelope: any}>} the raw answer and its
 *   parsed envelope. The caller decides what a given status means; this does not throw for
 *   an HTTP error status, because several probes assert on refusal statuses on purpose.
 */

import { request } from 'node:http'

export function callRoute({ port, route, action, input = {}, method = 'POST', timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const payload = action === undefined ? undefined : JSON.stringify({ action, ...input })
    const request_ = request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        agent: false,
        headers: payload === undefined
          ? undefined
          : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          let envelope = null
          try {
            envelope = JSON.parse(body)
          } catch {
            envelope = null
          }
          resolve({ status: res.statusCode, body, envelope })
        })
      },
    )
    request_.setTimeout(timeoutMs, () => request_.destroy(new Error(`route did not answer within ${timeoutMs}ms`)))
    request_.on('error', reject)
    if (payload !== undefined) request_.write(payload)
    request_.end()
  })
}

/**
 * POST one action and return its `value`, throwing when the route did not answer with a
 * success envelope. Probes that expect a *refusal* should call `callRoute` directly.
 */
export async function routeValue({ port, route = '/dsh-den', action, input, timeoutMs }) {
  const answer = await callRoute({ port, route, action, input, timeoutMs })
  if (answer.status !== 200) throw new Error(`route answered ${answer.status}: ${answer.body.slice(0, 200)}`)
  if (!answer.envelope) throw new Error(`route answered with a non-JSON body: ${answer.body.slice(0, 200)}`)
  return answer.envelope.value
}

/**
 * End a probe with a clean exit.
 *
 * Do not call `process.exit()`: it tears the loop down underneath whatever is still
 * closing, which is how the crash above happened. Setting `exitCode` lets the loop drain
 * and the process leave on its own.
 *
 * @param {number} code process exit code
 */
export function finish(code) {
  process.exitCode = code
}
