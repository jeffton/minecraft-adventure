const dateTime = value => new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  timeZone: 'Europe/Stockholm',
}).format(new Date(value));

const vital = value => value === null ? '—' : new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value);

function node(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function render(data) {
  const stale = Date.now() - new Date(data.observedAt).getTime() > 20 * 60_000;
  document.querySelector('.live').classList.toggle('stale', stale);
  document.querySelector('#updated').textContent = stale
    ? `Stale status · last observed ${dateTime(data.observedAt)}`
    : `Journal updated ${dateTime(data.publishedAt)}`;
  document.querySelector('#objective').textContent = data.objective;
  document.querySelector('#long-term').textContent = data.longTerm;
  document.querySelector('#version').textContent = data.serverVersion;
  const latestImage = data.entries.find(entry => entry.image !== null);
  const hero = document.querySelector('#hero-image');
  if (latestImage) {
    hero.src = latestImage.image;
    hero.hidden = false;
    document.querySelector('#image-empty').hidden = true;
    document.querySelector('#image-time').textContent = dateTime(latestImage.at);
  }
  document.querySelector('#crew').replaceChildren(...data.bots.map(bot => {
    const card = node('article', '', 'bot');
    card.append(node('div', bot.name[0], 'bot-icon'), node('h3', bot.name),
      node('p', bot.status === 'online' ? bot.role : `${bot.role} · ${bot.status}`, 'role'), node('p', bot.task, 'task'));
    const vitals = node('div', '', 'vitals');
    vitals.append(node('span', `Health ${vital(bot.health)}/20`),
      node('span', `Food ${vital(bot.food)}/20`));
    card.append(vitals);
    return card;
  }));
  document.querySelector('#milestones').replaceChildren(...data.milestones.map((milestone, index) => {
    const item = node('li', '', milestone.completed ? 'done' : '');
    item.append(node('span', milestone.completed ? '✓ ACHIEVED' : `0${index + 1}`, 'step'),
      node('span', milestone.label));
    return item;
  }));
  document.querySelector('#journal').replaceChildren(...data.entries.map(entry => {
    const article = node('article', '', 'entry');
    const time = node('time', dateTime(entry.at));
    time.dateTime = entry.at;
    const body = node('div', '');
    body.append(node('h3', entry.title), node('p', entry.summary));
    if (entry.events.length) {
      const list = node('ul', '');
      list.append(...entry.events.map(event => node('li', event)));
      body.append(list);
    }
    if (entry.captureError !== null) body.append(node('p', `Camera: ${entry.captureError}`, 'error'));
    article.append(time, body);
    if (entry.image !== null) {
      const image = document.createElement('img');
      image.src = entry.image;
      image.alt = `Bot camera ${dateTime(entry.at)}`;
      image.loading = 'lazy';
      article.append(image);
    }
    return article;
  }));
}

async function refresh() {
  const response = await fetch('data.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Journal returned ${response.status}`);
  render(await response.json());
}

function reportError(error) {
  console.error(error);
  document.querySelector('#updated').textContent = 'Could not load the journal.';
  document.querySelector('.live').classList.add('stale');
}

const liveToggle = document.querySelector('#live-toggle');
const cameraControls = document.querySelector('#camera-controls');
const cameraBot = document.querySelector('#camera-bot');
let liveMonitor;
const itemLabel = item => item ? `${item.name.replaceAll('_', ' ')} ×${item.count}` : 'Empty';

function startCamera() {
  document.querySelector('#live-feed')?.remove();
  clearInterval(liveMonitor);
  document.querySelector('#camera-kit').replaceChildren();
  document.querySelector('#camera-inventory').replaceChildren();
  document.querySelector('#inventory-count').textContent = '';
  document.querySelector('#camera-state').textContent = `Connecting to ${cameraBot.value}…`;
  const feed = document.createElement('iframe');
  feed.id = 'live-feed';
  feed.title = `Live first-person camera: ${cameraBot.value}`;
  feed.src = cameraBot.value === 'Roy' ? 'live/' : `live/${cameraBot.value}/`;
  feed.allow = 'fullscreen';
  document.querySelector('.hero').append(feed);
  cameraControls.hidden = false;
  document.querySelector('#image-time').hidden = true;
  liveToggle.textContent = 'Show latest snapshot';
  liveToggle.setAttribute('aria-pressed', 'true');
  document.querySelector('#camera-label').textContent = 'CONNECTING CAMERA…';
  let connectedBefore = false;
  liveMonitor = setInterval(() => {
    const live = feed.contentWindow;
    const state = live?.roycraftState;
    const connected = live?.roycraftConnected === true && state?.status === 'online' && state.name === cameraBot.value && Date.now() - state.at < 5000;
    connectedBefore ||= connected;
    document.querySelector('#camera-label').textContent = connected
      ? 'LIVE BOT CAMERA'
      : connectedBefore ? 'CAMERA DISCONNECTED' : 'CONNECTING CAMERA…';
    if (!connected) {
      document.querySelector('#camera-state').textContent = `${cameraBot.value} · ${state?.status === 'offline' ? 'Offline' : 'Waiting for live observations'}`;
      document.querySelector('#camera-kit').replaceChildren();
      document.querySelector('#camera-inventory').replaceChildren();
      document.querySelector('#inventory-count').textContent = '';
      return;
    }
    const p = state.position;
    document.querySelector('#camera-state').textContent = `${state.name} · ${state.digging ? `Mining ${state.digging.replaceAll('_', ' ')}` : state.moving ? 'Moving' : 'Stationary'} · ${state.action.replaceAll('action:', '')} · ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)} · Health ${vital(state.health)}/20 · Food ${vital(state.food)}/20`;
    document.querySelector('#camera-kit').replaceChildren(node('span', `Main hand: ${itemLabel(state.held)}`), node('span', `Off hand: ${itemLabel(state.offhand)}`));
    document.querySelector('#inventory-count').textContent = `(${state.inventory.reduce((sum, item) => sum + item.count, 0)} items)`;
    document.querySelector('#camera-inventory').replaceChildren(...(state.inventory.length ? state.inventory.map(item => node('span', itemLabel(item))) : [node('span', 'Inventory is empty')]));
  }, 250);
}

cameraBot.addEventListener('change', startCamera);
liveToggle.addEventListener('click', () => {
  const existing = document.querySelector('#live-feed');
  if (existing) {
    existing.remove();
    cameraControls.hidden = true;
    document.querySelector('#image-time').hidden = false;
    clearInterval(liveMonitor);
    liveToggle.textContent = 'Watch live ↗';
    liveToggle.setAttribute('aria-pressed', 'false');
    document.querySelector('#camera-label').textContent = 'BOT CAMERA';
    return;
  }
  startCamera();
});

refresh().catch(reportError);
setInterval(() => refresh().catch(reportError), 60_000);
