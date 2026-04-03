import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { ITheme } from '@xterm/xterm'

interface TerminalPaneProps {
  terminalId: string
  theme: ITheme
  active?: boolean
  onTitleChange?: (title: string) => void
}

export function TerminalPane({ terminalId, theme, active = true, onTitleChange }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  const handleResize = useCallback(() => {
    if (fitRef.current) {
      try {
        fitRef.current.fit()
      } catch {
        // ignore fit errors during teardown
      }
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10000,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())

    term.open(containerRef.current)

    // Try WebGL, fall back to canvas
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // WebGL not available, using canvas renderer
    }

    // Re-assert cursorBlink after WebGL addon (can reset it)
    term.options.cursorBlink = true

    fitAddon.fit()
    // Re-fit after layout settles (initial fit can measure 0-width container)
    requestAnimationFrame(() => {
      try { fitAddon.fit() } catch { /* */ }
    })
    term.focus()

    termRef.current = term
    fitRef.current = fitAddon

    // Send initial size
    window.operator.terminalResize(terminalId, term.cols, term.rows)

    // Forward keystrokes to pty
    term.onData((data) => {
      window.operator.terminalWrite(terminalId, data)
    })

    // Resize pty on terminal resize
    term.onResize(({ cols, rows }) => {
      window.operator.terminalResize(terminalId, cols, rows)
    })

    // Title changes
    if (onTitleChange) {
      term.onTitleChange(onTitleChange)
    }

    // Receive data from pty — returns unsubscribe function
    const unsubData = window.operator.onTerminalData((id, data) => {
      if (id === terminalId) {
        term.write(data)
      }
    })

    // Resize observer
    const observer = new ResizeObserver(handleResize)
    observer.observe(containerRef.current)

    return () => {
      unsubData()
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [terminalId, theme, onTitleChange, handleResize])

  // Focus/blur and refit when active state changes
  useEffect(() => {
    const term = termRef.current
    if (!term) return

    if (active) {
      term.options.cursorBlink = true
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
      term.focus()
    } else {
      term.options.cursorBlink = false
      term.blur()
    }
  }, [active])

  // Handle image drag and drop
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    const paths = files.map((f) => f.path).filter(Boolean)
    if (paths.length > 0) {
      // Paste file paths into the terminal
      window.operator.terminalWrite(terminalId, paths.join(' '))
    }
  }, [terminalId])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  return (
    <div
      ref={containerRef}
      onClick={() => termRef.current?.focus()}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        padding: 6,
      }}
    />
  )
}
