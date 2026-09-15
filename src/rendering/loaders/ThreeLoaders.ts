import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { AssetDescriptor, AssetLoader, LoadedAsset } from '../../assets/AssetTypes';
import { AssetError } from '../../utils/errors';

/**
 * Three.js-backed asset loaders, registered into the AssetManager by the
 * renderer bootstrap. The assets layer itself never imports Three.js.
 */

export class TextureLoaderAdapter implements AssetLoader {
  readonly kind = 'texture' as const;
  private readonly loader = new THREE.TextureLoader();

  async load(descriptor: AssetDescriptor): Promise<LoadedAsset> {
    if (descriptor.url === undefined) throw new AssetError(`Asset "${descriptor.id}" missing url`);
    const texture = await this.loader.loadAsync(descriptor.url);
    return {
      data: texture,
      dispose: () => texture.dispose()
    };
  }
}

export class ModelLoaderAdapter implements AssetLoader {
  readonly kind = 'model' as const;
  private readonly loader = new GLTFLoader();

  async load(descriptor: AssetDescriptor): Promise<LoadedAsset> {
    if (descriptor.url === undefined) throw new AssetError(`Asset "${descriptor.id}" missing url`);
    const gltf = (await this.loader.loadAsync(descriptor.url)) as GLTF;
    return {
      data: gltf.scene,
      dispose: () => {
        gltf.scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.geometry !== undefined) mesh.geometry.dispose();
          const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
          else material?.dispose();
        });
      }
    };
  }
}

export class AudioLoaderAdapter implements AssetLoader {
  readonly kind = 'audio' as const;
  private readonly loader = new THREE.AudioLoader();

  async load(descriptor: AssetDescriptor): Promise<LoadedAsset> {
    if (descriptor.url === undefined) throw new AssetError(`Asset "${descriptor.id}" missing url`);
    const buffer = await this.loader.loadAsync(descriptor.url);
    return { data: buffer };
  }
}

/** Registers every Three-backed loader into the asset manager. */
export function registerThreeLoaders(register: (loader: AssetLoader) => void): void {
  register(new TextureLoaderAdapter());
  register(new ModelLoaderAdapter());
  register(new AudioLoaderAdapter());
}
