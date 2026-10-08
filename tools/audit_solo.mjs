import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {Fat12,sha256} from '../web/disk.js';
import {createSoloAssist} from '../web/solo-assist.js';

const root=new URL('../web/',import.meta.url);
globalThis.fetch=async path=>{const bytes=await readFile(new URL(path,root));return new Response(bytes);};
const helper=await createSoloAssist(()=>null);
const inventory=JSON.parse(await readFile(new URL('../reports/asset-inventory.json',import.meta.url)));
for(const lang of ['jp','cn']){
  const original=new Uint8Array(gunzipSync(await readFile(new URL(`disks/3-${lang}.hdi.gz`,root))));
  const originalFat=new Fat12(original),patched=await helper.install(original.slice()),fat=new Fat12(patched);
  const main=originalFat.find('YUMEZIKU/MAIN.EXE');
  const allowed=new Uint8Array(original.length);
  allowed.fill(1,fat.fat,fat.fat+fat.fatCount*fat.fatSize);
  allowed.fill(1,main,main+32);
  for(const cluster of fat.chain(fat.view.getUint16(main+26,true)))allowed.fill(1,fat.offset(cluster),fat.offset(cluster)+fat.clusterSize);
  for(let at=0;at<original.length;at++)if(original[at]!==patched[at])assert(allowed[at],`Unexpected disk edit at ${at}`);
  for(const {path} of inventory[lang].filter(({path})=>/^[\x00-\x7f]+$/.test(path)))if(path!=='YUMEZIKU/MAIN.EXE')assert.deepEqual(fat.read(fat.find(path)),originalFat.read(originalFat.find(path)),path);
  const restored=new Fat12(helper.exportDisk(patched));
  for(const {path} of inventory[lang].filter(({path})=>/^[\x00-\x7f]+$/.test(path)))assert.deepEqual(restored.read(restored.find(path)),originalFat.read(originalFat.find(path)),path);
  assert.equal(await sha256(restored.read(main)),helper.bridge.meta.originalSha256);
  assert.notEqual(await sha256(fat.read(main)),helper.bridge.meta.originalSha256,'Export must not modify the running disk');
  await helper.install(restored.data.slice());
  console.log(`PASS ${lang}: only MAIN/FAT allocation changed; all boot/config/score/music files preserved; export restores original files and reimports`);
}
