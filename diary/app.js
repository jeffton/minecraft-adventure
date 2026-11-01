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
let liveMonitor;
liveToggle.addEventListener('click', () => {
  const existing = document.querySelector('#live-feed');
  if (existing) {
    existing.remove();
    clearInterval(liveMonitor);
    liveToggle.textContent = 'Watch live ↗';
    liveToggle.setAttribute('aria-pressed', 'false');
    document.querySelector('#camera-label').textContent = 'BOT CAMERA';
    return;
  }
  const feed = document.createElement('iframe');
  feed.id = 'live-feed';
  feed.title = 'Live bot camera from Roycraft';
  feed.src = 'live/';
  feed.allow = 'fullscreen';
  document.querySelector('.hero').append(feed);
  liveToggle.textContent = 'Show latest snapshot';
  liveToggle.setAttribute('aria-pressed', 'true');
  document.querySelector('#camera-label').textContent = 'CONNECTING CAMERA…';
  let connectedBefore = false;
  liveMonitor = setInterval(() => {
    const connected = feed.contentWindow?.roycraftConnected === true;
    connectedBefore ||= connected;
    document.querySelector('#camera-label').textContent = connected
      ? 'LIVE BOT CAMERA'
      : connectedBefore ? 'CAMERA DISCONNECTED' : 'CONNECTING CAMERA…';
  }, 1000);
});

refresh().catch(reportError);
setInterval(() => refresh().catch(reportError), 60_000);
