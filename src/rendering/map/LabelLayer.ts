import * as THREE from 'three';
import type { StrategicMapModel } from '../../world/map/MapTypes';
import type { MapTheme } from './MapTheme';

/**
 * LabelLayer — world-anchored text labels (canvas → sprite textures).
 * Country labels always render; city labels appear when zoomed in close
 * enough (config-driven LOD). Text is drawn with a halo so it stays readable
 * over any country color.
 */
export class LabelLayer {
  readonly countryGroup = new THREE.Group();
  readonly cityGroup = new THREE.Group();

  constructor(model: StrategicMapModel, theme: MapTheme) {
    for (const country of model.countryOrder) {
      const record = model.countries[country];
      const sprite = makeTextSprite(record.name.toUpperCase(), theme, theme.countryLabelSize, true);
      if (sprite === null) continue;
      sprite.position.set(record.labelPoint.x, 2.5, record.labelPoint.z);
      sprite.renderOrder = 30;
      this.countryGroup.add(sprite);
    }

    for (const city of Object.values(model.cities)) {
      const sprite = makeTextSprite(city.name, theme, theme.cityLabelSize, false);
      if (sprite === null) continue;
      // Offset below the marker so it does not cover it.
      sprite.position.set(city.position.x, 2.2, city.position.z + theme.cityLabelSize * 1.4);
      sprite.renderOrder = 31;
      sprite.visible = false; // LOD: enabled by the renderer when zoomed in
      sprite.userData = { cityId: city.id };
      this.cityGroup.add(sprite);
    }
  }

  /** Zoom-dependent label LOD — pure visibility toggles, no rebuilds. */
  applyZoomLod(viewHeight: number, cityLabelMaxViewHeight: number): void {
    const showCityLabels = viewHeight < cityLabelMaxViewHeight;
    for (const child of this.cityGroup.children) child.visible = showCityLabels;
  }

  dispose(): void {
    for (const group of [this.countryGroup, this.cityGroup]) {
      for (const child of [...group.children]) {
        const sprite = child as THREE.Sprite;
        const material = sprite.material as THREE.SpriteMaterial;
        material.map?.dispose();
        material.dispose();
      }
      group.clear();
    }
  }
}

function makeTextSprite(
  text: string,
  theme: MapTheme,
  worldHeight: number,
  bold: boolean
): THREE.Sprite | null {
  const padding = 12;
  const fontPx = 42;
  const font = `${bold ? '700 ' : ''}${fontPx}px ui-monospace, 'JetBrains Mono', Consolas, Menlo, monospace`;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.font = font;
  const metrics = context.measureText(text);
  canvas.width = Math.ceil(metrics.width + padding * 2);
  canvas.height = fontPx + padding * 2;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = font;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.strokeStyle = theme.labelHaloColor;
  context.lineWidth = 8;
  context.strokeText(text, canvas.width / 2, canvas.height / 2);
  context.fillStyle = theme.labelColor;
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;

  const aspect = canvas.width / canvas.height;
  const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(worldHeight * aspect, worldHeight, 1);
  return sprite;
}
