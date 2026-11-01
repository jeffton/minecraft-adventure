import { createRequire } from 'node:module';
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const mineflayer = require('mineflayer');

async function probe(username, port, expectJoin) {
  return await new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host: '127.0.0.1', port, username, auth: 'offline', version: process.env.CLIENT_VERSION ?? '1.21.4' });
    const timer = setTimeout(() => { bot.quit(); reject(new Error(`${username}: timeout`)); }, 25000);
    let joined = false;
    bot.once('spawn', async () => {
      joined = true;
      try {
        await new Promise(r => setTimeout(r, 2500));
        if (!expectJoin) throw new Error(`${username} unexpectedly reached world`);
        if (bot.game.gameMode !== 'survival') throw new Error(`Unexpected game mode ${bot.game.gameMode}`);
        if (!Number.isFinite(bot.health)) throw new Error('Missing health');
        const block = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        if (!block) throw new Error('Missing world chunks');
        console.log(JSON.stringify({ username, port, joined, version: bot.version, gamemode: bot.game.gameMode,
          health: bot.health, food: bot.food, below: block.name, position: bot.entity.position }));
        bot.quit(); clearTimeout(timer); resolve();
      } catch (e) { bot.quit(); clearTimeout(timer); reject(e); }
    });
    bot.once('kicked', reason => {
      clearTimeout(timer);
      if (expectJoin) reject(new Error(`${username} kicked: ${JSON.stringify(reason)}`));
      else { console.log(JSON.stringify({ username, port, rejected: true, reason })); resolve(); }
    });
    bot.on('error', error => { clearTimeout(timer); reject(error); });
    bot.once('end', reason => {
      if (!joined && expectJoin) { clearTimeout(timer); reject(new Error(`${username} ended: ${reason}`)); }
    });
  });
}

await probe('Roy', 25567, true);
await probe('UnlistedProbe', 25567, false);
await probe('Roy', 25566, false);
