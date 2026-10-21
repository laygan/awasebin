import sharp from 'sharp';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
const [source,destination]=process.argv.slice(2);
sharp.cache(false); sharp.concurrency(1);
await mkdir(path.dirname(destination),{recursive:true});
// No withMetadata(): EXIF and geolocation are omitted from derived images.
await sharp(source,{limitInputPixels:40_000_000,animated:false,pages:1}).rotate().resize(640,640,{fit:'inside',withoutEnlargement:true}).webp({quality:75}).toFile(destination);
