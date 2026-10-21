/// <reference lib="webworker" />
import {createSHA256} from 'hash-wasm';
self.onmessage=async(event:MessageEvent<File>)=>{
  try {
    const file=event.data, hasher=await createSHA256();hasher.init();
    for(let offset=0;offset<file.size;offset+=4*1024*1024){hasher.update(new Uint8Array(await file.slice(offset,offset+4*1024*1024).arrayBuffer()));self.postMessage({progress:Math.min(1,(offset+4*1024*1024)/file.size)});}
    self.postMessage({hash:hasher.digest('hex')});
  } catch {self.postMessage({error:'ファイルのハッシュを計算できません'});}
};
