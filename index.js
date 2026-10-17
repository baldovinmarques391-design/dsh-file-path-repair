/**
 * Repair Markdown-eaten path separators on the file route.
 *
 * WHY
 * A local image in chat reaches `/api/file?path=…` with the destination the
 * Markdown parser produced. In a link destination a backslash before ASCII
 * punctuation is a CommonMark escape, so an authored
 * `C:\work\_out\shot.png` arrives as `C:\work_out\shot.png`: the separator is
 * gone, the route 404s, and every surface that shows local images (chat,
 * document preview) falls back to "图片无法预览" plus the alt text. The mangling
 * happens before any client-side path hook runs, so it cannot be repaired in
 * the page — and relying on the model to spell paths differently does not
 * cover other agents, other sessions, or text that already exists.
 *
 * WHAT
 * The `/api/file` handler is wrapped: when the requested path does not exist,
 * the plugin tries the same path with separators restored before ASCII
 * punctuation — exactly the characters a Markdown escape can consume. Each
 * candidate is probed through the original handler with HEAD, so the composed
 * filesystem provider (and its sandbox policy) still decides what is readable.
 * When one candidate exists it is served; when several do, the request keeps
 * its original 404 instead of guessing.
 *
 * Scope: only a request that already failed. A path that exists is served by
 * the original handler untouched.
 */

/** The exact route the client builds local media URLs against. */
const FILE_ROUTE = '/api/file'
/** ASCII punctuation, the only characters a CommonMark backslash escape can consume. */
const PUNCTUATION = /[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/u
/** Separators are never escaped, and a drive colon cannot follow one. */
const NOT_A_SEPARATOR_TARGET = new Set([':', '/', '\\'])
/** How many repair candidates one request may probe. */
const MAX_PROBES = 160
/** How many punctuation positions take part in the repair. */
const MAX_POINTS = 12
/** Wall-clock budget for repairing one request. */
const REPAIR_BUDGET_MS = 400

/**
 * Positions where a Markdown escape could have removed a separator.
 * @param {string} path - the requested path.
 * @returns {number[]} offsets of punctuation characters that follow a non-separator.
 */
function insertionPoints(path) {
  const points = []
  for (let index = 1; index < path.length; index += 1) {
    const character = path[index]
    if (!PUNCTUATION.test(character) || NOT_A_SEPARATOR_TARGET.has(character)) continue
    if (path[index - 1] === '\\' || path[index - 1] === '/') continue
    points.push(index)
  }
  return points.slice(0, MAX_POINTS)
}

/**
 * Candidate paths, smallest number of restored separators first.
 * @param {string} path - the requested path.
 * @returns {Generator<string>} repaired candidate paths.
 */
function* repairedPaths(path) {
  const points = insertionPoints(path)
  if (points.length === 0) return
  const insert = (chosen) => {
    let result = ''
    let index = 0
    for (const position of chosen) {
      result += path.slice(index, position) + '\\' + path[position]
      index = position + 1
    }
    return result + path.slice(index)
  }
  for (const size of [1, 2, 3]) {
    if (points.length < size) break
    const chosen = Array.from({ length: size }, (_, index) => index)
    while (true) {
      yield insert(chosen.map((index) => points[index]))
      let cursor = size - 1
      while (cursor >= 0 && chosen[cursor] === points.length - size + cursor) cursor -= 1
      if (cursor < 0) break
      chosen[cursor] += 1
      for (let next = cursor + 1; next < size; next += 1) chosen[next] = chosen[next - 1] + 1
    }
  }
}

/**
 * Ask the original handler whether one candidate path is a readable file.
 * @param {(request: Request) => Promise<Response>} serve - the original route handler.
 * @param {Request} request - the incoming request, for headers and signal.
 * @param {string} path - candidate path.
 * @returns {Promise<boolean>} whether the candidate is served.
 */
async function servable(serve, request, path) {
  const url = new URL(request.url)
  url.searchParams.set('path', path)
  const probe = new Request(url, { method: 'HEAD', headers: request.headers, signal: request.signal })
  const response = await serve(probe)
  await response.body?.cancel().catch(() => {})
  return response.ok
}

/**
 * Wrap one handler so a 404 can be repaired into a single existing path.
 * @param {(request: Request) => Promise<Response>} serve - the original route handler.
 * @returns {(request: Request) => Promise<Response>} the wrapped handler.
 */
function wrapFileRoute(serve) {
  return async function fileRoute(request) {
    const response = await serve(request)
    if (response.status !== 404) return response
    const path = new URL(request.url).searchParams.get('path')
    if (typeof path !== 'string' || path === '') return response
    if (!path.includes('\\') && !path.includes('/')) return response
    const deadline = Date.now() + REPAIR_BUDGET_MS
    let probes = 0
    const found = []
    for (const candidate of repairedPaths(path)) {
      if (probes >= MAX_PROBES || Date.now() > deadline) break
      probes += 1
      if (await servable(serve, request, candidate)) found.push(candidate)
      // Two different repairs already exist: serving either would be a guess.
      if (found.length > 1) return response
    }
    if (found.length !== 1) return response
    const url = new URL(request.url)
    url.searchParams.set('path', found[0])
    return serve(new Request(url, { method: request.method, headers: request.headers, signal: request.signal }))
  }
}

/**
 * Install the wrapper on the live route and on any later registration.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  ctx.inject(['connection'], (ctx) => {
    const connection = ctx.get('connection')
    if (connection === undefined || connection === null) return

    const routes = connection.fetchRoutes
    const current = routes instanceof Map ? routes.get(FILE_ROUTE) : undefined
    if (current !== undefined && typeof current.fetch === 'function' && current.repaired !== true) {
      current.fetch = wrapFileRoute(current.fetch)
      current.repaired = true
    }

    const registerRoute = connection.registerFetchRoute
    if (typeof registerRoute === 'function' && connection.repairedRegistrar !== true) {
      connection.repairedRegistrar = true
      connection.registerFetchRoute = function register(owner, route, ...rest) {
        const next = route?.path === FILE_ROUTE && typeof route.fetch === 'function'
          ? { ...route, fetch: wrapFileRoute(route.fetch) }
          : route
        return registerRoute.call(this, owner, next, ...rest)
      }
      ctx.effect(() => () => {
        delete connection.registerFetchRoute
        delete connection.repairedRegistrar
      }, 'file-path-repair: restore registerFetchRoute')
    }

    ctx.effect(() => () => {
      const live = routes instanceof Map ? routes.get(FILE_ROUTE) : undefined
      if (live?.repaired === true) delete live.repaired
    }, 'file-path-repair: release the wrapped route')
  })
}

/** Exported for tests: the repair itself, without any Cordis wiring. */
export { repairedPaths, wrapFileRoute }
