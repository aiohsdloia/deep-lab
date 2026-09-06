import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkRoot, main } from './check-dsh-bundle.mjs'

const DETECT = 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-session-telemetry-otel/node_modules/@opentelemetry/sdk-logs/node_modules/@opentelemetry/resources/build/src/detect-resources.js'
const DETECT_TOP = 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-session-telemetry-otel/node_modules/@opentelemetry/resources/build/src/detect-resources.js'
const PKG = 'node_modules/@deepseek-ai/dsh/package.json'
const KOFFI = 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-sandbox-local/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/node_modules/koffi/build/Release/koffi.node'

function makeTree(root) {
  const rels = [PKG, DETECT, DETECT_TOP, KOFFI]
  for (const rel of rels) mkdirSync(dirname(join(root, rel)), { recursive: true })
  for (const rel of [PKG, DETECT, DETECT_TOP]) writeFileSync(join(root, rel), '{}')
  writeFileSync(join(root, KOFFI), Buffer.from([0x4e, 0x6f, 0x64, 0x65]))
}

function tempTree() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bundle-check-'))
  const root = join(dir, 'dsh')
  mkdirSync(root, { recursive: true })
  makeTree(root)
  return { dir, root }
}

test('complete minimal bundle passes', async () => {
  const { dir, root } = tempTree()
  try {
    const result = await checkRoot(root, { minFiles: 1 })
    assert.equal(result.status, 'ok')
    assert.equal(result.missing.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a half-copied bundle (missing nested detect-resources) is reported incomplete', async () => {
  const { dir, root } = tempTree()
  try {
    rmSync(join(root, DETECT_TOP), { force: true })
    const result = await checkRoot(root, { minFiles: 1 })
    assert.equal(result.status, 'incomplete')
    assert.ok(result.missing.some((m) => m.includes('top-level telemetry')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing koffi native binding is reported incomplete', async () => {
  const { dir, root } = tempTree()
  try {
    rmSync(join(root, KOFFI), { force: true })
    const result = await checkRoot(root, { minFiles: 1 })
    assert.equal(result.status, 'incomplete')
    assert.ok(result.missing.some((m) => m.includes('koffi')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('absent root reports absent without throwing', async () => {
  const result = await checkRoot(join(tmpdir(), 'definitely-not-a-dsh-', String(Date.now())))
  assert.equal(result.status, 'absent')
})

test('main exits non-zero on failure and zero on a valid root', async () => {
  const { dir, root } = tempTree()
  try {
    const ok = await main(['--root', root, '--min-files', '1'])
    assert.equal(ok, 0)
    rmSync(join(root, PKG), { force: true })
    const bad = await main(['--root', root, '--min-files', '1'])
    assert.equal(bad, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
