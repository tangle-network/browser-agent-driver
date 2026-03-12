#!/usr/bin/env node

/**
 * HTTPS reverse proxy: forwards Ethereum JSON-RPC requests to a local
 * Anvil fork. Intercepts MetaMask service worker traffic that
 * Playwright's context.route() cannot reach.
 *
 * Listens on port 8443 (HTTPS) with a self-signed certificate.
 * Chrome launch args redirect Infura/Alchemy/etc DNS to 127.0.0.1:8443:
 *   --host-resolver-rules="MAP *.infura.io 127.0.0.1:8443,MAP *.quiknode.pro 127.0.0.1:8443,..."
 *   --ignore-certificate-errors
 *
 * Usage:
 *   node bench/wallet/rpc-proxy.mjs                        # start on :8443
 *   node bench/wallet/rpc-proxy.mjs --port 9443            # custom port
 *   node bench/wallet/rpc-proxy.mjs --target http://localhost:8545
 *   node bench/wallet/rpc-proxy.mjs --stop
 *   node bench/wallet/rpc-proxy.mjs --status
 */

import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')
const pidFile = path.join(rootDir, '.rpc-proxy.pid')
const certDir = path.join(rootDir, '.rpc-proxy-cert')

const argv = process.argv.slice(2)
const getArg = (name, fallback) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1 || idx === argv.length - 1) return fallback
  return argv[idx + 1]
}

const PORT = parseInt(getArg('port', '8443'), 10)
const TARGET = getArg('target', 'http://127.0.0.1:8545')

// --stop
if (argv.includes('--stop')) {
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
    try { process.kill(pid, 'SIGTERM'); console.log(`Stopped RPC proxy (PID ${pid})`) }
    catch { console.log(`PID ${pid} not running`) }
    fs.unlinkSync(pidFile)
  } else {
    console.log('No RPC proxy PID file found')
  }
  process.exit(0)
}

// --status
if (argv.includes('--status')) {
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
    try { process.kill(pid, 0); console.log(`RPC proxy running (PID ${pid}) on :${PORT}`) }
    catch { console.log('RPC proxy not running'); fs.unlinkSync(pidFile) }
  } else {
    console.log('RPC proxy not running')
  }
  process.exit(0)
}

// Generate self-signed cert covering common RPC provider hostnames
function ensureCert() {
  fs.mkdirSync(certDir, { recursive: true })
  const keyPath = path.join(certDir, 'key.pem')
  const certPath = path.join(certDir, 'cert.pem')

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
  }

  const sans = [
    'DNS:localhost',
    'DNS:*.infura.io',
    'DNS:mainnet.infura.io',
    'DNS:*.quiknode.pro',
    'DNS:*.alchemy.com',
    'DNS:*.publicnode.com',
    'DNS:*.llamarpc.com',
    'DNS:*.ankr.com',
    'DNS:*.tenderly.co',
    'DNS:*.cloudflare-eth.com',
    'IP:127.0.0.1',
  ].join(',')

  execSync(
    `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
    `-keyout "${keyPath}" -out "${certPath}" -days 365 -nodes ` +
    `-subj "/CN=rpc-proxy" ` +
    `-addext "subjectAltName=${sans}"`,
    { stdio: 'pipe' },
  )

  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
}

const { key, cert } = ensureCert()
const targetUrl = new URL(TARGET)
let requestCount = 0

const server = https.createServer({ key, cert }, (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  // Non-POST: return empty JSON-RPC error (some providers have health endpoints)
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"jsonrpc":"2.0","result":"rpc-proxy","id":1}')
    return
  }

  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    requestCount++
    try {
      const parsed = JSON.parse(body.toString())
      const methods = Array.isArray(parsed) ? parsed.map(r => r.method) : [parsed.method]
      console.log(`[${requestCount}] ${req.headers.host ?? '?'} → ${methods.join(', ')}`)
    } catch {
      console.log(`[${requestCount}] ${req.headers.host ?? '?'} → (non-JSON)`)
    }

    const proxyReq = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 8545,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (proxyRes) => {
        const resChunks = []
        proxyRes.on('data', (chunk) => resChunks.push(chunk))
        proxyRes.on('end', () => {
          res.writeHead(proxyRes.statusCode ?? 200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          })
          res.end(Buffer.concat(resChunks))
        })
      },
    )

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null }))
    })

    proxyReq.end(body)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RPC proxy: https://127.0.0.1:${PORT} → ${TARGET}`)
  console.log(`PID: ${process.pid}`)
  fs.writeFileSync(pidFile, String(process.pid))
})

server.on('error', (err) => {
  if (err.code === 'EACCES') {
    console.error(`Port ${PORT} requires root. Use a port ≥1024 (default: 8443).`)
  } else if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} in use. Stop existing proxy: node bench/wallet/rpc-proxy.mjs --stop`)
  } else {
    console.error(`Server error: ${err.message}`)
  }
  process.exit(1)
})
