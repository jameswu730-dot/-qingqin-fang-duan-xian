import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.get("/", (req, res) => {
  res.type("text").send("親情防斷線測試版運作中。家庭資料查詢功能暫不開放。");
});

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
  const previousUserText = history
    .filter(x => x.role === "user")
    .slice(-3)
    .map(x => x.text)
    .join(" ");

  let reply = "嗯嗯～我有在聽 😊 你再跟我說說看。";

  const mentionsSleep = /睡|失眠/.test(text);
  const previousSleep = /睡不好|失眠/.test(previousUserText);
  const mentionsDuration = /連續|已經|好幾|幾天|三天|[0-9０-９]+天/.test(text);

  if (previousSleep && mentionsDuration) {
    reply = "原來已經持續好幾天了。睡不好一定很累，你願意跟我說說，是比較難入睡，還是半夜容易醒來嗎？";
  } else if (mentionsSleep) {
    reply = "聽起來最近睡得不太好。這樣的情況持續多久了呢？";
  } else if (/吃|飯|早餐|午餐|晚餐/.test(text)) {
    reply = "今天吃了什麼？好不好吃？";
  } else if (/痛|酸|不舒服|頭暈|胸|腳|肩膀/.test(text)) {
    reply = "我知道了。這個不舒服多久了？現在還會嗎？";
  } else if (/市場|買菜|菜|鄰居/.test(text)) {
    reply = "最近市場還好逛嗎？今天有沒有買到想吃的？";
  } else if (/天氣|下雨|冷|熱/.test(text)) {
    reply = "最近天氣變化滿快的，你今天有出去嗎？";
  } else if (/好|沒事|沒問題/.test(text)) {
    reply = "那就好 ❤️ 今天過得還順利嗎？";
  }

  history.push({ role: "user", text, at: new Date().toISOString() });
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


// 暫時關閉未經身分驗證的家庭對話查詢。
app.get("/api/family/:userId", (req, res) => {
  res.status(403).json({
    error: "此查詢功能暫時關閉，等待加入身分驗證。"
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

let reply;

if (text.trim() === "查看雷達") {
  const history = memory.get(userId) || [];
  const recent = history
    .filter(x => x.role === "user")
    .slice(-10)
    .map(x => x.text);

  const combined = recent.join(" ");

  if (recent.length === 0) {
    reply = "親情雷達測試：目前沒有對話紀錄。";
  } else if (/痛|酸|不舒服|睡不好|失眠|頭暈/.test(combined)) {
    reply = "🟡 親情雷達測試\n最近對話曾提到身體不舒服或睡眠問題，值得進一步關心。\n\n提醒：這只是關鍵字測試，並非健康判斷。";
  } else {
    reply = "⚪ 親情雷達測試\n最近 10 則訊息未命中目前設定的關鍵字。\n\n這不代表沒有需要關心的事情。";
  }
} else {
  reply = demoReply(userId, text);
}

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
