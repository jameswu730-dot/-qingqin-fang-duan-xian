import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static("public"));

const memory = new Map();

function verifyLineSignature(req) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  const signature = req.headers["x-line-signature"];
  if (!secret || !signature || !req.rawBody) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(signature)
  );
}

function demoReply(userId, text) {
  const history = memory.get(userId) || [];
  history.push({ role: "user", text, at: new Date().toISOString() });

  let reply = "嗯嗯～我有在聽 😊 你再跟我說說看。";

  if (/吃|飯|早餐|午餐|晚餐/.test(text)) {
    reply = "有吃就好～今天吃什麼？好不好吃？";
  } else if (/睡|失眠|睡覺|睡不好/.test(text)) {
    reply = "最近睡得還好嗎？如果這幾天一直睡不好，也可以跟我說一下。";
  } else if (/痛|酸|不舒服|頭暈|胸|腳|肩膀/.test(text)) {
    reply = "喔～我知道了。這個不舒服多久了？現在還會嗎？";
  } else if (/市場|買菜|菜|鄰居/.test(text)) {
    reply = "哈哈，最近市場還好逛嗎？今天有沒有買到想吃的？";
  } else if (/天氣|下雨|冷|熱/.test(text)) {
    reply = "最近天氣變化滿快的，你今天有出去嗎？";
  } else if (/好|沒事|沒問題/.test(text)) {
    reply = "那就好 ❤️ 今天過得還順利嗎？";
  }

  history.push({ role: "assistant", text: reply, at: new Date().toISOString() });
  memory.set(userId, history.slice(-30));

  return reply;
}

async function replyToLine(replyToken, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is missing");

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE reply failed: ${response.status} ${body}`);
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "親情防斷線 V0.1", mode: process.env.DEMO_MODE === "true" ? "demo" : "live" });
});

app.get("/api/family/:userId", (req, res) => {
  const history = memory.get(req.params.userId) || [];
  const userMessages = history.filter(x => x.role === "user").slice(-10);
  const text = userMessages.map(x => x.text).join(" ");

  const flags = [];
  if (/痛|酸|不舒服|睡不好|失眠|頭暈/.test(text)) {
    flags.push({
      level: "yellow",
      title: "值得留意",
      detail: "最近對話中出現身體不舒服或睡眠相關描述，建議子女找時間關心。"
    });
  }

  res.json({
    userId: req.params.userId,
    recentMessages: history.slice(-12),
    radar: flags.length ? flags : [{
      level: "green",
      title: "目前正常",
      detail: "最近對話沒有偵測到需要特別提醒的內容。"
    }]
  });
});

app.post("/webhook", async (req, res) => {
  // LINE production security: always verify webhook signature.
  if (!verifyLineSignature(req)) {
    return res.status(401).send("invalid signature");
  }

  res.sendStatus(200);

  for (const event of (req.body.events || [])) {
    if (event.type !== "message" || event.message?.type !== "text") continue;

    const userId = event.source?.userId;
    const text = event.message.text || "";
    const reply = demoReply(userId, text);

    try {
      await replyToLine(event.replyToken, reply);
    } catch (err) {
      console.error(err);
    }
  }
});

app.listen(PORT, () => {
  console.log(`親情防斷線 V0.1 running on http://localhost:${PORT}`);
});
