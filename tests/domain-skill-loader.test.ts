import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  parseDomainSkill,
  loadDomainSkills,
  buildDomainSkillExtension,
  defaultDomainSkillsRoot,
  MAX_DOMAIN_BODY_BYTES,
} from '../src/skills/domain-loader.js'
import { resolveExtensions, rulesForUrl } from '../src/extensions/types.js'

describe('domain-skill-loader — parseDomainSkill', () => {
  it('parses frontmatter + body', () => {
    const src = [
      '---',
      'host: amazon.com',
      'aliases: [www.amazon.com, smile.amazon.com]',
      'title: Amazon search',
      '---',
      '',
      'On amazon.com: use the search box.',
    ].join('\n')
    const parsed = parseDomainSkill(src, '/tmp/fake.md')
    expect(parsed.host).toBe('amazon.com')
    expect(parsed.aliases).toEqual(['www.amazon.com', 'smile.amazon.com'])
    expect(parsed.title).toBe('Amazon search')
    expect(parsed.body).toBe('On amazon.com: use the search box.')
    expect(parsed.experimental).toBe(false)
    expect(parsed.sourcePath).toBe('/tmp/fake.md')
  })

  it('throws when host is missing', () => {
    const src = '---\ntitle: whatever\n---\n\nbody'
    expect(() => parseDomainSkill(src, '/tmp/fake.md')).toThrow(/host/)
  })

  it('treats files without frontmatter as body-only and still errors (no host)', () => {
    expect(() => parseDomainSkill('just a body, no header', '/tmp/fake.md')).toThrow(/host/)
  })

  it('truncates bodies that exceed the byte cap', () => {
    const longBody = 'x'.repeat(MAX_DOMAIN_BODY_BYTES + 500)
    const src = `---\nhost: big.com\n---\n\n${longBody}`
    const parsed = parseDomainSkill(src, '/tmp/big.md')
    expect(parsed.body.length).toBeLessThanOrEqual(MAX_DOMAIN_BODY_BYTES + 80)
    expect(parsed.body).toMatch(/truncated/)
  })

  it('ignores comment lines and supports quoted strings in frontmatter', () => {
    const src = [
      '---',
      '# this is a comment',
      'host: "quoted.com"',
      "title: 'single quoted'",
      '---',
      '',
      'body',
    ].join('\n')
    const parsed = parseDomainSkill(src, '/tmp/q.md')
    expect(parsed.host).toBe('quoted.com')
    expect(parsed.title).toBe('single quoted')
  })

  it('experimental flag carries through', () => {
    const src = '---\nhost: x.com\n---\nbody'
    const parsed = parseDomainSkill(src, '/tmp/x.md', true)
    expect(parsed.experimental).toBe(true)
  })
})

describe('domain-skill-loader — loadDomainSkills', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-domain-skills-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('returns empty when root dir does not exist', async () => {
    const out = await loadDomainSkills({ rootDir: path.join(tmpRoot, 'missing') })
    expect(out.skills).toEqual([])
    expect(out.errors).toEqual([])
  })

  it('loads every <host>/SKILL.md in the tree', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'amazon.com'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpRoot, 'amazon.com', 'SKILL.md'),
      '---\nhost: amazon.com\n---\nprefer search\n',
    )
    fs.mkdirSync(path.join(tmpRoot, 'github.com'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpRoot, 'github.com', 'SKILL.md'),
      '---\nhost: github.com\n---\nuse direct URLs\n',
    )
    const out = await loadDomainSkills({ rootDir: tmpRoot })
    expect(out.skills.map(s => s.host).sort()).toEqual(['amazon.com', 'github.com'])
    expect(out.errors).toEqual([])
  })

  it('loads experimental/<host>/SKILL.md and flags them', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'experimental', 'wip.com'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpRoot, 'experimental', 'wip.com', 'SKILL.md'),
      '---\nhost: wip.com\n---\nwork in progress\n',
    )
    const out = await loadDomainSkills({ rootDir: tmpRoot })
    expect(out.skills).toHaveLength(1)
    expect(out.skills[0].host).toBe('wip.com')
    expect(out.skills[0].experimental).toBe(true)
  })

  it('captures parse errors without throwing', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'broken'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpRoot, 'broken', 'SKILL.md'),
      '---\ntitle: missing host\n---\nbody',
    )
    // onError is silenced to keep test output clean
    const out = await loadDomainSkills({ rootDir: tmpRoot, onError: () => {} })
    expect(out.skills).toEqual([])
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].path).toContain('broken')
  })

  it('ignores top-level files and non-SKILL.md children', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'README.md'), 'not a skill')
    fs.mkdirSync(path.join(tmpRoot, 'valid.com'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpRoot, 'valid.com', 'SKILL.md'),
      '---\nhost: valid.com\n---\nbody',
    )
    fs.writeFileSync(
      path.join(tmpRoot, 'valid.com', 'notes.md'),
      'not loaded',
    )
    const out = await loadDomainSkills({ rootDir: tmpRoot })
    expect(out.skills).toHaveLength(1)
    expect(out.skills[0].host).toBe('valid.com')
  })
})

