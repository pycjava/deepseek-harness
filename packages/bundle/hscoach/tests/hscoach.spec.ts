/** The standalone Hearthstone coach bundle's complete declared Cordis tree. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

describe('dsh-hscoach bundle', () => {
  it('declares one standalone row owning its complete tree with no other layers', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patches = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as Array<{ insert?: Array<{ id?: string; name?: string; config?: Record<string, unknown> }> }>
    expect(patches).toHaveLength(1)
    const rows = patches[0]?.insert ?? []
    // The coach plugin is self-contained: the complete application tree is
    // exactly one row mounting the bundle's own package.
    expect(rows.map(row => [row.id, row.name])).toEqual([
      ['hscoach', '@deepseek-ai/dsh-hscoach'],
    ])
    // Neutral defaults restated for config tooling; see resolveConfig.
    expect(rows[0]?.config).toEqual({
      publishDir: '',
      coachMode: 'teach',
      apiKey: '',
      baseURL: '',
      model: '',
      adviceTimeoutMs: 15000,
      cardDataDir: '',
      autoStart: true,
    })
    // A standalone bundle owns its whole tree: every non-self row package must
    // be a declared dependency (the self mount is exempt by the gate).
    const referenced = rows
      .map(row => row.name ?? '')
      .map(packageName)
      .filter(name => name !== manifest.name)
    expect(referenced).toEqual([])
    expect(manifest.dependencies).toEqual({})
  })
})
