import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('public/vendor',{recursive:true});
await copyFile('node_modules/webtorrent/dist/webtorrent.min.js','public/vendor/webtorrent.min.js');
