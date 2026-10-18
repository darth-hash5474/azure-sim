import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { GAMES } from './src/games.ts'

const ROOT = resolve(import.meta.dirname, '..')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

// Fixed link back to the menu, injected into every game's index.html.
const BACK_LINK = `<a href="../../" style="position:fixed;left:12px;bottom:12px;z-index:60;padding:4px 10px;border:1px solid #0d3b1f;background:#010805;color:#7dffa6;font:500 11px 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.2em;text-decoration:none">&#9666; MENU</a>`

const withBackLink = (html: string) => html.replace('</body>', `${BACK_LINK}</body>`)

const gameDist = (dir: string) => join(ROOT, dir, 'dist')

function buildGame(dir: string) {
  console.log(`\n[games] building ${dir}`)
  execSync('npm run build', { cwd: join(ROOT, dir), stdio: 'inherit' })
}

/** Serves each game at /games/<id>/ in dev, and bundles them into dist/games/<id>/ on build. */
function games(): Plugin {
  let outDir = 'dist'
  return {
    name: 'az104-games',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    buildStart() {
      if (this.meta.watchMode) return
      for (const game of GAMES) buildGame(game.dir)
    },
    configureServer(server) {
      for (const game of GAMES) if (!existsSync(gameDist(game.dir))) buildGame(game.dir)

      server.middlewares.use((req, res, next) => {
        const match = req.url?.split('?')[0].match(/^\/games\/([^/]+)(\/.*)?$/)
        const game = match && GAMES.find((g) => g.id === match[1])
        if (!match || !game) return next()

        if (!match[2]) {
          res.writeHead(301, { Location: `/games/${game.id}/` }).end()
          return
        }

        const root = gameDist(game.dir)
        const rel = decodeURIComponent(match[2] === '/' ? '/index.html' : match[2])
        const file = normalize(join(root, rel))
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next()

        const ext = extname(file)
        res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
        res.end(ext === '.html' ? withBackLink(readFileSync(file, 'utf8')) : readFileSync(file))
      })
    },
    closeBundle() {
      for (const game of GAMES) {
        const dest = join(outDir, 'games', game.id)
        cpSync(gameDist(game.dir), dest, { recursive: true })
        const index = join(dest, 'index.html')
        writeFileSync(index, withBackLink(readFileSync(index, 'utf8')))
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), games()],
})
