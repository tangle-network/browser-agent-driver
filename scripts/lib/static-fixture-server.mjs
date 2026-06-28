import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
])

export async function startStaticFixtureServer(rootDir) {
  const root = path.resolve(rootDir)
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Method Not Allowed')
      return
    }

    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://fixture.local').pathname)
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Bad Request')
      return
    }

    const relativePath = pathname === '/'
      ? 'index.html'
      : pathname.replace(/^\/+/, '')
    const filePath = path.resolve(root, relativePath)
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        const status = err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(status === 404 ? 'Not Found' : 'Internal Server Error')
        return
      }

      res.writeHead(200, {
        'content-type': CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream',
        'content-length': String(data.length),
      })
      res.end(req.method === 'HEAD' ? undefined : data)
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (!address || typeof address !== 'object') {
    throw new Error('fixture server did not bind to a TCP port')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    }),
  }
}

export default startStaticFixtureServer
