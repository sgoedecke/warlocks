// Dev gallery for the open texture pack: every generator, plus skins baked onto the
// warlock model when the map file is available (?bake=Model.mdx to pick another).
import { OPEN_TEXTURE_PATHS, hasOpenTexture, openTextureCanvas } from '../src/render/opentex/particles';
import { bakeSkin, hasSkinRecipe } from '../src/render/opentex/bake';
import { initAssets } from '../src/assets/loader';
import { assets } from '../src/assets/store';

const grid = document.getElementById('grid')!;

function show(label: string, c: HTMLCanvasElement, dark = false) {
  const f = document.createElement('figure');
  if (dark) f.className = 'dark';
  f.append(c);
  const cap = document.createElement('figcaption');
  cap.textContent = `${label} (${c.width}x${c.height})`;
  f.append(cap);
  grid.append(f);
}

const dark = new URLSearchParams(location.search).has('dark');
for (const p of OPEN_TEXTURE_PATHS) show(p.split('\\').pop()!, openTextureCanvas(p, 8, 8)!, dark);

await initAssets();
const name = new URLSearchParams(location.search).get('bake') ?? 'BloodelfWizard.mdx';
const model = await assets.model(name);
if (model) {
  model.textures.forEach((t, i) => {
    if (t.replaceableId || assets.has(t.path) || (hasOpenTexture(t.path) && !hasSkinRecipe(t.path))) return;
    const c = bakeSkin(model as unknown as Parameters<typeof bakeSkin>[0], i);
    if (c) show(`baked ${t.path.split('\\').pop()}`, c);
  });
}
(window as unknown as { __ready: boolean }).__ready = true;
