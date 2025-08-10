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
const TEMP_DIR = "/tmp"; // Render's writable temp dir

// Dropbox OAuth (refresh-token) env vars
const DBX_REFRESH = process.env.DROPBOX_REFRESH_TOKEN;
const DBX_APP_KEY = process.env.DROPBOX_APP_KEY;
const DBX_APP_SECRET = process.env.DROPBOX_APP_SECRET;

if (!DBX_REFRESH || !DBX_APP_KEY || !DBX_APP_SECRET) {
  console.warn(
    "Missing Dropbox OAuth env vars. Set DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, DROPBOX_APP_SECRET."
  );
}

function log(step, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, ...extra }));
}

/* -------------------- Dropbox token refresh -------------------- */
let tokenCache = { accessToken: null, expiresAt: 0 }; // ms epoch

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken; // reuse until 60s before expiry
  }

  // Exchange refresh token for a new access token
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: DBX_REFRESH,
  });

  const { data } = await axios.post(
    "https://api.dropboxapi.com/oauth2/token",
    body.toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      auth: { username: DBX_APP_KEY, password: DBX_APP_SECRET },
      timeout: 15000,
    }
  );

  tokenCache.accessToken = data.access_token;
  // expires_in is seconds
  tokenCache.expiresAt = Date.now() + (data.expires_in || 14400) * 1000;
  log("dropbox.token.refreshed", { expires_in: data.expires_in });
  return tokenCache.accessToken;
}

async function getDropboxClient() {
  const accessToken = await getAccessToken();
  return new Dropbox({ accessToken, fetch: fetch });
}

/* -------------------- Helpers -------------------- */
function inferExt(url, fallback = ".bin") {
  try {
    const ext = path.extname(new URL(url).pathname);
    if (ext) return ext;
  } catch {}
  return fallback;
}

function tmpPath(ext = ".bin") {
  return path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${ext}`);
}

// Download via Dropbox API for shared links or Dropbox paths
async function downloadViaDropbox(input, fallbackExt = ".bin") {
  const dbx = await getDropboxClient();

  // 1) Public shared link (https://www.dropbox.com/...)
  if (/^https?:\/\/.*dropbox\.com/i.test(input)) {
    const { result } = await dbx.sharingGetSharedLinkFile({ url: input });
    const name = result?.name || `file${fallbackExt}`;
    const ext = path.extname(name) || inferExt(input, fallbackExt);
    const out = tmpPath(ext);
    const buf = Buffer.from(result.fileBinary); // ArrayBuffer -> Buffer
    await fs.promises.writeFile(out, buf);
    return out;
  }

  // 2) Dropbox path (/Folder/file.ext)
  if (input.startsWith("/")) {
    const { result } = await dbx.filesGetTemporaryLink({ path: input });
    const direct = result.link; // expiring byte URL
    const name = result.metadata?.name || `file${fallbackExt}`;
    const ext = path.extname(name) || fallbackExt;
    const out = tmpPath(ext);
    const resp = await axios.get(direct, { responseType: "stream", maxRedirects: 5 });
    await pipeline(resp.data, fs.createWriteStream(out));
    return out;
  }

  throw new Error(
    "Unsupported Dropbox input. Provide a shared link (https://www.dropbox.com/...) or a Dropbox path like /Folder/file.mp4"
  );
}

// Wrapper: use Dropbox API for Dropbox inputs; plain HTTP otherwise
async function downloadToFile(urlOrPath, fallbackExt = ".bin") {
  if (/^https?:\/\/.*dropbox\.com/i.test(urlOrPath) || urlOrPath.startsWith("/")) {
    return downloadViaDropbox(urlOrPath, fallbackExt);
  }
  const ext = inferExt(urlOrPath, fallbackExt);
  const out = tmpPath(ext);
  const resp = await axios.get(urlOrPath, {
    responseType: "stream",
    maxRedirects: 5,
    headers: { "User-Agent": "curl/8" },
  });
  await pipeline(resp.data, fs.createWriteStream(out));
  return out;
}

function mergeAV(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    const outPath = tmpPath(".mp4");
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map 0:v:0",
        "-map 1:a:0",
        "-c:v copy", // fast path; if problems, swap to: "-c:v libx264", "-preset veryfast"
        "-c:a aac",
        "-b:a 192k",
        "-shortest",
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
  const res = await dbx.filesUpload({
    path: dropboxPath,
    contents: file,
    mode: { ".tag": "add" },
    mute: true,
  });
  return res;
}

/* -------------------- Routes -------------------- */
// Health check
app.get("/", (_req, res) => res.send("OK"));

// POST /merge { videoUrl, audioUrl, dropboxPath? }
app.post("/merge", async (req, res) => {
  const { videoUrl, audioUrl, dropboxPath } = req.body || {};
  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: "videoUrl and audioUrl are required" });
  }

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

    if (dropboxPath) {
      const finalPath = dropboxPath.endsWith(".mp4")
        ? dropboxPath
        : `${dropboxPath}/merged-${Date.now()}.mp4`;
      log("dropbox.upload.start", { finalPath });
      const up = await uploadToDropbox(mPath, finalPath);
      log("dropbox.upload.done", { id: up?.result?.id || up?.id });
      res.setHeader("X-Dropbox-Path", finalPath);
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

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
