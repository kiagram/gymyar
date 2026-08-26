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
  /* A body that is not JSON, for the one route that takes bytes. `inject` will infer a content
   * type from a Buffer if none is given, and the upload route is registered for exactly one —
   * so it is stated here rather than left to be inferred differently by a future version. */
  const raw = async (method, url, buf, headers = {}) => {
    const res = await app.inject({
      method, url, payload: buf,
      headers: { 'content-type': 'application/octet-stream', ...(cookie ? { cookie } : {}), ...headers }
    })
    let json = null
    try { json = res.json() } catch { /* empty body, or bytes */ }
    return { status: res.statusCode, body: json, headers: res.headers, raw: res.rawPayload }
  }

  return {
    get: (u) => call('GET', u),
    post: (u, b = {}) => call('POST', u, b),
    patch: (u, b = {}) => call('PATCH', u, b),
    del: (u) => call('DELETE', u),
    upload: (u, buf, headers) => raw('POST', u, buf, headers),
    /** A GET whose answer is bytes rather than JSON — media, and range requests over it. */
    fetch: (u, headers = {}) => app.inject({
      method: 'GET', url: u, headers: { ...(cookie ? { cookie } : {}), ...headers }
    }).then(res => ({ status: res.statusCode, headers: res.headers, raw: res.rawPayload })),
    forget: () => { cookie = '' },
    get cookie() { return cookie }
  }
}
