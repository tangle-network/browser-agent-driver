/**
 * File-backed corpus store — the ONLY module that touches the corpus directory.
 * Implements the full `CorpusStore` (`CorpusReader` + `CorpusWriter`) as a
 * JSON-record directory: one `<id>.json` exemplar per file plus a `screenshots/`
 * sidecar. The audit hot path receives only the `CorpusReader` half (so it can
 * never reach `upsert`/`saveScreenshot`); offline `corpus/build` holds the writer.
 *
 * Fail-closed by construction:
 *  - a missing corpus dir loads as an EMPTY corpus, never an error or a fabricated
 *    row, and `get` returns `null` on a miss;
 *  - a record that fails `parseExemplar` (corrupt / hand-edited / foreign) is
 *    skipped on load rather than poisoning the whole corpus — one bad row never
 *    nukes retrieval, and nothing is ever invented to fill the gap;
 *  - writes are atomic-ish (temp file + `rename`) and validate through the schema
 *    BEFORE landing, so a malformed exemplar can never reach disk;
 *  - ids are constrained to a filename-safe charset, so neither `get` nor a write
 *    can escape the corpus dir via path traversal.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CorpusStore, Exemplar } from '../contracts.js'
import { parseExemplar, serializeExemplar } from './schema.js'

const RECORD_EXT = '.json'
const SCREENSHOT_DIR = 'screenshots'
// Exemplar ids are slugs (`[a-z0-9-]`); this guard keeps `get`/write inside the
// corpus dir even when handed a hostile id, blocking `..`/separator traversal.
const SAFE_ID = /^[A-Za-z0-9_-]+$/

const isSafeId = (id: string): boolean => SAFE_ID.test(id)

/**
 * Build a file-backed `CorpusStore` rooted at `dir`. The returned object's
 * `CorpusReader` half is what the engine consumes; the `CorpusWriter` half is for
 * the offline authoring path only.
 */
export function createFileCorpusStore(dir: string): CorpusStore {
  const recordPath = (id: string): string => path.join(dir, `${id}${RECORD_EXT}`)

  async function readRecord(file: string): Promise<Exemplar | null> {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      return null
    }
    try {
      return parseExemplar(JSON.parse(text))
    } catch {
      // Corrupt / foreign record — skip it rather than fail the whole load.
      return null
    }
  }

  return {
    async load(): Promise<Exemplar[]> {
      let entries: string[]
      try {
        entries = await fs.readdir(dir)
      } catch {
        return []
      }
      const out: Exemplar[] = []
      // Sort by filename for a deterministic load order across machines.
      for (const name of entries.filter((n) => n.endsWith(RECORD_EXT)).sort()) {
        const exemplar = await readRecord(path.join(dir, name))
        if (exemplar) out.push(exemplar)
      }
      return out
    },

    async get(id: string): Promise<Exemplar | null> {
      if (!isSafeId(id)) return null
      return readRecord(recordPath(id))
    },

    resolveScreenshot(exemplar: Exemplar): string {
      const p = exemplar.screenshotPath
      if (!p) return ''
      return path.isAbsolute(p) ? p : path.resolve(dir, p)
    },

    async upsert(exemplar: Exemplar): Promise<void> {
      // Validate + normalise at the IO boundary: malformed exemplars never land.
      const valid = parseExemplar(exemplar)
      if (!isSafeId(valid.id)) throw new Error(`corpus upsert: unsafe exemplar id '${valid.id}'`)
      await fs.mkdir(dir, { recursive: true })
      const final = recordPath(valid.id)
      const tmp = `${final}.tmp-${process.pid}-${Date.now()}`
      await fs.writeFile(tmp, serializeExemplar(valid), 'utf8')
      await fs.rename(tmp, final)
    },

    async saveScreenshot(id: string, png: Buffer): Promise<string> {
      if (!isSafeId(id)) throw new Error(`corpus saveScreenshot: unsafe exemplar id '${id}'`)
      const rel = path.join(SCREENSHOT_DIR, `${id}.png`)
      const abs = path.join(dir, rel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, png)
      // Return the corpus-relative path so it stores portably in the exemplar
      // record; `resolveScreenshot` turns it back into an absolute path.
      return rel
    },
  }
}
