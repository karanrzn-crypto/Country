import { describe, it, expect } from 'vitest';
import { AssetRegistry } from '../../../assets/AssetRegistry';
import { AssetCache } from '../../../assets/AssetCache';
import { AssetManager } from '../../../assets/AssetManager';
import { GeneratedAssetLoader } from '../../../assets/loaders';
import type { AssetLoader } from '../../../assets/AssetTypes';
import { AssetError } from '../../../utils/errors';
import { EventBus } from '../../../events/EventBus';
import { Logger, MemoryLogSink } from '../../../utils/Logger';

function makeManager(): { manager: AssetManager; loaderCalls: number[] } {
  const registry = new AssetRegistry();
  const cache = new AssetCache();
  const manager = new AssetManager(registry, cache, new EventBus(), new Logger(new MemoryLogSink(), 'error'));
  manager.registerLoader(new GeneratedAssetLoader());
  const loaderCalls: number[] = [];
  const countingLoader: AssetLoader = {
    kind: 'json',
    load: async (descriptor) => {
      loaderCalls.push(1);
      return {
        data: { id: descriptor.id },
        dispose: () => loaderCalls.push(-1)
      };
    }
  };
  manager.registerLoader(countingLoader);
  return { manager, loaderCalls };
}

describe('AssetManager pipeline', () => {
  it('loads generated assets via their factory', async () => {
    const { manager } = makeManager();
    manager.registerAssets([
      { id: 'gen.grid', kind: 'generated', generate: () => ({ grid: true }) }
    ]);
    const data = (await manager.load('gen.grid')) as { grid: boolean };
    expect(data.grid).toBe(true);
  });

  it('caches: second load does not re-invoke the loader', async () => {
    const { manager, loaderCalls } = makeManager();
    manager.registerAssets([{ id: 'a', kind: 'json', url: 'a.json' }]);
    await manager.load('a');
    await manager.load('a');
    expect(loaderCalls.filter((call) => call === 1)).toHaveLength(1);
  });

  it('emits load + group progress events', async () => {
    const { manager } = makeManager();
    manager.registerAssets([
      { id: 'g1', kind: 'json', url: 'g1.json' },
      { id: 'g2', kind: 'json', url: 'g2.json' }
    ]);
    manager.registerGroup('group', ['g1', 'g2']);
    const progress: number[] = [];
    const bus = manager['events'];
    bus.on('assets.groupProgress', ({ loaded, total }) => progress.push(loaded / total));
    await manager.loadGroup('group');
    expect(progress).toEqual([0.5, 1]);
  });

  it('reference counting: last release disposes, earlier ones do not', async () => {
    const { manager, loaderCalls } = makeManager();
    manager.registerAssets([{ id: 'd', kind: 'json', url: 'd.json' }]);
    await manager.load('d');
    await manager.load('d'); // refCount 2
    manager.release('d');
    expect(loaderCalls).not.toContain(-1); // still referenced
    manager.release('d');
    expect(loaderCalls).toContain(-1); // disposed
  });

  it('fails loudly for unknown assets / missing loaders', async () => {
    const { manager } = makeManager();
    await expect(manager.load('ghost')).rejects.toThrowError(AssetError);
    manager.registerAssets([{ id: 'texture.x', kind: 'texture', url: 'x.png' }]);
    await expect(manager.load('texture.x')).rejects.toThrowError(AssetError);
  });

  it('registry validates descriptors', () => {
    const registry = new AssetRegistry();
    expect(() => registry.register({ id: 'bad', kind: 'generated' })).toThrowError(AssetError);
    expect(() => registry.register({ id: 'bad2', kind: 'json' })).toThrowError(AssetError);
    registry.register({ id: 'ok', kind: 'json', url: 'ok.json' });
    expect(() => registry.registerGroup('g', ['missing'])).toThrowError(AssetError);
  });
});
