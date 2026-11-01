// The current Overworld is -64..319. Empty sections outside other dimensions
// are ignored by the worker, using each decoded chunk's own minY and sections.
// Keep these functions self-contained: bootstrap serializes them into its route.
export function patchViewerHeightClient(source) {
  const edits = [
    ['postMessage({type:"chunk",x:t,z:e,chunk:i});for(let i=0;i<256;i+=16)',
      'postMessage({type:"chunk",x:t,z:e,chunk:i});for(let i=-64;i<320;i+=16)'],
    ['postMessage({type:"unloadChunk",x:t,z:e});for(let i=0;i<256;i+=16)',
      'postMessage({type:"unloadChunk",x:t,z:e});for(let i=-64;i<320;i+=16)']
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Upstream client-height integration changed');
    source = source.replace(before, after);
  }
  return source;
}

export function patchViewerHeightWorker(source) {
  const edits = [
    ['i.sections[Math.floor(a/16)]', 'i.sections[Math.floor((a-i.minY)/16)]'],
    ['l.sections[Math.floor(n/16)]', 'l.sections[Math.floor((n-l.minY)/16)]'],
    ['if(g.position.y<0)continue;', ''],
    ['if(n.position.y<0)continue', '']
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Upstream worker-height integration changed');
    source = source.replace(before, after);
  }
  return source;
}
