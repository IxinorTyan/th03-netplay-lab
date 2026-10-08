// File-only packaging audit. Does not boot DOS, NP21 or a browser.
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {Fat12} from '../web/disk.js';
import {decodeScoreSection, unlockScores, unlockDiskScores} from '../web/scores.js';

const root = new URL('../web/', import.meta.url);
const read = name => readFile(new URL(name, root));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const require = (condition, message) => { if (!condition) throw Error(message); };
const lockstep = JSON.parse(await read('lockstep-runtime.json'));
for (const [name, sha] of Object.entries(lockstep.files)) {
  require(hash(await read(name)) === sha,
    'Lockstep resource hash mismatch: ' + name + '; regenerate lockstep-runtime.json before distributing web/');
}
console.log(`PASS: ${Object.keys(lockstep.files).length} lockstep resource fingerprints`);
const manifest = JSON.parse(await read('disks/manifest.json'));
const patch = JSON.parse(await read('native-patch.json'));
const exe = await read(patch.url);
require(exe.length === patch.bytes && hash(exe) === patch.sha256, 'Patched executable hash mismatch');
const launcher = await read(patch.startup.launcher.url);
const music = await read(patch.startup.music.url);
require(hash(music) === patch.startup.music.sha256 && music.length === patch.startup.music.bytes, 'Music bridge hash mismatch');
require(launcher.length === patch.startup.launcher.bytes && hash(launcher) === patch.startup.launcher.sha256, 'Launcher hash mismatch');
const runtime = JSON.parse(await read('vendor/np2/SHA256SUMS.json'));
for (const [name, sha] of Object.entries(runtime)) require(hash(await read('vendor/np2/' + name)) === sha, 'Runtime hash mismatch: ' + name);

