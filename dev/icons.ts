import { ALL_SPELLS, ITEMS, SPELLS } from '../src/config';
import { btnIcon } from '../src/render/textures';

const BTN = 'ReplaceableTextures\\CommandButtons\\';
const PAS = 'ReplaceableTextures\\PassiveButtons\\';

interface Entry { group: string; label: string; path: string }

const entries: Entry[] = [
  ...ALL_SPELLS.map((id) => ({ group: 'Spells', label: SPELLS[id].name, path: SPELLS[id].icon })),
  ...Object.values(ITEMS).map((item) => ({ group: 'Items', label: item.name, path: item.icon })),
  { group: 'Merchant / researches', label: 'Inventory', path: `${BTN}BTNPackBeast.blp` },
  { group: 'Merchant / researches', label: 'Range Mastery', path: `${PAS}PASBTNTrueShot.blp` },
  { group: 'Merchant / researches', label: 'Life Steal Mastery', path: `${PAS}PASBTNMagicImmunity.blp` },
  { group: 'Merchant / researches', label: 'Area Mastery', path: `${PAS}PASBTNScatterRockets.blp` },
  { group: 'Shop navigation', label: 'Merchant', path: `${BTN}BTNAcolyte.blp` },
  { group: 'Shop navigation', label: 'Spells 1', path: `${BTN}BTNNecromancerAdept.blp` },
  { group: 'Shop navigation', label: 'Spells 2', path: `${BTN}BTNTomeOfRetraining.blp` },
  { group: 'Shop navigation', label: 'Items', path: `${BTN}BTNDust.blp` },
  { group: 'Toggles', label: 'Flag', path: `${BTN}BTNHumanCaptureFlag.blp` },
  { group: 'Toggles', label: 'Hire', path: `${BTN}BTNHire.blp` },
];

const root = document.querySelector<HTMLDivElement>('#root')!;
const groups = [...new Set(entries.map((entry) => entry.group))];

for (const group of groups) {
  const section = document.createElement('section');
  section.innerHTML = `<h2>${group}</h2><div class="grid"></div>`;
  const grid = section.querySelector<HTMLDivElement>('.grid')!;
  for (const entry of entries.filter((candidate) => candidate.group === group)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="icons">
        <img width="64" height="64" alt="${entry.label} 64px">
        <img width="32" height="32" alt="${entry.label} 32px">
      </div>
      <div class="label"></div>
      <div class="path"></div>`;
    const [large, small] = card.querySelectorAll<HTMLImageElement>('img');
    large.src = btnIcon(entry.path, 64);
    small.src = btnIcon(entry.path, 32);
    card.querySelector<HTMLDivElement>('.label')!.textContent = entry.label;
    card.querySelector<HTMLDivElement>('.path')!.textContent = entry.path.split('\\').pop() ?? entry.path;
    grid.appendChild(card);
  }
  root.appendChild(section);
}
