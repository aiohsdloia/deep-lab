import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CANARIES = [
  {
    label: 'dsh cli package',
    rel: 'node_modules/@deepseek-ai/dsh/package.json',
  },
  {
    label: 'telemetry otel resources (nested sdk-logs)',
    rel: 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-session-telemetry-otel/node_modules/@opentelemetry/sdk-logs/node_modules/@opentelemetry/resources/build/src/detect-resources.js',
  },
  {
    label: 'telemetry otel resources (top-level telemetry)',
    rel: 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-session-telemetry-otel/node_modules/@opentelemetry/resources/build/src/detect-resources.js',
  },
  {
    label: 'sandbox koffi binding present somewhere',
    rel: null,
    find: async (root) => {
      const base = 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-sandbox-local/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/node_modules/koffi'
      const koffi = join(root, base)
      if (!existsSync(koffi)) return { ok: false, detail: 'koffi dir missing under sandbox-windows-acl' }
      const hits = collect(koffi, (p) => p.endsWith('.node'))
      return hits.length > 0
        ? { ok: true, detail: `${hits.length} native binding(s)` }
        : { ok: false, detail: 'no .node binding under koffi tree' }
    },
  },
]

const MIN_FILES = 40000

function collect(dir, accept, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) collect(full, accept, out)
    else if (accept(full)) out.push(full)
  }
  return out
}

function countFiles(dir) {
  let n = 0
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    const full = join(dir, name)
    try {
      if (statSync(full).isDirectory()) n += countFiles(full)
      else n += 1
    } catch {
      continue
    }
  }
  return n
}

function parseArgs(argv) {
  const args = { roots: [], json: false, minFiles: MIN_FILES }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') {
      args.roots.push(argv[++i])
    } else if (a === '--min-files') {
      args.minFiles = Number(argv[++i])
    } else if (a === '--json') {
      args.json = true
    } else if (a === '--help' || a === '-h') {
      args.help = true
    }
  }
  return args
}

export async function checkRoot(root, { minFiles = MIN_FILES } = {}) {
  const entry = { root, status: 'ok', files: 0, missing: [] }
  if (!existsSync(root)) {
    entry.status = 'absent'
    return entry
  }
  entry.files = countFiles(root)
  for (const canary of CANARIES) {
    if (canary.rel !== null) {
      if (!existsSync(join(root, canary.rel))) entry.missing.push(canary.label)
    } else if (canary.find) {
      const result = await canary.find(root)
      if (!result.ok) entry.missing.push(`${canary.label} (${result.detail})`)
    }
  }
  if (entry.missing.length > 0) entry.status = 'incomplete'
  else if (entry.files < minFiles) entry.status = 'incomplete'
  return entry
}

export async function main(argv) {
  const args = parseArgs(argv)
  const roots = args.roots.length > 0
    ? args.roots
    : [resolve(fileURLToPath(new URL('../../runtime/dsh', import.meta.url)))]
  const results = []
  for (const root of roots) results.push(await checkRoot(root, { minFiles: args.minFiles }))
  const failed = results.some((r) => r.status !== 'ok')
  if (args.json) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    for (const r of results) {
      if (r.status === 'ok') {
        console.log(`[ok]       ${r.root} (${r.files} files)`)
      } else if (r.status === 'absent') {
        console.log(`[absent]   ${r.root} — bundled dsh not present; run scripts/dev/fetch-dsh.sh`)
      } else {
        console.log(`[missing]  ${r.root} (${r.files} files)`)
        for (const m of r.missing) console.log(`            - ${m}`)
        if (r.missing.length === 0) console.log('            - below minimum file count')
      }
    }
  }
  return failed ? 1 : 0
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