for (const lang of ['jp', 'cn']) {
  const meta = manifest.games['3-' + lang], original = gunzipSync(await read(meta.url));
  require(original.length === meta.size && hash(original) === meta.sha256, 'Original disk hash mismatch: ' + lang);
  const data = new Uint8Array(original), fat = new Fat12(data), entry = fat.find('YUMEZIKU/MAIN.EXE');
  const scoreEntry = fat.find('YUMEZIKU/YUME.NEM'), originalScores = fat.read(scoreEntry);
  unlockDiskScores(fat);
  const unlockedScores = fat.read(scoreEntry);
  for (let rank = 0; rank < 4; rank++) {
    const start = rank * 206;
    const before = decodeScoreSection(originalScores.subarray(start, start + 206));
    const after = decodeScoreSection(unlockedScores.subarray(start, start + 206));
    require(after[82] === 99, 'Character unlock flag missing: ' + lang);
    // All decrypted bytes except the clear flag and its checksum stay intact.
    after[0] = before[0]; after[1] = before[1]; after[82] = before[82];
    require(Buffer.from(after).equals(before), 'Unlock changed leaderboard data: ' + lang);
  }
  require(Buffer.from(unlockScores(unlockedScores)).equals(unlockedScores), 'Unlock is not idempotent: ' + lang);
  const damaged = originalScores.slice(); damaged[0] ^= 1;
  let rejected = false;
  try { unlockScores(damaged); } catch { rejected = true; }
  require(rejected, 'Corrupted score checksum was not rejected');
  require(hash(fat.read(entry)) === patch.originalSha256, 'Original MAIN.EXE hash mismatch: ' + lang);
  const old = fat.chain(fat.view.getUint16(entry + 26, true));
  fat.replace(entry, exe);
  require(hash(fat.read(entry)) === patch.sha256, 'Packaged MAIN.EXE mismatch: ' + lang);
  const chain = fat.chain(fat.view.getUint16(entry + 26, true));
  const batchMeta = patch.startup.batches[lang], batch = await read(batchMeta.url);
  const batchEntry = fat.find('YUMEZIKU/GAME.BAT');
  const oldBatch = fat.chain(fat.view.getUint16(batchEntry + 26, true));
  const originalBatch = Buffer.from(fat.read(batchEntry));
  require(hash(originalBatch) === batchMeta.originalSha256 && hash(batch) === batchMeta.sha256
    && batch.length === batchMeta.bytes, 'Startup batch hashes mismatch: ' + lang);
  const batchText = batch.toString('latin1');
  require((batchText.match(/webstart\r\nif errorlevel 1 goto fin\r\nop\b/gi) || []).length === 6, 'Sound branch missing launcher: ' + lang);
  const normalizedOriginal = originalBatch.toString('latin1').replace(/\r\r\n/g, '\r\n');
  require((normalizedOriginal.match(/^zun -3\r?$/gmi) || []).length === 6
    && !/^zun -3\s*$/gmi.test(batchText), 'ZUN Soft startup animation remains: ' + lang);
  require(batchText.replace(/webmusic\r\nif errorlevel 1 goto fin\r\n/gi, '').replace(/webmusic \/R\r\n/gi, '').replace(/webstart\r\nif errorlevel 1 goto fin\r\n/gi, '') === normalizedOriginal.replace(/^zun -3\r\n/gmi, ''), 'Original sound-driver setup changed: ' + lang);
  fat.replace(batchEntry, batch);
  const launcherEntry = fat.put('YUMEZIKU/WEBSTART.COM', launcher);
  const musicEntry = fat.put('YUMEZIKU/WEBMUSIC.COM', music);
  const musicChain = fat.chain(fat.view.getUint16(musicEntry + 26, true));
  const batchChain = fat.chain(fat.view.getUint16(batchEntry + 26, true));
  const launcherChain = fat.chain(fat.view.getUint16(launcherEntry + 26, true));
  require(hash(fat.read(batchEntry)) === batchMeta.sha256 && hash(fat.read(launcherEntry)) === patch.startup.launcher.sha256, 'Startup files not installed: ' + lang);
  const cfgEntry = fat.find('YUMEZIKU/YUME.CFG');
  require(fat.offset(fat.view.getUint16(cfgEntry + 26, true)) === meta.keyboardConfig.offset, 'CFG offset mismatch');
  for (let rank = 0; rank <= 3; rank++) {
    data[meta.keyboardConfig.offset + 0] = 1;
    data[meta.keyboardConfig.offset + 1] = 0;
    data[meta.keyboardConfig.offset + 2] = rank;
    const cfg = fat.read(cfgEntry);
    require(cfg[0] === 1 && cfg[1] === 0 && cfg[2] === rank && Buffer.from(cfg.subarray(3)).equals(original.subarray(meta.keyboardConfig.offset + 3, meta.keyboardConfig.offset + 8)), 'Difficulty/keyboard configuration mismatch');
  }
  for (let copy = 1; copy < fat.fatCount; copy++) {
    require(Buffer.from(data.subarray(fat.fat, fat.fat + fat.fatSize)).equals(
      Buffer.from(data.subarray(fat.fat + copy * fat.fatSize, fat.fat + (copy + 1) * fat.fatSize))), 'FAT copies diverged: ' + lang);
  }
  const once = data.slice();
  fat.replace(entry, exe);
  fat.replace(batchEntry, batch);
  fat.put('YUMEZIKU/WEBSTART.COM', launcher);
  fat.put('YUMEZIKU/WEBMUSIC.COM', music);
  unlockDiskScores(fat);
  require(Buffer.from(once).equals(Buffer.from(data)), 'Repeated replacement changes disk: ' + lang);
  // Normalize only the executable's storage, directory fields and FAT tables.
  // Every remaining byte must still match the original disk.
  const preserved = data.slice();
  for (const c of new Set([...old, ...chain, ...oldBatch, ...batchChain, ...launcherChain, ...musicChain])) {
    const at = fat.offset(c);
    preserved.set(original.subarray(at, at + fat.clusterSize), at);
  }
  preserved.set(original.subarray(fat.fat, fat.root), fat.fat);
  preserved.set(original.subarray(entry + 26, entry + 32), entry + 26);
  preserved.set(original.subarray(batchEntry + 26, batchEntry + 32), batchEntry + 26);
  preserved.set(original.subarray(launcherEntry, launcherEntry + 32), launcherEntry);
  preserved.set(original.subarray(musicEntry, musicEntry + 32), musicEntry);
  preserved.set(original.subarray(meta.keyboardConfig.offset, meta.keyboardConfig.offset + 8), meta.keyboardConfig.offset);
  const scoreChain = fat.chain(fat.view.getUint16(scoreEntry + 26, true));
  scoreChain.forEach((cluster, i) => {
    const at = fat.offset(cluster), length = Math.min(fat.clusterSize, originalScores.length - i * fat.clusterSize);
    if (length > 0) preserved.set(original.subarray(at, at + length), at);
  });
  require(Buffer.from(preserved).equals(original), 'Unexpected disk changes: ' + lang);
  console.log(`${lang}: original hash, executable replacement, ${old.length}->${chain.length} clusters, FAT copies and other disk bytes verified`);
  console.log(`${lang}: added launcher, six sound branches without ZUN Soft animation, four ranks, repeated mounting and saved data preservation verified`);
  console.log(`${lang}: all four clear flags unlocked, native checksums valid, leaderboard bytes preserved, corrupted scores rejected`);
}

