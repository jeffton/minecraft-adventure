const element = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function itemName(name) {
  return name.replaceAll('_', ' ');
}

export function meterCells(value) {
  return Array.from({ length: 10 }, (_, index) => Math.min(2, Math.max(0, Math.ceil(value) - index * 2)));
}

function slot(item, assets, label) {
  const description = item ? `${itemName(item.name)} ×${item.count}` : 'Empty';
  const node = element('div', `mc-slot${item ? '' : ' mc-slot-empty'}`);
  node.tabIndex = 0;
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', label ? `${label}: ${description}` : description);
  node.title = label ? `${label}: ${description}` : description;
  if (item) {
    const sprite = assets.items[item.name];
    if (sprite) {
      const image = element('img', 'mc-item');
      image.src = sprite;
      image.alt = '';
      image.draggable = false;
      node.append(image);
      if (assets.kinds[item.name].endsWith('texture-preview')) node.title += ' · Texture preview';
    } else {
      // A future game item must be identifiable, never drawn as a different item.
      node.append(element('span', 'mc-unmapped', itemName(item.name)));
      node.title += ' · Artwork unavailable';
    }
    if (item.count > 1) node.append(element('span', 'mc-count', String(item.count)));
  }
  const tooltip = element('span', 'mc-tooltip', node.title);
  tooltip.setAttribute('aria-hidden', 'true');
  node.append(tooltip);
  return node;
}

function meter(label, value, assets, prefix) {
  const node = element('div', 'mc-meter');
  node.setAttribute('role', 'img');
  const description = value === null ? `${label} unknown` : `${label} ${value}/20`;
  node.setAttribute('aria-label', description);
  node.title = description;
  if (value === null) {
    node.append(element('span', 'mc-unknown', description));
    return node;
  }
  for (const fill of meterCells(value)) {
    const cell = element('span', 'mc-meter-cell');
    const background = element('img', 'mc-meter-image');
    background.src = assets.hud[`${prefix}Empty`];
    background.alt = '';
    cell.append(background);
    if (fill) {
      const foreground = element('img', 'mc-meter-image');
      foreground.src = assets.hud[`${prefix}${fill === 2 ? 'Full' : 'Half'}`];
      foreground.alt = '';
      cell.append(foreground);
    }
    node.append(cell);
  }
  return node;
}

export function renderInventory(state, assets) {
  document.querySelector('#camera-vitals').replaceChildren(
    meter('Health', state.health, assets, 'heart'), meter('Food', state.food, assets, 'food'),
  );
  document.querySelector('#camera-kit').replaceChildren(...[
    ['Main hand', state.held], ['Off hand', state.offhand],
  ].map(([label, item]) => {
    const hand = element('div', 'mc-hand');
    hand.append(slot(item, assets, label), element('span', 'mc-hand-label', label));
    return hand;
  }));
  document.querySelector('#inventory-count').textContent = `(${state.inventory.reduce((sum, item) => sum + item.count, 0)} items)`;
  const inventory = document.querySelector('#camera-inventory');
  inventory.replaceChildren(...state.inventory.map(item => slot(item, assets)));
  if (!state.inventory.length) inventory.append(element('p', 'mc-empty-message', 'Inventory is empty'));
}

export function clearInventory() {
  for (const selector of ['#camera-vitals', '#camera-kit', '#camera-inventory']) {
    document.querySelector(selector).replaceChildren();
  }
  document.querySelector('#inventory-count').textContent = '';
}
