// Starts a Cloudflare quick tunnel to the local dev server, then prints the
// public https URL and a scannable QR code straight to the terminal — so a
// phone can reach the dev server without anyone reading the URL back by hand.
//
//   npm run tunnel          # assumes `npm run dev` is already running on :3000
//
// The quick tunnel draws a fresh trycloudflare.com URL on every start; this
// script captures whichever one cloudflared prints and shows it for you.

import { spawn } from 'node:child_process'
import QRCode from 'qrcode'

const PORT = process.env.PORT ?? '3000'
const TARGET = `http://localhost:${PORT}`
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

const cloudflared = spawn(
  'cloudflared',
  ['tunnel', '--url', TARGET, '--no-autoupdate'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

let announced = false

async function announce(url) {
  if (announced) return
  announced = true
  const qr = await QRCode.toString(url, { type: 'terminal', small: true })
  process.stdout.write(
    `\n${'='.repeat(60)}\n` +
      `  Mobile-Testing-URL (auf dem Handy scannen):\n\n` +
      `  ${url}\n\n` +
      `${qr}\n` +
      `  Tunnel läuft. Zum Beenden: Strg+C\n` +
      `${'='.repeat(60)}\n\n`,
  )
}

function scan(chunk) {
  const text = chunk.toString()
  process.stderr.write(text) // keep cloudflared's own logs visible
  const match = text.match(URL_RE)
  if (match) announce(match[0])
}

cloudflared.stdout.on('data', scan)
cloudflared.stderr.on('data', scan)

cloudflared.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(
      '\ncloudflared ist nicht installiert. Siehe README ("A tunnel supplies…").\n',
    )
  } else {
    console.error('\ncloudflared-Fehler:', err.message, '\n')
  }
  process.exit(1)
})

cloudflared.on('exit', (code) => process.exit(code ?? 0))

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => cloudflared.kill(sig))
}
