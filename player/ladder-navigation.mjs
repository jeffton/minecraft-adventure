/** Keep ladder waypoints in the climbable cell, not on top of its thin panel. */
export function installLadderWaypoints(bot) {
  const repair = ({ path }) => {
    for (const node of path) {
      if (node.toBreak.length || node.toPlace.length) continue;
      // Pathfinder's Move hash retains the original grid cell after its
      // postprocessor moves x/y/z onto collision-shape tops.
      const [x, y, z] = node.hash.split(',').map(Number);
      const block = bot.blockAt(node.offset(x - node.x, y - node.y, z - node.z));
      if (block?.name !== 'ladder') continue;
      node.x = x + 0.5;
      node.y = y;
      node.z = z + 0.5;
    }
  };
  bot.on('path_update', repair);
  return () => bot.removeListener('path_update', repair);
}
