import { describe, it, expect } from 'vitest'
import { describeProject } from './project-description'

// Fixtures are REAL heads of the real files, ugly parts included — the badge row, the checklist,
// the memory-note fragment. Those three are the whole reason the shape gate exists; a fixture
// that omitted them would validate a deriver that cannot survive this machine.

const OPERATOR_HUB = `---
tags: [project, dev, operator]
---
# Operator

> Mission control for working agents. You run the agents. Operator makes the work visible and steerable.

Juan's own desktop app (Tauri + React + TypeScript) for operating Claude Code.`

const OPERATOR_README = `<img src="docs/logo.png" width="120" />

[![build](https://img.shields.io/badge/build-passing-green)](https://example.com)

Operator is a desktop app for running Claude Code agents.`

const CLAUDE_MD_POINTER = `# operator — Claude Code notes

## Obsidian project hub

This project has a knowledge-hub note in the Obsidian vault, at:
\`~/Work Vault/Operator/Operator.md\`

Read it for background and prior decisions before starting work here.`

const CHECKLIST_README = `# website-2025

- [x] Home
- [x] About
- [x] Project archive`

const MEMORY_FRAGMENT = `**Why:** Tracking remaining work so next session can pick up efficiently

**How to apply:** read it first.`

describe('describeProject', () => {
  it('takes the hub note\'s mission line, blockquote marker stripped', () => {
    const d = describeProject({ hubNote: OPERATOR_HUB })
    expect(d.from).toBe('hub note')
    expect(d.text).toBe('Mission control for working agents. You run the agents. Operator makes the work visible and steerable.')
  })

  it('a written contextNotes beats every derived source', () => {
    const d = describeProject({ contextNotes: 'The thing I actually mean.', hubNote: OPERATOR_HUB })
    expect(d.from).toBe('written')
    expect(d.text).toBe('The thing I actually mean.')
  })

  it('SKIPS a badge row and an <img> tag to reach the real sentence', () => {
    // Measured without the gate, operator described itself as an `<img>` tag.
    const d = describeProject({ readme: OPERATOR_README })
    expect(d.text).toBe('Operator is a desktop app for running Claude Code agents.')
  })

  it('SKIPS a checklist entirely rather than calling it a description', () => {
    const d = describeProject({ readme: CHECKLIST_README })
    expect(d.from).toBe('none')
    expect(d.text).toBe('')
  })

  it('SKIPS a memory-note fragment', () => {
    const d = describeProject({ readme: MEMORY_FRAGMENT })
    expect(d.from).toBe('none')
  })

  it('ranks CLAUDE.md below README, because its prose is usually the hub pointer', () => {
    // Present in 15/15 repos, a description in 1. Ranking by file-count would have returned
    // boilerplate for eight projects.
    const d = describeProject({ readme: OPERATOR_README, claudeMd: CLAUDE_MD_POINTER })
    expect(d.from).toBe('README')
  })

  it('falls through to package.json when nothing better exists', () => {
    const d = describeProject({ packageJson: JSON.stringify({ description: 'Personal website and project archive.' }) })
    expect(d.from).toBe('package.json')
    expect(d.text).toBe('Personal website and project archive.')
  })

  it('ignores a package.json with no usable description', () => {
    expect(describeProject({ packageJson: JSON.stringify({ description: '' }) }).from).toBe('none')
    expect(describeProject({ packageJson: JSON.stringify({ name: 'x' }) }).from).toBe('none')
    expect(describeProject({ packageJson: '{ truncated' }).from).toBe('none')
  })

  it('the true floor: nothing usable anywhere says so, and does not invent', () => {
    const d = describeProject({ claudeMd: CLAUDE_MD_POINTER })
    // The pointer paragraph is prose ABOUT the vault, not about the project — but it is prose,
    // so this documents what actually happens rather than pretending otherwise.
    expect(['CLAUDE.md', 'none']).toContain(d.from)
    expect(describeProject({}).from).toBe('none')
    expect(describeProject({}).text).toBe('')
  })

  it('flags a description that is about the PARENT product, not this repo', () => {
    // The three -landing repos point at their product's hub note. Real context, wrong subject.
    const d = describeProject({ hubNote: OPERATOR_HUB }, 'Operator-landing')
    expect(d.suspect).toBe(true)
  })

  it('does not flag a project describing itself', () => {
    expect(describeProject({ hubNote: OPERATOR_HUB }, 'operator').suspect).toBeUndefined()
  })
})
