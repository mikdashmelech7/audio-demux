import express from "express";
import cors from "cors";
import { spawn } from "child_process";

const app = express();

// ===== CORS =====
const allowed = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  if (allowed.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (req.headers.origin && allowed.includes(req.headers.origin)) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range,Content-Type");
  next();
});

app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/", (_req, res) => {
  res
    .status(200)
    .send(
      'Use /audio?src={URL-ENCODED-SOURCE}&format=ogg|m4a  (example: /audio?src=https%3A%2F%2Fexample.com%2Fvideo.mp4&format=ogg)'
    );
});

// ===== /audio endpoint =====
// פרמטרים:
//  - src: כתובת קלט (URL) – URL-encoded
//  - id:  אופציונלי – מזהה קובץ בדרייב, במקום src (נבנה URL דרך האתר שלך)
//  - format: "ogg" או "m4a" (ברירת מחדל מה־ENV/ m4a)
app.get("/audio", async (req, res) => {
  try {
    const defFormat = (process.env.DEFAULT_FORMAT || "m4a").toLowerCase();
    let format = (req.query.format || defFormat).toString().toLowerCase();
    if (!["m4a", "ogg"].includes(format)) format = "m4a";

    let src = req.query.src;
    const id = req.query.id;

    if (!src && id) {
      // אם נותנים רק id – נשתמש בנתיב ה-stream שלך
      src = `https://mikdashmelech.co.il/media/drive-stream?id=${encodeURIComponent(id)}`;
    }
    if (!src) return res.status(400).send("Missing 'src' or 'id'");

    // נריץ FFmpeg: קלט מה-URL, וידאו החוצה, אודיו טרנסקוד לפורמט שביקשו.
    // (פשוט ויציב; רוצה passthrough? נוסיף בהמשך)
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", src,
      "-vn",
      "-ac", "2",
      "-ar", "48000"
    ];

    if (format === "ogg") {
      // Opus ב־OGG
      args.push("-c:a", "libopus", "-b:a", "96k", "-f", "ogg", "pipe:1");
      res.setHeader("Content-Type", "audio/ogg");
      res.setHeader("Content-Disposition", 'inline; filename="audio.ogg"');
    } else {
      // AAC ב־M4A (MP4)
      args.push(
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart+frag_keyframe+empty_moov",
        "-f", "mp4", "pipe:1"
      );
      res.setHeader("Content-Type", "audio/mp4");
      res.setHeader("Content-Disposition", 'inline; filename="audio.m4a"');
    }

    // חשוב לביטול buffering פרוקסי (אם רלוונטי)
    res.setHeader("X-Accel-Buffering", "no");

    const ff = spawn("ffmpeg", args);
    ff.stdout.pipe(res);

    ff.stderr.on("data", d => {
      // לוגים ל־stderr כדי לראות שגיאות בבילד/לוגים של Koyeb
      console.error(d.toString());
    });

    ff.on("close", code => {
      if (code !== 0 && !res.headersSent) {
        res.status(500).send("FFmpeg failed");
      }
    });

    req.on("close", () => {
      try { ff.kill("SIGKILL"); } catch {}
    });
  } catch (e) {
    console.error(e);
    res.status(500).send("Server error");
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
});
