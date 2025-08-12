// server.js
import express from "express";
import morgan from "morgan";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { Dropbox } from "dropbox";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

ffmpeg.setFfmpegPath(ffmpegPath.path);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

const PORT = process.env.PORT || 3000;
const TEMP_DIR = "/tmp";

/* -------------------- Security (shared secret) -------------------- */
const APP_SECRET = process.env.APP_SECRET || null;
function requireSecret(req, res, next) {
  if (!APP_SECRET) return next(); // allow if not configured
  if (req.get("X-App-Secret") === APP_SECRET) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

/* -------------------- Dropbox (refresh -> access) -------------------- */
const DBX_REFRESH = process.env.DROPBOX_REFRESH_TOKEN;
const DBX_APP_KEY = process.env.DROPBOX_APP_KEY;
const DBX_APP_SECRET = process.env.DROPBOX_APP_SECRET;

if (!DBX_REFRESH || !DBX_APP_KEY || !DBX_APP_SECRET) {
  console.warn("Missing Dropbox env vars. Set DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, DROPBOX_APP_SECRET.");
}

function log(step, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, ...extra }));
}

let dbxTokenCache = { accessToken: null, expiresAt: 0 };
async function getAccessToken() {
  const now = Date.now();
  if (dbxTokenCache.accessToken && now < dbxTokenCache.expiresAt - 60_000) {
    return dbxTokenCache.accessToken;
  }
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: DBX_REFRESH });
  try {
    const { data } = await axios.post(
      "https://api.dropboxapi.com/oauth2/token",
      body.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        auth: { username: DBX_APP_KEY, password: DBX_APP_SECRET },
        timeout: 15000
      }
    );
    dbxTokenCache.accessToken = data.access_token;
    dbxTokenCache.expiresAt = Date.now() + (data.expires_in || 14400) * 1000;
    log("dropbox.token.refreshed", { expires_in: data.expires_in });
    return dbxTokenCache.accessToken;
  } catch (err) {
    console.error("dropbox.token.error", { status: err.response?.status, data: err.response?.data, message: err.message });
    throw err;
  }
}
async function getDropboxClient() {
  const accessToken = await getAccessToken();
  return new Dropbox({ accessToken, fetch: fetch });
}

/* -------------------- TikTok (optional) -------------------- */
const TT_APP_KEY = process.env.TIKTOK_APP_KEY;
const TT_APP_SECRET = process.env.TIKTOK_APP_SECRET;
const TT_REFRESH = process.env.TIKTOK_REFRESH_TOKEN;

if ((TT_APP_KEY || TT_APP_SECRET || TT_REFRESH) && (!TT_APP_KEY || !TT_APP_SECRET || !TT_REFRESH)) {
  console.warn("TikTok envs partially set. Need TIKTOK_APP_KEY, TIKTOK_APP_SECRET, TIKTOK_REFRESH_TOKEN.");
}

async function getTtAccessToken() {
  if (!TT_APP_KEY || !TT_APP_SECRET || !TT_REFRESH) throw new Error("TikTok env not configured");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: TT_REFRESH });
  const { data } = await axios.post(
    "https://open.tiktokapis.com/v2/oauth/token/",
    body.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, auth: { username: TT_APP_KEY, password: TT_APP_SECRET }, timeout: 15000 }
  );
  return data.access_token;
}
async function ttInitDirectPost(accessToken, { title, sizeBytes, privacy = "SELF_ONLY" }) {
  const { data } = await axios.post(
    "https://open.tiktokapis.com/v2/post/publish/video/init/",
    {
      post_info: { title, privacy_level: privacy },
      source_info: { source: "FILE_UPLOAD", video_size: sizeBytes, chunk_size: sizeBytes, total_chunk_count: 1 }
    },
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000 }
  );
  return data?.data; // { publish_id, upload_url }
}
async function ttUpload(uploadUrl, localPath) {
  const stat = await fs.promises.stat(localPath);
  await axios.put(uploadUrl, fs.createReadStream(localPath), {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": stat.size,
      "Content-Range": `bytes 0-${stat.size - 1}/${stat.size}`
    },
    maxBodyLength: Infinity,
    timeout: 10 * 60 * 1000
  });
}
async function ttGetPostStatus(accessToken, publishId) {
  const { data } = await axios.get(
    "https://open.tiktokapis.com/v2/post/publish/status/",
    { params: { publish_id: publishId }, headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }
  );
  return data;
}

