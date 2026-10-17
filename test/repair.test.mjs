/**
 * Repair checks against a real filesystem, through a stand-in for the
 * `/api/file` handler. The stand-in answers HEAD without a body and 404s
 * anything that is not a regular file, like the shipped route.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { wrapFileRoute } from '../index.js'

const root = mkdtempSync(join(tmpdir(), 'file-path-repair-'))

/** Shipped-route stand-in: 404 unless the path is a readable regular file. */
async function serve(request) {
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path === '') return new Response('missing path', { status: 400 })
  let stats
  try {
    const { statSync } = await import('node:fs')
    stats = statSync(path)
  } catch {
    return new Response('FS_NOT_FOUND', { status: 404 })
  }
  if (!stats.isFile()) return new Response('FS_NOT_REGULAR_FILE', { status: 404 })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': 'image/png' } })
  return new Response(readFileSync(path), { status: 200, headers: { 'content-type': 'image/png' } })
}

const route = wrapFileRoute(serve)
const request = (path, method = 'GET') => new Request(`http://127.0.0.1:3080/api/file?path=${encodeURIComponent(path)}`, { method })

try {
  // 1. Exact path: the wrapper must not interfere.
  const plain = join(root, 'plain.png')
  writeFileSync(plain, 'PNG-plain')
  const exact = await route(request(plain))
  assert.equal(exact.status, 200)
  assert.equal(await exact.text(), 'PNG-plain')
  console.log('ok   an existing path is served by the original handler')

  // 2. The Markdown-eaten separator: `\_` became `_`.
  const repairedTarget = join(root, '_shots', 'shot.png')
  mkdirSync(join(root, '_shots'), { recursive: true })
  writeFileSync(repairedTarget, 'PNG-repaired')
  const eaten = join(root, 'shots', 'shot.png') // stands in for `<root>_shots\shot.png`
  const repairedPath = `${root}_shots${'\\'}shot.png`
  const repaired = await route(request(repairedPath))
  assert.equal(repaired.status, 200)
  assert.equal(await repaired.text(), 'PNG-repaired')
  console.log(`ok   ${repairedPath}  ->  ${repairedTarget}`)

  // 3. HEAD goes through the same repair (the page asks for images with GET only,
  //    but a HEAD probe must not lie about availability).
  const head = await route(request(repairedPath, 'HEAD'))
  assert.equal(head.status, 200)
  console.log('ok   HEAD is repaired too')

  // 4. Two different repairs exist: refuse to guess.
  //    Requested (mangled): <root>\p_q\r_s.png
  //    Repair A: <root>\p\_q\r_s.png   (a directory level before the first _)
  //    Repair B: <root>\p_q\r\_s.png   (a directory level before the second _)
  mkdirSync(join(root, 'p\\_q'), { recursive: true })
  writeFileSync(join(root, 'p\\_q', 'r_s.png'), 'AMBIGUOUS-A')
  mkdirSync(join(root, 'p_q', 'r'), { recursive: true })
  writeFileSync(join(root, 'p_q', 'r', '_s.png'), 'AMBIGUOUS-B')
  const ambiguous = await route(request(join(root, 'p_q', 'r_s.png')))
  assert.equal(ambiguous.status, 404)
  console.log('ok   two possible repairs stay 404 instead of guessing')

  // 5. Nothing to repair.
  const missing = await route(request(join(root, 'nope', 'gone.png')))
  assert.equal(missing.status, 404)
  console.log('ok   an unrepaired missing path stays 404')

  // 6. A directory is not a file, even when the repair points at it.
  mkdirSync(join(root, '_dir'), { recursive: true })
  const directory = await route(request(`${root}_dir${'\\'}whatever.png`))
  assert.equal(directory.status, 404)
  console.log('ok   a directory is still refused')

  console.log('\nrepair checks passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
