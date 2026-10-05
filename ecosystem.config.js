/**
 * pm2 process definition — docs/90.
 *
 * Secrets are NOT here. `next start` and the Prisma CLI both load `.env` from `cwd`
 * themselves, and `.env` is gitignored, so this file stays committed and boring.
 */
module.exports = {
  apps: [
    {
      name: 'adpedia',

      // 🔴 `cwd` is load-bearing: it is how `next start` finds `.env`, and how a PDF render
      // finds `templates/`. pm2 inherits the directory you happened to be in otherwise.
      cwd: '/srv/adpedia/app',

      // 🔴 next's own binary, not `npm start`. Through npm, pm2 signals the npm wrapper and
      // the real server is orphaned — `pm2 restart` then leaves the old process holding
      // port 3000 and the new one dies on EADDRINUSE.
      script: './node_modules/next/dist/bin/next',
      args: 'start -H 127.0.0.1 -p 3000',

      // 🔴 fork, one instance. Cluster mode forks the app per CPU and EACH worker launches
      // its own Chromium on the first PDF — four browsers on a 2-core box is the OOM kill
      // described in docs/90 §1. Scale the box, not the instance count.
      exec_mode: 'fork',
      instances: 1,

      env: { NODE_ENV: 'production' },

      // 🔴 deliberately no `max_memory_restart`. Chromium is a CHILD process, so pm2 only
      // ever sees the Node heap — the limit would never fire for the thing that actually
      // grows, and would fire for a large report that is doing nothing wrong.

      // a PDF render has a 20 s timeout of its own; let an in-flight invoice download
      // finish rather than cutting it off at pm2's 1.6 s default.
      kill_timeout: 15000,

      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
    },
  ],
}
