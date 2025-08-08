# ffmpeg-merge-service

Downloads video+audio from Dropbox URLs, merges them with FFmpeg, then either streams the merged MP4 back or uploads it to Dropbox and returns a link.

## Deploy on Render
1. Push this code to GitHub.
2. Create new Web Service in Render from the repo.
3. Set `DROPBOX_ACCESS_TOKEN` in Render environment variables.
4. Deploy.

## Example request
```bash
curl -X POST https://<your-service>.onrender.com/merge   -H 'Content-Type: application/json'   -o merged.mp4   -d '{
    "videoUrl": "https://www.dropbox.com/s/<id>/video.mp4?dl=0",
    "audioUrl": "https://www.dropbox.com/s/<id>/audio.m4a?dl=0",
    "filename": "output.mp4"
  }'
```
