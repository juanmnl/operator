/**
 * Types for the vendored @xterm/addon-canvas build (see xterm-addon-canvas.mjs).
 * Copied from @xterm/addon-canvas@0.8.0-beta.48's typings and unwrapped from its
 * `declare module` so they apply to the local relative import. License: MIT
 * (Copyright (c) 2017 The xterm.js authors).
 */

import { Terminal, ITerminalAddon, IEvent } from '@xterm/xterm';

/** An xterm.js addon that renders the terminal with a 2D canvas. */
export class CanvasAddon implements ITerminalAddon {
  public textureAtlas?: HTMLCanvasElement;

  /** Fired when the texture atlas of the renderer changes. */
  public readonly onChangeTextureAtlas: IEvent<HTMLCanvasElement>;

  /** Fired when a new page is added to the texture atlas. */
  public readonly onAddTextureAtlasCanvas: IEvent<HTMLCanvasElement>;

  constructor();

  /** Activates the addon. */
  public activate(terminal: Terminal): void;

  /** Disposes the addon. */
  public dispose(): void;

  /** Clears the terminal's texture atlas and triggers a redraw. */
  public clearTextureAtlas(): void;
}
