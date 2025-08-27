import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import crypto from "crypto";

const app = express();

// ======= ENV =======
const PORT = process.env.PORT || 8080;
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
const HMAC_SECRET = process.env.HMAC_SECRET || ""; // אופציונלי (חתימה)
const MAX_DURATION_MIN = Number(process.env.MAX_DURATION_MIN || 180);
const MAX_CONCURRENCY_PER_USER = Number(process.env.MAX_CONCURRENCY_PER_USER || 3);
const DEFAULT_FORMAT = (process.env.DEFAULT_FORMAT || "auto").toLowerCase();
const ALLOW_FORMATS = (process.env.ALLOW_FORMATS || "m4a,ogg").split(",").map(s=>s.trim().toLowerCase());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ORIGINS.length === 0 || ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));

app.get("/healthz", (req, res) => res.status(200).send("ok"));

// הגבלת מקבילות לפי IP
const inflight = new Map(); // ip -> count
function inc(ip){ inflight.set(ip, (inflight.get(ip)||0) + 1); }
function dec(ip){ const n=(inflight.get(ip)||1)-1; if(n<=0) inflight.delete(ip); else inflight.set(ip,n); }

// אימות חתימה (אופציונלי)
function verifySig(url, exp, sig){
  if(!HMAC_SECRET) return true; // אם לא הוגדר — דולג
  if(!url || !exp || !sig) return false;
  const now = Math.floor(Date.now()/1000);
  if(Number(exp) < now) return false;
  const h = crypto.createHmac("sha256", HMAC_SECRET);
  h.update(url + "|" + exp);
  const expect = h.digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig)); }
  catch { return false; }
}

app.get("/demux", async (req, res) => {
  const ip = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "anon";
  const url = req.query.url?.toString() || "";      // מקור הווידאו (מומלץ קישור פרוקסי שלך, למשל /media/drive-stream?id=...)
  const exp = req.query.exp?.toString();            // תוקף החתימה (יוניקס), אופציונלי
  const sig = req.query.sig?.toString();            // חתימה, אופציונלי
  let fmt = (req.query.fmt?.toString() || DEFAULT_FORMAT).toLowerCase();
  const fname = (req.query.name?.toString() || "audio").replace(/[^ \w.\-_]/g,"").slice(0,120);

  if (!url) return res.status(400).json({error:"missing url"});
  if (!ALLOW_FORMATS.includes(fmt) && fmt !== "auto") return res.status(400).json({error:"fmt not allowed"});
  if (!verifySig(url, exp, sig)) return res.status(403).json({error:"bad signature"});

  // הגבלת מקבילות
  if ((inflight.get(ip)||0) >= MAX_CONCURRENCY_PER_USER) {
    return res.status(429).json({error:"too many concurrent requests"});
  }
  inc(ip);

  // אם fmt=auto נעדיף:
  // 1) AAC -> m4a (copy)
  // 2) Opus -> ogg (copy)
  // כדי לא להכניס ffprobe בשלב ראשון, נבחר m4a כברירת מחדל ונתקן שגיאות אם יהיו
  if (fmt === "auto") fmt = "m4a";

  // בניית פרמטרים ל-ffmpeg
  // מגבילים ל-max משך במקרי קלט "חי" (זהירות — רק הגנה בסיסית)
  const maxDurSec = Math.max(1, Math.min(MAX_DURATION_MIN, 1440)) * 60;

  function runFFmpeg(args, headers){
    const ff = spawn("ffmpeg", args, { stdio:["ignore","pipe","pipe"] });

    // כותרות תשובה
    for (const [k,v] of Object.entries(headers)) res.setHeader(k, v);

    ff.stdout.pipe(res);
    let errBuf = "";
    ff.stderr.on("data", d => { errBuf += d.toString(); if (errBuf.length > 4000) errBuf = errBuf.slice(-4000); });

    const cleanup = () => { try{ ff.kill("SIGKILL"); }catch{}; dec(ip); };
    res.on("close", cleanup);
    res.on("finish", cleanup);

    ff.on("close", (code) => {
      if (res.headersSent) return; // כבר נשלח גוף
      if (code === 0) return;      // הצליח (אין גוף נוסף)
      // כישלון — נחזיר שגיאה
      dec(ip);
      res.status(500).json({error:"ffmpeg failed", detail: errBuf.slice(-800)});
    });
  }

  // ניסיון 1: passthrough
  if (fmt === "m4a") {
    // audio/mp4; fragmented for streaming
    const args = [
      "-loglevel","error",
      "-reconnect","1","-reconnect_streamed","1","-reconnect_delay_max","5",
      "-i", url,
      "-t", String(maxDurSec),
      "-vn",
      "-c:a","copy",
      "-f","mp4",
      "-movflags","empty_moov+frag_keyframe",
      "pipe:1"
    ];
    runFFmpeg(args, {
      "Content-Type": "audio/mp4",
      "Content-Disposition": `inline; filename="${fname}.m4a"`,
      "Cache-Control": "no-store"
    });
    return;
  }

  if (fmt === "ogg") {
    const args = [
      "-loglevel","error",
      "-reconnect","1","-reconnect_streamed","1","-reconnect_delay_max","5",
      "-i", url,
      "-t", String(maxDurSec),
      "-vn",
      "-c:a","copy",
      "-f","ogg",
      "pipe:1"
    ];
    runFFmpeg(args, {
      "Content-Type": "audio/ogg",
      "Content-Disposition": `inline; filename="${fname}.ogg"`,
      "Cache-Control": "no-store"
    });
    return;
  }

  // אם הגיעו לכאן — משהו לא תקין
  dec(ip);
  res.status(400).json({error:"bad request"});
});

app.listen(PORT, () => {
  console.log("listening on", PORT);
});
