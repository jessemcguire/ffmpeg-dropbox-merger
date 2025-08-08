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
function normalizeDropboxUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'www.dropbox.com' || u.hostname === 'dropbox.com') {
      u.hostname = 'dl.dropboxusercontent.com';
      u.search = '';
    }
    return u.toString();
  } catch {
    return url;
  }
}

function isAllowedDropboxUrl(url) {
  try {
    const u = new URL(url);
    return ['dl.dropboxusercontent.com', 'www.dropbox.com', 'dropbox.com'].includes(u.hostname);
  } catch {
    return false;
  }
}

async function downloadToTemp(url, extFallback = '.bin') {
  const id = randomUUID();
  const ext = path.extname(new URL(url).pathname) || extFallback;
  const filePath = path.join('/tmp', `${id}${ext}`);
  const resp = await axios.get(url, { responseType: 'stream', maxRedirects: 5 });
  await pipeline(resp.data, fs.createWriteStream(filePath));
  return filePath;
}

function mergeAV({ videoPath, audioPath, outPath }) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions(['-c:v copy', '-c:a aac', '-shortest'])
      .on('error', reject)
      .on('end', () => resolve(outPath))
      .save(outPath);
  });
}

async function safeUnlink(p) {
  try { await fs.promises.unlink(p); } catch {}
}

// --- Dropbox helpers ---
async function dropboxUpload(filePath, dropboxPath) {
  if (!DROPBOX_TOKEN) throw new Error('DROPBOX_ACCESS_TOKEN is not set');
  const content = await fs.promises.readFile(filePath);
  const targetPath = dropboxPath || `/merged-${Date.now()}.mp4`;

  await axios.post(
    'https://content.dropboxapi.com/2/files/upload',
    content,
    {
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: targetPath,
          mode: 'overwrite',
          autorename: false,
          mute: false,
          strict_conflict: false
        })
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }
  );

  return targetPath;
}

async function dropboxGetTemporaryLink(pathLower) {
  if (!DROPBOX_TOKEN) throw new Error('DROPBOX_ACCESS_TOKEN is not set');
  const { data } = await axios.post(
    'https://api.dropboxapi.com/2/files/get_temporary_link',
    { path: pathLower },
    { headers: { Authorization: `Bearer ${DROPBOX_TOKEN}`, 'Content-Type': 'application/json' } }
  );
  return data.link;
}

async function dropboxCreateSharedLink(pathLower) {
  if (!DROPBOX_TOKEN) throw new Error('DROPBOX_ACCESS_TOKEN is not set');
  try {
    const { data } = await axios.post(
      'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings',
      { path: pathLower, settings: { requested_visibility: 'public' } },
      { headers: { Authorization: `Bearer ${DROPBOX_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return data.url;
  } catch (err) {
    if (err.response && err.response.data && err.response.data.error_summary && err.response.data.error_summary.includes('shared_link_already_exists')) {
      const { data } = await axios.post(
        'https://api.dropboxapi.com/2/sharing/list_shared_links',
        { path: pathLower, direct_only: true },
        { headers: { Authorization: `Bearer ${DROPBOX_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      if (data.links && data.links.length) return data.links[0].url;
    }
    throw err;
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
    shareType = 'temporary'
  } = req.body || {};

  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'Missing videoUrl or audioUrl' });
  }

  const vUrl = normalizeDropboxUrl(videoUrl);
  const aUrl = normalizeDropboxUrl(audioUrl);

  if (!isAllowedDropboxUrl(vUrl) || !isAllowedDropboxUrl(aUrl)) {
    return res.status(400).json({ error: 'Only Dropbox URLs are allowed.' });
  }

  if (uploadToDropbox && !DROPBOX_TOKEN) {
    return res.status(400).json({ error: 'uploadToDropbox requested but DROPBOX_ACCESS_TOKEN is not set.' });
  }

  let videoPath, audioPath, outPath;
  try {
    videoPath = await downloadToTemp(vUrl, '.mp4');
    audioPath = await downloadToTemp(aUrl, '.m4a');
    outPath = path.join('/tmp', `${randomUUID()}.mp4`);

    await mergeAV({ videoPath, audioPath, outPath });

    if (uploadToDropbox) {
      const remotePath = await dropboxUpload(outPath, dropboxPath);
      const link = shareType === 'shared'
        ? await dropboxCreateSharedLink(remotePath)
        : await dropboxGetTemporaryLink(remotePath);

      await safeUnlink(videoPath);
      await safeUnlink(audioPath);
      await safeUnlink(outPath);

      return res.json({
        status: 'uploaded',
        path: remotePath,
        url: link,
        linkType: shareType
      });
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filename)}"`);
    const read = fs.createReadStream(outPath);
    read.on('close', async () => {
      await safeUnlink(videoPath);
      await safeUnlink(audioPath);
      await safeUnlink(outPath);
    });
    read.pipe(res);
  } catch (err) {
    await safeUnlink(videoPath);
    await safeUnlink(audioPath);
    await safeUnlink(outPath);
    console.error(err);
    res.status(500).json({ error: 'Merge failed', details: String(err.message || err) });
  }
});

app.get('/', (_req, res) => res.send('OK'));
app.listen(port, () => console.log(`Server running on ${port}`));
