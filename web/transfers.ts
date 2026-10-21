import {Upload} from 'tus-js-client';
export function sha256(file:File,onProgress:(n:number)=>void):Promise<string>{
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./hash.worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=e=>{if(e.data.progress!==undefined)onProgress(e.data.progress);if(e.data.hash){worker.terminate();resolve(e.data.hash);}if(e.data.error){worker.terminate();reject(new Error(e.data.error));}};
    worker.onerror=()=>{worker.terminate();reject(new Error('ハッシュ処理に失敗しました'));};worker.postMessage(file);
  });
}
export function upload(file:File,authorization:{endpoint:string;token:string;jobId:string},onProgress:(n:number)=>void,onDone:()=>void,onError:(e:Error)=>void){
  const transfer=new Upload(file,{endpoint:authorization.endpoint,headers:{'Upload-Token':authorization.token},chunkSize:16*1024*1024,
    retryDelays:[0,1000,3000,5000,10000],removeFingerprintOnSuccess:true,
    fingerprint:async()=>`awasebin:${authorization.jobId}:${file.size}:${file.lastModified}`,
    onProgress:(sent,total)=>onProgress(sent/total),onSuccess:onDone,onError});
  void transfer.findPreviousUploads().then(previous=>{if(previous[0])transfer.resumeFromPreviousUpload(previous[0]);transfer.start();}).catch(onError);
  return transfer;
}

// A disk-backed WebTorrent chunk store: no album-sized Blob or memory chunk store.
export class DiskStore {
  chunkLength:number; db:Promise<IDBDatabase>; closed=false;
  constructor(chunkLength:number,options:{torrent?:{infoHash:string};name?:string}){
    this.chunkLength=chunkLength;
    const name=`awasebin-pieces-${options.torrent?.infoHash||options.name||'download'}`;
    this.db=new Promise((resolve,reject)=>{
      const request=indexedDB.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('pieces');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
  }
  put(index:number,buffer:Uint8Array,callback:(error?:Error|null)=>void){
    void this.db.then(db=>{if(this.closed)throw new Error('Store closed');const tx=db.transaction('pieces','readwrite');tx.objectStore('pieces').put(new Uint8Array(buffer),index);tx.oncomplete=()=>callback(null);tx.onerror=()=>callback(new Error('保存領域が不足しています'));}).catch(callback);
  }
  get(index:number,options:any,callback?:any){
    if(typeof options==='function'){callback=options;options={};}
    void this.db.then(db=>{const req=db.transaction('pieces').objectStore('pieces').get(index);req.onsuccess=()=>{if(!req.result)return callback(new Error('Piece not available'));const data=req.result;callback(null,data.subarray(options.offset||0,(options.offset||0)+(options.length??data.length)));};req.onerror=()=>callback(req.error);}).catch(callback);
  }
  close(callback:()=>void){this.closed=true;void this.db.then(db=>{db.close();callback();});}
  destroy(callback:()=>void){this.close(callback);}
}
declare global {interface Window {WebTorrent:any;showDirectoryPicker?:()=>Promise<any>}}
let scriptPromise:Promise<void>|null=null;
async function loadTorrent(){
  if(window.WebTorrent)return;
  scriptPromise??=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/vendor/webtorrent.min.js';s.onload=()=>resolve();s.onerror=()=>reject(new Error('P2Pライブラリを取得できません'));document.head.appendChild(s);});
  await scriptPromise;
}
export async function p2pDownload(session:{infoHash:string;announce:string;iceServers:any[]},total:number,files:{id:string;original_name:string;sha256:string;size_bytes:number|string}[],onProgress:(s:string)=>void){
  if(!window.showDirectoryPicker)throw new Error('このブラウザではHTTPダウンロードをご利用ください');
  const destination=await window.showDirectoryPicker();
  const estimate=await navigator.storage.estimate();
  if((estimate.quota||0)-(estimate.usage||0)<total*1.1)throw new Error('ブラウザの一時保存領域が不足しています。HTTPダウンロードをご利用ください');
  await loadTorrent();
  const client=new window.WebTorrent({dht:false,lsd:false,utPex:false,webSeeds:false,maxConns:1,uploadLimit:0,tracker:{rtcConfig:{iceServers:session.iceServers}}});
  return new Promise<void>((resolve,reject)=>{
    let done=false;
    const stop=(err?:Error)=>{if(done)return;done=true;clearTimeout(timeout);clearInterval(progress);client.destroy();err?reject(err):resolve();};
    const timeout=setTimeout(()=>stop(new Error('P2P接続が成立しませんでした。HTTPダウンロードをご利用ください')),25000);
    const progress=setInterval(()=>{const t=client.torrents[0];if(t)onProgress(`P2P ${Math.round(t.progress*100)}% · ${(client.downloadSpeed/1024/1024).toFixed(1)} MB/s`);},1000);
    client.on('error',(e:Error)=>stop(e));
    const t=client.add(`magnet:?xt=urn:btih:${session.infoHash}`,{announce:[session.announce],store:DiskStore,storeCacheSlots:2, strategy:'sequential'});
    t.on('wire',(w:any)=>{clearTimeout(timeout);w.choke();w.unchoke=()=>{};});
    t.on('error',(e:Error)=>stop(e));
    t.on('done',async()=>{
      try {
        for(const file of t.files){
          const metadata=files.find(f=>f.id===file.name);
          if(!metadata || Number(metadata.size_bytes)!==file.length)throw new Error('ファイル情報が一致しません');
          const {createSHA256}=await import('hash-wasm');const digest=await createSHA256();digest.init();
          const handle=await destination.getFileHandle(`${metadata.id.slice(0,8)}_${metadata.original_name}`,{create:true}),writer=await handle.createWritable();
          try{for await(const chunk of file.createReadStream()){digest.update(chunk);await writer.write(chunk);}if(digest.digest('hex')!==metadata.sha256)throw new Error('SHA-256が一致しません');await writer.close();}
          catch(e){await writer.abort();throw e;}
        }
        onProgress('Torrentピース検証・ディスク保存完了');stop();
      }catch{stop(new Error('ディスク保存に失敗しました。HTTPダウンロードをご利用ください'));}
    });
  });
}
