'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'audio', 'bgm');

const TRACKS = [
  ['lobby-chill.mp3',          'https://cdn.pixabay.com/audio/2023/05/16/audio_5e2e2a678d.mp3'],
  ['lobby-upbeat.mp3',         'https://cdn.pixabay.com/audio/2022/11/22/audio_9227e3fdef.mp3'],
  ['question-action.mp3',      'https://cdn.pixabay.com/audio/2023/03/28/audio_c0de7ec31e.mp3'],
  ['question-electronic.mp3',  'https://cdn.pixabay.com/audio/2022/10/30/audio_a7eb30cb98.mp3'],
];

function download(url, dest, redirects) {
  redirects = redirects || 0;
  if (redirects > 5) { console.error('Too many redirects for', dest); return; }
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        resolve(download(res.headers.location, dest, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(fs.statSync(dest).size));
      });
      file.on('error', (e) => {
        fs.unlink(dest, () => {});
        reject(e);
      });
    }).on('error', reject);
  });
}

(async () => {
  for (const [name, url] of TRACKS) {
    const dest = path.join(OUT_DIR, name);
    process.stdout.write('Fetching ' + name + '... ');
    try {
      const size = await download(url, dest);
      console.log('OK (' + size + ' bytes)');
    } catch (e) {
      console.log('FAILED: ' + e.message);
    }
  }
})();
