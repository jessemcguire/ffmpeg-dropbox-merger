require('dotenv').config();

const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { randomUUID } = require('crypto');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 3000;
const DROPBOX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;

app.use(express.json({ limit: '2mb' }));

// --- Helpers ---
function log(step, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, ...extra }));
}

async function downloadToTemp(url, extFallback = '.bin') {
  const id = randomUUID();
  const ext = (() => { try { return path.extname(new URL(url).pathname) || extFallback; } catch { return extFallback; }})();
  const filePath = path.join('/tmp', `${id}${ext}`);
  log('download.http.start', { url });
  const resp = await axios.get(url, { responseType: 'stream', maxRedirects: 5, validateStatus: s => s < 400 });
  await pipeline(resp.data, fs.createWriteStream(filePath));
  log('download.http.ok', { filePath });
  return filePath;
}

async function downloadSharedLinkToTemp(sharedLink, extFallback = '.bin') {
  if (!DROPBOX_TOKEN) throw new Error('DROPBOX_ACCESS_TOKEN is not set');
  const ext = (() => { try { return path.extname(new URL(sharedLink).pathname) || extFallback; } catch { return extFallback; }})();
  const out = path.join('/tmp', `${randomUUID()}${ext}`);

  log('download.dropbox.start', { url: sharedLink });
  const resp = await axios.post(
    'https://content.dropboxapi.com/2/sharing/get_shared_link_file',
    null,
    {
      responseType: 'stream',
      headers: {
        Authorization: `Bearer ${DROPBOX_TOKEN}`,
        'Dropbox-API-Arg': JSON.stringify({ url: sharedLink.replace('?dl=0', '?dl=1') })
      },
      // Dropbox returns non-2xx for some cases; let it throw so we see it
      validateStatus: s => s < 400
    }
  );
  await pipeline(resp.data, fs.createWriteStream(out));
  log('download.dropbox.ok', { filePath: out });
  return out;
}

function isDropboxLink(url) {
  return /(^https?:\/\/)?(www\.)?dropbox\.com|dl\.dropboxusercontent\.com/i.test(url || '');
}

function mergeAV({ videoPath, audioPath, outPath, forceReencode = false }) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(videoPath).input(audioPath);
    const opts = forceReencode
      ? ['-c:v libx264', '-c:a aac', '-movflags +faststart', '-shortest']
      : ['-c:v copy', '-c:a aac', '-shortest'];

    log('ffmpeg.start', { videoPath, audioPath, outPath, forceReencode });
    cmd.outputOptions(opts)
      .on('error', (err) => { log('ffmpeg.error', { err: String(err) }); reject(err); })
      .on('end', () => { log('ffmpeg.ok', { outPath }); resolve(outPath); })
      .save(outPath);
  });
}

async function safeUnlink(p) { try { await fs.promises.unlink(p); } catch {} }

function sanitizeDropboxUrl(u) {
  try {
    const url = new URL(u);
    if (/dropbox\.com/i.test(url.hostname)) {
      url.searchParams.delete('st');         // Drop session-ish param
      url.searchParams.set('dl', '1');       // Force direct download
    }
    return url.toString();
  } catch {
    return u;
  }
}

async function downloadDropboxSmart(sharedLink, extFallback) {
  const clean = sanitizeDropboxUrl(sharedLink);
  try {
    return await downloadSharedLinkToTemp(clean, extFallback);
  } catch (e) {
    const httpUrl = clean.replace('www.dropbox.com', 'dl.dropboxusercontent.com');
    return await downloadToTemp(httpUrl, extFallback);
  }
}

