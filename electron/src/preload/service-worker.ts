// Preload for every service worker in the default session. Registered in main's `boot()`.
//
// The frame preloads cannot reach a service worker, and one registered by a previewed page badges
// Operator's Dock tile the same way the page itself does (`probes/badge-block.cjs`, scenario `sw`).
// Operator's own renderer registers no service worker, so every one that runs here is previewed
// content. It gets the badge stub and nothing else.
import { contextBridge } from 'electron'
import { blockBadging } from './badge-block'

contextBridge.executeInMainWorld({ func: blockBadging })