const hsize = exe.readUInt16LE(8) * 16, originalHeader = hsize;
const sourceDisk = gunzipSync(await read(manifest.games['3-jp'].url));
const sourceFat = new Fat12(sourceDisk), source = Buffer.from(sourceFat.read(sourceFat.find('YUMEZIKU/MAIN.EXE')));
const insert = patch.insertImageOffset, gap = patch.insertSize;
const tail = Buffer.from(patch.overlapTail.bytes, 'hex');
require(patch.overlapTail.imageOffset === insert && exe.subarray(hsize + insert, hsize + insert + tail.length).equals(tail), 'Shared paragraph tail corrupted');
require(source.subarray(hsize + insert, hsize + insert + tail.length).equals(tail), 'Original shared tail mismatch');
require(exe.subarray(hsize + insert - 1, hsize + insert + 8).equals(source.subarray(hsize + insert - 1, hsize + insert + 8)), 'Original loop CMP/JL/epilogue split by payload');
const table = source.readUInt16LE(24), count = source.readUInt16LE(6);
require(source.readUInt16LE(8) * 16 === originalHeader, 'Header size changed');
for (let i = 0; i < count; i++) {
  const at = table + i * 4, location = source.readUInt16LE(at + 2) * 16 + source.readUInt16LE(at);
  const target = source.readUInt16LE(hsize + location), moved = location + (location >= insert ? gap : 0);
  const patchedLocation = exe.readUInt16LE(at + 2) * 16 + exe.readUInt16LE(at);
  require(patchedLocation === moved && exe.readUInt16LE(hsize + moved) === target + (target * 16 >= insert ? gap / 16 : 0), 'MZ relocation mismatch');
}
for (const hook of patch.hooks) {
  const at = hsize + hook.imageOffset;
  require(source.subarray(at, at + 3).equals(Buffer.from(hook.original, 'hex')), 'Original hook anchor mismatch');
  require(exe[at] === 0xe8 && ((hook.imageOffset + 3 + exe.readInt16LE(at + 1) - patch.codeSegment * 16) & 0xffff) === hook.target, 'Native hook mismatch');
}
require(patch.fields.focus === 26 && patch.fields.points === 27 && patch.fields.generation === 28
  && patch.mailboxSize === 44 && patch.fields.alwaysPoint === 31 && patch.fields.touch === 32,
  'Touch fields changed the existing pause mailbox');
const mailboxAt = hsize + patch.codeSegment * 16 + patch.mailboxCsOffset;
require(exe[mailboxAt + patch.fields.focus] === 0 && exe[mailboxAt + patch.fields.points] === 3,
  'Focus must start released, with both point options available');
require(patch.hooks.some(hook => hook.imageOffset === 0xdaca && hook.original === 'e851fc')
  && patch.hooks.some(hook => hook.imageOffset === 0x990b && hook.original === 'e80a46'), 'Focus movement/render hook missing');
// Remove the inserted payload and normalize only declared mutations. This
// catches accidental damage anywhere in MAIN, including knockback and CPUs.
const normalized = Buffer.concat([exe.subarray(hsize, hsize + insert), exe.subarray(hsize + insert + gap)]);
for (let i = 0; i < count; i++) {
  const at = table + i * 4, location = source.readUInt16LE(at + 2) * 16 + source.readUInt16LE(at);
  source.copy(normalized, location, hsize + location, hsize + location + 2);
}
for (const hook of patch.hooks) Buffer.from(hook.original, 'hex').copy(normalized, hook.imageOffset);
Buffer.from(patch.disabledNativePause.original, 'hex').copy(normalized, patch.disabledNativePause.imageOffset);
require(normalized.equals(source.subarray(hsize)), 'Undeclared native code/data modification');
require(exe.subarray(hsize + patch.disabledNativePause.imageOffset, hsize + patch.disabledNativePause.imageOffset + 3).equals(Buffer.from([0x90, 0x90, 0x90])), 'Native pause remains enabled');
require(exe.subarray(hsize + patch.codeSegment * 16 + patch.mailboxCsOffset, hsize + patch.codeSegment * 16 + patch.mailboxCsOffset + patch.signature.length).toString() === patch.signature, 'Mailbox layout mismatch');
for (const [start, end] of [[0x9917, 0x9973], [0xe3f2, 0xe737]]) {
  require(exe.subarray(hsize + start, hsize + end).equals(source.subarray(hsize + start, hsize + end)), 'Native deciding-round tally/exit changed');
}
console.log(`Native executable: ${count} relocations, hook targets, disabled pause, mailbox and overlapping code tail verified`);
console.log('Native deciding-round tally, score bonus and score-transfer exit preserved');
console.log('Focus mailbox defaults, normal-movement/render anchors and all other native bytes preserved');