// --- Route ---
app.post('/merge', async (req, res) => {
  const {
    videoUrl,
    audioUrl,
    filename = 'merged.mp4',
    uploadToDropbox = false,
    dropboxPath,
    shareType = 'temporary', // 'temporary' | 'shared'
    forceReencode = false
  } = req.body || {};

  log('request', { videoUrl, audioUrl, uploadToDropbox, shareType, forceReencode });

  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'Missing videoUrl or audioUrl' });
  }
  if (uploadToDropbox && !DROPBOX_TOKEN) {
    return res.status(400).json({ error: 'uploadToDropbox requested but DROPBOX_ACCESS_TOKEN is not set.' });
  }

  let videoPath, audioPath, outPath;
  try {
    // Prefer Dropbox API for Dropbox links (avoids 403s)
    videoPath = isDropboxLink(videoUrl)
  ? await downloadDropboxSmart(videoUrl, '.mp4')
  : await downloadToTemp(videoUrl, '.mp4');

audioPath = isDropboxLink(audioUrl)
  ? await downloadDropboxSmart(audioUrl, '.m4a')
  : await downloadToTemp(audioUrl, '.m4a');

    outPath = path.join('/tmp', `${randomUUID()}.mp4`);

    await mergeAV({ videoPath, audioPath, outPath, forceReencode });

    if (uploadToDropbox) {
      if (!DROPBOX_TOKEN) throw new Error('DROPBOX_ACCESS_TOKEN is not set');
      log('dropbox.upload.start', { dropboxPath });
      const content = await fs.promises.readFile(outPath);
      const targetPath = dropboxPath || `/merged-${Date.now()}.mp4`;

      await axios.post(
        'https://content.dropboxapi.com/2/files/upload',
        content,
        {
          headers: {
            Authorization: `Bearer ${DROPBOX_TOKEN}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({
              path: targetPath, mode: 'overwrite', autorename: false, mute: false, strict_conflict: false
            })
          },
          maxBodyLength: Infinity, maxContentLength: Infinity, validateStatus: s => s < 400
        }
      );
      log('dropbox.upload.ok', { targetPath });

      let url;
      if (shareType === 'shared') {
        try {
          const { data } = await axios.post(
            'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings',
            { path: targetPath, settings: { requested_visibility: 'public' } },
            { headers: { Authorization: `Bearer ${DROPBOX_TOKEN}`, 'Content-Type': 'application/json' }, validateStatus: s => s < 500 }
          );
          url = data.url;
        } catch (err) {
          if (err.response?.data?.error_summary?.includes('shared_link_already_exists')) {
            const { data } = await axios.post(
              'https://api.dropboxapi.com/2/sharing/list_shared_links',
              { path: targetPath, direct_only: true },
              { headers: { Authorization: `Bearer ${DROPBOX_TOKEN}`, 'Content-Type': 'application/json' } }
            );
            url = data.links?.[0]?.url;
          } else {
            throw err;
          }
        }
      } else {
        const { data } = await axios.post(
          'https://api.dropboxapi.com/2/files/get_temporary_link',
          { path: targetPath },
          { headers: { Authorization: `Bearer ${DROPBOX_TOKEN}`, 'Content-Type': 'application/json' } }
        );
        url = data.link;
      }

      await safeUnlink(videoPath); await safeUnlink(audioPath); await safeUnlink(outPath);
      log('done.uploaded', { urlType: shareType });

      return res.json({ status: 'uploaded', path: targetPath, url, linkType: shareType });
    }

    // Stream back
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filename)}"`);
    const read = fs.createReadStream(outPath);
    read.on('close', async () => {
      await safeUnlink(videoPath); await safeUnlink(audioPath); await safeUnlink(outPath);
      log('done.streamed');
    });
    read.pipe(res);
  } catch (err) {
    await safeUnlink(videoPath); await safeUnlink(audioPath); await safeUnlink(outPath);
    log('error', { err: String(err) });
    res.status(500).json({ error: 'Merge failed', details: String(err?.message || err) });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (_req, res) => res.send('OK'));
app.listen(port, () => console.log(`Server running on ${port}`));

function sanitizeDropboxUrl(u) {
  try {
    const url = new URL(u);
    if (/dropbox\.com/i.test(url.hostname)) {
      url.searchParams.delete('st');         // ← drop session-ish param
      url.searchParams.set('dl', '1');       // ← force direct download
    }
    return url.toString();
  } catch {
    return u;
  }
}