describe('domain-skill-loader — buildDomainSkillExtension', () => {
  it('collapses multiple skills into a single extension keyed by host; subdomain aliases reuse primary', () => {
    const skills = [
      { host: 'amazon.com', aliases: ['smile.amazon.com'], body: 'A', sourcePath: '/a', experimental: false },
      { host: 'github.com', aliases: [], body: 'G', sourcePath: '/g', experimental: false },
    ]
    const ext = buildDomainSkillExtension(skills)
    expect(ext.addRulesForDomain).toBeDefined()
    expect(ext.addRulesForDomain!['amazon.com'].extraRules).toBe('A')
    // smile.amazon.com contains amazon.com, so the matcher already covers it;
    // we don't register a separate key (would double-emit at match time).
    expect(ext.addRulesForDomain!['smile.amazon.com']).toBeUndefined()
    expect(ext.addRulesForDomain!['github.com'].extraRules).toBe('G')
  })

  it('registers aliases that are NOT substring-reachable from the primary', () => {
    const skills = [
      { host: 'tesla.com', aliases: ['teslamotors.com'], body: 'T', sourcePath: '/t', experimental: false },
    ]
    const ext = buildDomainSkillExtension(skills)
    expect(ext.addRulesForDomain!['tesla.com'].extraRules).toBe('T')
    expect(ext.addRulesForDomain!['teslamotors.com'].extraRules).toBe('T')
  })

  it('concatenates bodies when multiple skills target the same host', () => {
    const skills = [
      { host: 'shared.com', aliases: [], body: 'first', sourcePath: '/1', experimental: false },
      { host: 'shared.com', aliases: [], body: 'second', sourcePath: '/2', experimental: false },
    ]
    const ext = buildDomainSkillExtension(skills)
    expect(ext.addRulesForDomain!['shared.com'].extraRules).toBe('first\n\nsecond')
  })
})

describe('domain-skill-loader — integration with resolveExtensions', () => {
  it('domain-skill extension merges with user rules via resolveExtensions', () => {
    const skillExt = buildDomainSkillExtension([
      { host: 'amazon.com', aliases: [], body: 'use search', sourcePath: '/x', experimental: false },
    ])
    const userExt = {
      addRulesForDomain: {
        'amazon.com': { extraRules: 'user override' },
      },
    }
    const combined = resolveExtensions([userExt, skillExt])
    const match = rulesForUrl('https://www.amazon.com/dp/ABC', combined.combinedDomainRules)
    expect(match).toContain('user override')
    expect(match).toContain('use search')
  })

  it('domain-skill extension fires on subdomain aliases via substring match on the primary', () => {
    const skillExt = buildDomainSkillExtension([
      {
        host: 'amazon.com',
        aliases: ['smile.amazon.com'],
        body: 'prefer search',
        sourcePath: '/x',
        experimental: false,
      },
    ])
    const combined = resolveExtensions([skillExt])
    const match = rulesForUrl('https://smile.amazon.com/', combined.combinedDomainRules)
    expect(match).toBe('prefer search')
  })

  it('domain-skill extension fires on rebrand aliases that are NOT subdomains', () => {
    const skillExt = buildDomainSkillExtension([
      {
        host: 'tesla.com',
        aliases: ['teslamotors.com'],
        body: 'rebrand body',
        sourcePath: '/x',
        experimental: false,
      },
    ])
    const combined = resolveExtensions([skillExt])
    expect(rulesForUrl('https://tesla.com/', combined.combinedDomainRules)).toBe('rebrand body')
    expect(rulesForUrl('https://teslamotors.com/', combined.combinedDomainRules)).toBe('rebrand body')
  })
})

describe('domain-skill-loader — shipped seed corpus', () => {
  it('the 5 seeded skills parse cleanly', async () => {
    const rootDir = defaultDomainSkillsRoot()
    const out = await loadDomainSkills({ rootDir })
    const hosts = out.skills.map(s => s.host).sort()
    expect(hosts).toEqual(expect.arrayContaining([
      'amazon.com',
      'github.com',
      'linkedin.com',
      'stackoverflow.com',
      'wikipedia.org',
    ]))
    expect(out.errors).toEqual([])
    // Each body is non-empty and within the byte cap
    for (const skill of out.skills) {
      expect(skill.body.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(skill.body, 'utf-8')).toBeLessThanOrEqual(MAX_DOMAIN_BODY_BYTES + 80)
    }
  })
})
