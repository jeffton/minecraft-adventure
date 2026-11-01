import { clearInventory, renderInventory } from './inventory.js';

let itemAssets;
try {
  const response = await fetch('item-assets/manifest.json');
  if (!response.ok) throw new Error(`Item artwork returned ${response.status}`);
  itemAssets = await response.json();
} catch (error) {
  console.error(error);
  document.querySelector('#image-empty').textContent = 'Item artwork could not load';
  document.querySelector('#camera-state').textContent = 'Item artwork could not load';
  clearInventory('Item artwork could not load');
}

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

function render(data, journal = data) {
  const stale = Date.now() - new Date(data.observedAt).getTime() > 20 * 60_000;
  document.querySelector('.live').classList.toggle('stale', stale);
  document.querySelector('#updated').textContent = stale
    ? `Stale status · last observed ${dateTime(data.observedAt)}`
    : `Journal updated ${dateTime(data.publishedAt)}`;
  document.querySelector('#objective').textContent = data.objective;
  document.querySelector('#long-term').textContent = data.longTerm;
  document.querySelector('#version').textContent = data.serverVersion;
  document.querySelector('#crew').replaceChildren(...data.bots.map(bot => {
    const card = node('article', '', 'bot');
    card.dataset.name = bot.name;
    card.append(node('div', bot.name[0], 'bot-icon'), node('h3', bot.name),
      node('p', bot.status === 'online' ? bot.role : `${bot.role} · ${bot.status}`, 'role'),
      node('p', bot.name === cameraBot ? liveTask : bot.task, 'task'));
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
  document.querySelector('#journal').replaceChildren(...journal.entries.map(entry => {
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
  const data = await response.json();
  const selectedWorld = new URLSearchParams(location.search).get('world');
  const archives = document.querySelector('#world-archives');
  archives.replaceChildren();
  for (const world of [{ worldId: data.worldId }, ...data.archives]) {
    const link = node('a', world.worldId === data.worldId ? 'Current world' : world.worldId);
    link.href = `?world=${encodeURIComponent(world.worldId)}#journal`;
    archives.append(link);
  }
  let journal = data;
  if (selectedWorld && selectedWorld !== data.worldId) {
    const archive = data.archives.find(world => world.worldId === selectedWorld);
    if (!archive) throw new Error(`Unknown diary world: ${selectedWorld}`);
    const archived = await fetch(archive.path, { cache: 'no-store' });
    if (!archived.ok) throw new Error(`Archived diary returned ${archived.status}`);
    journal = await archived.json();
  }
  document.querySelector('#journal-title').textContent = journal === data ? 'Field notes' : `Field notes · ${selectedWorld}`;
  render(data, journal);
}

function reportError(error) {
  console.error(error);
  document.querySelector('#updated').textContent = 'Could not load the journal.';
  document.querySelector('.live').classList.add('stale');
}

const cameraBot = 'Roy';
let liveMonitor;
let inventorySignature;
let liveTask = 'Waiting for live observations';

function setLiveTask(task) {
  liveTask = task;
  for (const card of document.querySelectorAll('#crew .bot')) {
    if (card.dataset.name === cameraBot) card.querySelector('.task').textContent = task;
  }
}

function stopCamera(message) {
  document.querySelector('#live-feed')?.remove();
  clearInterval(liveMonitor);
  clearInventory(message);
  inventorySignature = undefined;
  setLiveTask('Waiting for live observations');
}

function startCamera() {
  stopCamera('Waiting for live inventory');
  document.querySelector('#camera-state').textContent = `Connecting to ${cameraBot}…`;
  const feed = document.createElement('iframe');
  feed.id = 'live-feed';
  feed.title = `Live first-person camera: ${cameraBot}`;
  feed.src = 'live/';
  feed.allow = 'fullscreen';
  document.querySelector('.hero').append(feed);
  document.querySelector('#camera-label').textContent = 'CONNECTING CAMERA…';
  let connectedBefore = false;
  liveMonitor = setInterval(() => {
    const live = feed.contentWindow;
    const state = live?.roycraftState;
    const connected = live?.roycraftConnected === true && state?.status === 'online' && state.name === cameraBot && Date.now() - state.at < 5000;
    connectedBefore ||= connected;
    document.querySelector('#camera-label').textContent = connected
      ? 'LIVE BOT CAMERA'
      : connectedBefore ? 'CAMERA DISCONNECTED' : 'CONNECTING CAMERA…';
    if (!connected) {
      const status = state?.name === cameraBot && state.status === 'offline' ? 'offline' : 'waiting';
      const task = status === 'offline' ? 'Offline' : 'Waiting for live observations';
      document.querySelector('#camera-state').textContent = `${cameraBot} · ${task}`;
      setLiveTask(task);
      clearInventory('Live inventory unavailable');
      inventorySignature = undefined;
      return;
    }
    setLiveTask(state.action);
    const p = state.position;
    document.querySelector('#camera-state').textContent = `${state.name} · ${state.digging ? `Mining ${state.digging.replaceAll('_', ' ')}` : state.moving ? 'Moving' : 'Stationary'} · ${state.action.replaceAll('action:', '')} · ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
    const signature = JSON.stringify([state.health, state.food, state.held, state.offhand, state.inventory]);
    if (signature !== inventorySignature) {
      renderInventory(state, itemAssets);
      inventorySignature = signature;
    }
  }, 250);
}

refresh().catch(reportError);
setInterval(() => refresh().catch(reportError), 60_000);
if (itemAssets) startCamera();
