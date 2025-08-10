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
const DROPBOX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;
const TEMP_DIR = "/tmp"; // Render's writable temp dir

function log(step, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, ...extra }));
}

// Try to infer an extension from URL; fall back if missing
// --- helpers: inferExt & temp path (keep yours if already present) ---
function inferExt(url, fallback = ".bin") {
  try { const ext = path.extname(new URL(url).pathname); if (ext) return ext; } catch {}
  return fallback;
}
function tmpPath(ext = ".bin") { return path.join("/tmp", `${Date.now()}-${randomUUID()}${ext}`); }

// --- NEW: download via Dropbox API when input is a Dropbox link or a Dropbox path ---
async function downloadViaDropbox(input, fallbackExt = ".bin") {
  if (!DROPBOX_TOKEN) throw new Error("Missing DROPBOX_ACCESS_TOKEN");
  const dbx = new Dropbox({ accessToken: DROPBOX_TOKEN, fetch: fetch });

  // 1) If it's a shared link (https://www.dropbox.com/...), use sharingGetSharedLinkFile
  if (/^https?:\/\/.*dropbox\.com/i.test(input)) {
    const { result } = await dbx.sharingGetSharedLinkFile({ url: input });
    const name = (result?.name) || "file" + fallbackExt;
    const ext = path.extname(name) || inferExt(input, fallbackExt);
    const out = tmpPath(ext);
    const buf = Buffer.from(result.fileBinary); // ArrayBuffer -> Buffer
    await fs.promises.writeFile(out, buf);
    return out;
  }

  // 2) If it looks like a Dropbox path (/Folder/file.mp4), get a temporary link then stream it
  if (input.startsWith("/")) {
    const { result } = await dbx.filesGetTemporaryLink({ path: input });
    const direct = result.link;                       // real, expiring URL to the bytes
    const name = result.metadata?.name || "file" + fallbackExt;
    const ext = path.extname(name) || fallbackExt;
    const out = tmpPath(ext);
    const resp = await axios.get(direct, { responseType: "stream", maxRedirects: 5 });
    await pipeline(resp.data, fs.createWriteStream(out));
    return out;
  }

  throw new Error("Unsupported Dropbox input. Provide a shared link (https://www.dropbox.com/...) or a Dropbox path like /Folder/file.mp4");
}

// --- replace your existing downloadToFile with this wrapper ---
async function downloadToFile(urlOrPath, fallbackExt = ".bin") {
  // Use Dropbox API for any Dropbox input; otherwise fall back to normal HTTP
  if (/^https?:\/\/.*dropbox\.com/i.test(urlOrPath) || urlOrPath.startsWith("/")) {
    return downloadViaDropbox(urlOrPath, fallbackExt);
  }
  const ext = inferExt(urlOrPath, fallbackExt);
  const out = tmpPath(ext);
  const resp = await axios.get(urlOrPath, { responseType: "stream", maxRedirects: 5, headers: { "User-Agent": "curl/8" } });
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
        "-c:v copy",     // fast path; re-encode if needed by swapping to libx264
        "-c:a aac",
        "-b:a 192k",
        "-shortest"
      ])
      .on("error", (err) => reject(err))
      .on("end", () => resolve(outPath))
      .save(outPath);
  });
}

async function uploadToDropbox(localPath, dropboxPath) {
  if (!DROPBOX_TOKEN) throw new Error("Missing DROPBOX_ACCESS_TOKEN");
  const dbx = new Dropbox({ accessToken: DROPBOX_TOKEN, fetch: fetch });

  const stats = await fs.promises.stat(localPath);
  if (stats.size > 150 * 1024 * 1024) {
    throw new Error("File too large for simple upload (>150MB).");
  }

  const file = await fs.promises.readFile(localPath);
  const res = await dbx.filesUpload({
    path: dropboxPath,
    contents: file,
    mode: { ".tag": "add" },
    mute: true
  });
  return res;
}

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
    log("download.done", { vPath, aPath });

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
