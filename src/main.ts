/**
 * Browser bootstrap: wires the Three.js renderer, DOM UI adapter, keyboard
 * input and localStorage saves into the renderer-agnostic Game kernel.
 * This is the ONLY gameplay entry point that touches Three.js imports.
 */

import { Game } from './core/Game';
import { ThreeRenderer } from './rendering/ThreeRenderer';
import { BrowserDomAdapter } from './ui/adapter/BrowserDomAdapter';
import { BrowserLocalStorageStorage } from './save/SaveStorage';
import { createKeyboardSource } from './input/sources';
import bindings from './data/inputBindings.json';

function bootstrap(): void {
  const mount = document.getElementById('app');
  if (mount === null) throw new Error('Missing #app mount element');

  const game = new Game({
    seed: 1337,
    renderer: new ThreeRenderer(mount),
    uiAdapter: new BrowserDomAdapter(mount),
    inputSource: createKeyboardSource(bindings),
    saveStorage: new BrowserLocalStorageStorage('country')
  });

  (window as unknown as { __countryGame?: Game }).__countryGame = game;
  game.init();
  game.start();
}

bootstrap();
