import * as THREE from 'three';
import type { StrategicMapModel } from '../../world/map/MapTypes';
import type { MapTheme } from './MapTheme';
import { updateLabels } from './LabelLod';
import type { LabelAlphaStore, LabelFrame, LabelRecord, LabelTier, LabelView } from './LabelLod';

/**
 * LabelLayer — world-anchored text labels (canvas → sprite textures).
 *
 * LOD decisions (tier fades, viewport culling, collision, cap) live in the
 * pure LabelLod module; this class only builds records once, creates sprites
 * LAZILY (a label's texture exists only after it first becomes visible) and
 * applies each frame's decisions: alpha, screen-constant size and position.
 *
 * Because sprites are pooled per label and only visible labels are touched,
 * the per-frame cost scales with what is on screen — not with total city
 * count — so thousands of cities stay cheap.
 */

const FONT_PX = 42;
const CANVAS_PADDING = 12;
const MONO_FONT = `ui-monospace, 'JetBrains Mono', Consolas, Menlo, monospace`;

export class LabelLayer {
  readonly group = new THREE.Group();

  readonly records: LabelRecord[] = [];
  private readonly texts = new Map<string, string>();
  private readonly alphas: LabelAlphaStore = new Map();
  private readonly sprites = new Map<string, THREE.Sprite>();
  private readonly theme: MapTheme;
  private readonly measureCanvas: HTMLCanvasElement | null;

  constructor(model: StrategicMapModel, theme: MapTheme) {
    this.theme = theme;
    this.measureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;

    let recordId = 0;

    const push = (record: Omit<LabelRecord, 'id'>, text: string): void => {
      const id = `label.${recordId++}`;
      this.records.push({ ...record, id });
      this.texts.set(id, text);
    };

    for (const countryId of model.countryOrder) {
      const country = model.countries[countryId];
      const text = country.name.toUpperCase();
      push(
        {
          tier: 'country',
          x: country.labelPoint.x,
          z: country.labelPoint.z,
          population: 0,
          importance: 0,
          aspect: this.measureAspect(text, true),
          offsetBelow: false
        },
        text
      );
    }

    for (const province of Object.values(model.provinces)) {
      push(
        {
          tier: 'province',
          x: province.labelPoint.x,
          z: province.labelPoint.z,
          population: 0,
          importance: 0,
          aspect: this.measureAspect(province.name, false),
          offsetBelow: false
        },
        province.name
      );
    }

    for (const city of Object.values(model.cities)) {
      // Part 3: the label tier follows the city TYPE (capital / major /
      // medium → city / small+settlement → settlement) so unimportant names
      // only appear when the player actually zooms in — and city importance
      // nudges collision priority within the tier.
      const tier: LabelTier = city.isCapital
        ? 'capital'
        : city.type === 'major'
          ? 'majorCity'
          : city.type === 'medium'
            ? 'city'
            : 'settlement';
      push(
        {
          tier,
          x: city.position.x,
          z: city.position.z,
          population: city.population,
          importance: city.importance,
          aspect: this.measureAspect(city.name, false),
          offsetBelow: true
        },
        city.name
      );
    }
  }

  /** Runs the LOD pass and syncs sprites. Returns the frames (debug/testing). */
  update(view: LabelView, dtSeconds: number): LabelFrame[] {
    const frames = updateLabels(this.records, view, this.theme.labels, this.alphas, dtSeconds);
    const worldPerPx = view.viewHeight / view.viewportHeightPx;

    for (const frame of frames) {
      if (!frame.visible) {
        const hidden = this.sprites.get(frame.record.id);
        if (hidden !== undefined && hidden.visible) hidden.visible = false;
        continue;
      }
      const sprite = this.ensureSprite(frame.record);
      sprite.visible = true;
      (sprite.material as THREE.SpriteMaterial).opacity = frame.alpha;
      const offsetZ = frame.record.offsetBelow ? this.theme.labels.labelOffsetPx * worldPerPx : 0;
      const height = frame.record.offsetBelow ? 2.2 : 2.5;
      sprite.position.set(frame.record.x, height, frame.record.z + offsetZ);
      sprite.scale.set(frame.scaleWorld * frame.record.aspect, frame.scaleWorld, 1);
    }
    return frames;
  }

  /** How many labels are currently rendered (alpha > threshold). */
  get renderedCount(): number {
    let count = 0;
    for (const alpha of this.alphas.values()) if (alpha > 0.02) count += 1;
    return count;
  }

  dispose(): void {
    for (const sprite of this.sprites.values()) {
      const material = sprite.material as THREE.SpriteMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.sprites.clear();
    this.textures.length = 0;
    this.alphas.clear();
    this.group.clear();
  }

  private readonly textures: THREE.Texture[] = [];

  /** Creates the sprite for a label the first time it becomes visible. */
  private ensureSprite(record: LabelRecord): THREE.Sprite {
    const existing = this.sprites.get(record.id);
    if (existing !== undefined) return existing;

    const text = this.texts.get(record.id) ?? record.id;
    const bold = record.tier === 'country';
    const font = `${bold ? '700 ' : ''}${FONT_PX}px ${MONO_FONT}`;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    context.font = font;
    const metrics = context.measureText(text);
    canvas.width = Math.ceil(metrics.width + CANVAS_PADDING * 2);
    canvas.height = FONT_PX + CANVAS_PADDING * 2;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = font;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    context.strokeStyle = this.theme.labelHaloColor;
    context.lineWidth = 8;
    context.strokeText(text, canvas.width / 2, canvas.height / 2);
    context.fillStyle = this.theme.labelColor;
    context.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 2;
    this.textures.push(texture);

    const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = bold ? 30 : 31;
    this.sprites.set(record.id, sprite);
    this.group.add(sprite);
    return sprite;
  }

  /** Measures text aspect once at construction (shared canvas, no sprites). */
  private measureAspect(text: string, bold: boolean): number {
    if (this.measureCanvas === null) return Math.max(1, text.length * 0.62);
    const context = this.measureCanvas.getContext('2d');
    if (context === null) return Math.max(1, text.length * 0.62);
    context.font = `${bold ? '700 ' : ''}${FONT_PX}px ${MONO_FONT}`;
    return Math.max(0.5, context.measureText(text).width / FONT_PX);
  }
}
