import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EnvironmentSection, envDoorwayRows } from './EnvironmentSection'
import type { Project } from '../../../shared/types'

// THE GLOBAL PAGE'S ENVIRONMENT TAB USED TO BE A DEAD END: it told you to open a project's settings
// and gave you no way to do it. These cover the doorway that replaced that sentence, and that the
// project's own page is untouched by it.

const project = (id: string, name: string, path: string, env?: Project['env']): Project =>
  ({ id, name, path, ...(env ? { env } : {}) } as Project)

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
})

// createElement rather than JSX: the renderer suite collects `*.test.ts` only.
const render = async (props: Record<string, unknown>) => {
  await act(async () => {
    root.render(h(EnvironmentSection, { onPatch: () => {}, settingsFiles: [], ...props } as never))
  })
}

const rows = () => Array.from(host.querySelectorAll<HTMLElement>('[data-env-doorway-row]'))

describe('the doorway on the global Environment tab', () => {
  it('lists every project, not a sentence telling you to go elsewhere', async () => {
    await render({
      project: null,
      projects: [project('a', 'operator', '/Users/dev/operator'), project('b', 'mantel', '/Users/dev/mantel')],
    })
    expect(rows().map((r) => r.dataset.envDoorwayRow)).toEqual(['/Users/dev/operator', '/Users/dev/mantel'])
    expect(host.textContent).not.toContain("isn't scoped to a project")
  })

  it('opens that project on its own Environment tab when a row is clicked', async () => {
    const calls: Array<[string, string, string | undefined]> = []
    await render({
      project: null,
      projects: [project('a', 'operator', '/Users/dev/operator')],
      onOpenFolderPrefs: (p: string, n: string, t?: string) => calls.push([p, n, t]),
    })
    await act(async () => { rows()[0].click() })
    expect(calls).toEqual([['/Users/dev/operator', 'operator', 'Environment']])
  })

  it('says how many variables each project sets, and still opens one that sets none', async () => {
    const calls: string[] = []
    await render({
      project: null,
      projects: [
        project('a', 'none', '/Users/dev/none'),
        project('b', 'one', '/Users/dev/one', [{ name: 'API_BASE', value: 'x' }]),
      ],
      onOpenFolderPrefs: (p: string) => calls.push(p),
    })
    // Ordered by count, so the project that sets something leads.
    expect(rows().map((r) => r.dataset.envDoorwayRow)).toEqual(['/Users/dev/one', '/Users/dev/none'])
    expect(host.textContent).toContain('1 variable')
    expect(host.textContent).toContain('none set')
    // A project with nothing set is where you go to add the first one, so it opens like the rest.
    await act(async () => { rows()[1].click() })
    expect(calls).toEqual(['/Users/dev/none'])
  })

  it('says so in one line when the store holds no projects, rather than framing an empty box', async () => {
    await render({ project: null, projects: [] })
    expect(rows()).toHaveLength(0)
    expect(host.textContent).toContain('No projects yet')
  })

  it('leaves the project-scoped tab exactly as it was — its editor, and no doorway', async () => {
    await render({
      project: project('a', 'operator', '/Users/dev/operator', [{ name: 'API_BASE', value: 'x' }]),
      projects: [project('b', 'mantel', '/Users/dev/mantel')],
    })
    expect(rows()).toHaveLength(0)
    expect(host.textContent).toContain('API_BASE')
    expect(host.textContent).toContain('+ variable')
    expect(host.textContent).toContain('~/.operator/projects.json')
    // The other project in the store is not on this page.
    expect(host.textContent).not.toContain('mantel')
  })
})

describe('envDoorwayRows', () => {
  it('puts the projects that set something first, most first, and keeps store order among equals', () => {
    const p = [
      project('a', 'none-1', '/a'),
      project('b', 'two', '/b', [{ name: 'X', value: '1' }, { name: 'Y', value: '2' }]),
      project('c', 'none-2', '/c'),
      project('d', 'one', '/d', [{ name: 'Z', value: '3' }]),
    ]
    expect(envDoorwayRows(p).map((r) => [r.project.name, r.count])).toEqual([
      ['two', 2], ['one', 1], ['none-1', 0], ['none-2', 0],
    ])
  })

  it('counts a tombstone: removing a variable for a project is something set here', () => {
    const p = [project('a', 'tomb', '/a', [{ name: 'NODE_OPTIONS', unset: true }])]
    expect(envDoorwayRows(p)[0].count).toBe(1)
  })
})