/* -------------------- File helpers -------------------- */
function inferExt(url, fallback = ".bin") {
  try { const ext = path.extname(new URL(url).pathname); if (ext) return ext; } catch {}
  return fallback;
}
function tmpPath(ext = ".bin") { return path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${ext}`); }

async function downloadViaDropbox(input, fallbackExt = ".bin") {
  const dbx = await getDropboxClient();
  // Shared link
  if (/^https?:\/\/.*dropbox\.com/i.test(input)) {
    const { result } = await dbx.sharingGetSharedLinkFile({ url: input });
    const name = result?.name || `file${fallbackExt}`;
    const ext = path.extname(name) || inferExt(input, fallbackExt);
    const out = tmpPath(ext);
    const buf = Buffer.from(result.fileBinary);
    await fs.promises.writeFile(out, buf);
    return out;
  }
  // Dropbox path
  if (input.startsWith("/")) {
    const { result } = await dbx.filesGetTemporaryLink({ path: input });
    const name = result.metadata?.name || `file${fallbackExt}`;
    const ext = path.extname(name) || fallbackExt;
    const out = tmpPath(ext);
    const resp = await axios.get(result.link, { responseType: "stream", maxRedirects: 5 });
    await pipeline(resp.data, fs.createWriteStream(out));
    return out;
  }
  throw new Error("Unsupported Dropbox input. Provide a shared link or a Dropbox path like /Folder/file.mp4");
}
async function downloadToFile(urlOrPath, fallbackExt = ".bin") {
  if (/^https?:\/\/.*dropbox\.com/i.test(urlOrPath) || urlOrPath.startsWith("/")) {
    return downloadViaDropbox(urlOrPath, fallbackExt);
  }
  const ext = inferExt(urlOrPath, fallbackExt);
  const out = tmpPath(ext);
  const resp = await axios.get(urlOrPath, { responseType: "stream", maxRedirects: 5, headers: { "User-Agent": "curl/8" } });
  await pipeline(resp.data, fs.createWriteStream(out));
  return out;
}

/* -------------------- FFmpeg merge -------------------- */
function mergeAV(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    const outPath = tmpPath(".mp4");
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map 0:v:0",
        "-map 1:a:0",
        "-c:v copy",     // change to libx264 if container/codec mismatch
        "-c:a aac",
        "-b:a 192k",
        "-shortest"
      ])
      .on("error", reject)
      .on("end", () => resolve(outPath))
      .save(outPath);
  });
}

async function uploadToDropbox(localPath, dropboxPath) {
  const dbx = await getDropboxClient();
  const stats = await fs.promises.stat(localPath);
  if (stats.size > 150 * 1024 * 1024) {
    throw new Error("File too large for simple upload (>150MB).");
  }
  const file = await fs.promises.readFile(localPath);
  const res = await dbx.filesUpload({ path: dropboxPath, contents: file, mode: { ".tag": "add" }, mute: true });
  return res;
}

/* -------------------- Routes -------------------- */
app.get("/", (_req, res) => res.send("OK"));

// Single, secured wake route (pre-warms tokens)
app.get("/wake", requireSecret, async (_req, res) => {
  try {
    const tasks = [getAccessToken()];
    if (TT_APP_KEY && TT_APP_SECRET && TT_REFRESH) tasks.push(getTtAccessToken());
    await Promise.allSettled(tasks);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Merge route (supports fast JSON via noStream)
app.post("/merge", requireSecret, async (req, res) => {
  const { videoUrl, audioUrl, dropboxPath, noStream } = req.body || {};
  if (!videoUrl || !audioUrl) return res.status(400).json({ error: "videoUrl and audioUrl are required" });

  let vPath, aPath, mPath;
  try {
    log("download.start", { videoUrl, audioUrl });
    vPath = await downloadToFile(videoUrl, ".mp4");
    aPath = await downloadToFile(audioUrl, ".mp3");
    const vs = await fs.promises.stat(vPath);
    const as = await fs.promises.stat(aPath);
    log("download.sizes", { videoBytes: vs.size, audioBytes: as.size });

    log("ffmpeg.merge.start");
    mPath = await mergeAV(vPath, aPath);
    log("ffmpeg.merge.done", { mPath });

    let savedPath = null;
    if (dropboxPath) {
      savedPath = dropboxPath.endsWith(".mp4") ? dropboxPath : `${dropboxPath}/merged-${Date.now()}.mp4`;
      log("dropbox.upload.start", { savedPath });
      const up = await uploadToDropbox(mPath, savedPath);
      log("dropbox.upload.done", { id: up?.result?.id || up?.id });
      res.setHeader("X-Dropbox-Path", savedPath);
    }

    if (noStream) {
      await Promise.allSettled([
        vPath && fs.promises.unlink(vPath).catch(() => {}),
        aPath && fs.promises.unlink(aPath).catch(() => {}),
        mPath && fs.promises.unlink(mPath).catch(() => {})
      ]);
      return res.status(200).json({ ok: true, dropboxPath: savedPath });
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `inline; filename="merged.mp4"`);
    const stream = fs.createReadStream(mPath);
    stream.on("close", async () => {
      try {
        if (vPath) await fs.promises.unlink(vPath).catch(() => {});
        if (aPath) await fs.promises.unlink(aPath).catch(() => {});
        if (mPath) await fs.promises.unlink(mPath).catch(() => {});
        log("cleanup.done");
      } catch {}
    });
    stream.pipe(res);
  } catch (err) {
    log("merge.error", { message: err.message, stack: err.stack });
    try {
      if (vPath) await fs.promises.unlink(vPath).catch(() => {});
      if (aPath) await fs.promises.unlink(aPath).catch(() => {});
      if (mPath) await fs.promises.unlink(mPath).catch(() => {});
    } catch {}
    res.status(500).json({ error: "Merge failed", details: err.message });
  }
});

/* ---- TikTok endpoints (optional) ---- */

// In-memory idempotency for /tiktok/post
const idem = new Map(); // key -> { publish_id, at }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of idem) if (now - v.at > 6 * 60 * 60 * 1000) idem.delete(k);
}, 30 * 60 * 1000);

// Post merged file to TikTok
app.post("/tiktok/post", requireSecret, async (req, res) => {
  const { dropboxPath, caption, privacy = "SELF_ONLY" } = req.body || {};
  const idemKey = req.get("Idempotency-Key");
  if (!dropboxPath || !caption) return res.status(400).json({ error: "dropboxPath and caption are required" });
  if (!TT_APP_KEY || !TT_APP_SECRET || !TT_REFRESH) {
    return res.status(400).json({ error: "TikTok env not configured" });
  }

  if (idemKey && idem.has(idemKey)) {
    const prev = idem.get(idemKey);
    return res.json({ ok: true, publish_id: prev.publish_id, cached: true });
  }

  let localPath;
  try {
    const dbx = await getDropboxClient();
    const { result } = await dbx.filesGetTemporaryLink({ path: dropboxPath });
    const name = result.metadata?.name || "video.mp4";
    const ext = path.extname(name) || ".mp4";
    localPath = tmpPath(ext);
    const resp = await axios.get(result.link, { responseType: "stream", maxRedirects: 5 });
    await pipeline(resp.data, fs.createWriteStream(localPath));
    const stat = await fs.promises.stat(localPath);

    const ttAccess = await getTtAccessToken();
    const { publish_id, upload_url } = await ttInitDirectPost(ttAccess, { title: caption, sizeBytes: stat.size, privacy });
    await ttUpload(upload_url, localPath);

    if (idemKey) idem.set(idemKey, { publish_id, at: Date.now() });
    return res.json({ ok: true, publish_id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    if (localPath) fs.promises.unlink(localPath).catch(()=>{});
  }
});

// Check post status
app.get("/tiktok/status", requireSecret, async (req, res) => {
  const publish_id = req.query.publish_id;
  if (!publish_id) return res.status(400).json({ error: "publish_id required" });
  try {
    const ttAccess = await getTtAccessToken();
    const data = await ttGetPostStatus(ttAccess, publish_id);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
