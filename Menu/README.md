# AZ-104 Field Ops — game menu

Launcher for the AZ-104 games in `d:\azure-admin`. It lists every game in
[src/games.ts](src/games.ts), and selecting one opens it at `games/<id>/`.

```sh
npm run dev      # menu on http://localhost:5173, games served from their built dist/
npm run build    # builds every game, then the menu; dist/ is one deployable static site
```

In dev, each game is served from its own `dist/` folder, which is built on first start if it's missing.
After changing a game, run `npm run build` in that game's folder (or develop it standalone with
its own `npm run dev`) and refresh the menu.

Each game page gets a fixed `◂ MENU` link injected at serve/bundle time, so games stay standalone.

## Adding a game

1. Create the game as a Vite app in a sibling folder, e.g. `d:\azure-admin\Storage-Heist`.
2. Set `base: './'` in its `vite.config.ts` so it works under `games/<id>/`.
3. Add an entry to `GAMES` in [src/games.ts](src/games.ts) (`dir` is the folder name).

Controls: `↑`/`↓` (or `j`/`k`) select, `1`–`9` jump, `Enter` launches.
