/* A tiny cookie-aware client over fastify's `inject`, so tests exercise the real routes,
 * the real error handler and real session cookies without binding a port. */
export function client(app) {
  let cookie = ''
  const call = async (method, url, body) => {
    const res = await app.inject({
      method, url, headers: cookie ? { cookie } : {},
      ...(body === undefined ? {} : { payload: body })
    })
    const set = res.headers['set-cookie']
    if (set) cookie = (Array.isArray(set) ? set : [set]).map(c => c.split(';')[0]).join('; ')
    let json = null
    try { json = res.json() } catch { /* empty body */ }
    // Headers come back too: a route that answers with a redirect says everything it has to
    // say in `location`, and a test that can only read bodies cannot check it at all.
    return { status: res.statusCode, body: json, headers: res.headers }
  }
  return {
    get: (u) => call('GET', u),
    post: (u, b = {}) => call('POST', u, b),
    del: (u) => call('DELETE', u),
    forget: () => { cookie = '' },
    get cookie() { return cookie }
  }
}
