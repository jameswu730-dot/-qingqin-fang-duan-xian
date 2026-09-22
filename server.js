import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SECRET = process.env.LINE_CHANNEL_SECRET;
const { Pool } = pg;

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const PAIR_TTL_MS = 10 * 60 * 1000;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.get("/", (_req, res) => res.type("text").send("親情防斷線 V0.3 測試版運作中。家庭資料查詢功能暫不開放。"));
app.get("/db-test", async (_req, res) => {
  try {
    const result = await db.query("SELECT NOW() AS now");
    res.json({
      ok: true,
      database: "connected",
      time: result.rows[0].now
    });
  } catch (err) {
    console.error("Database connection error:", err);
    res.status(500).json({
      ok: false,
      database: "connection_failed"
    });
  }
});
app.get("/api/family/:userId", (_req, res) => res.status(403).json({ error: "查詢功能暫不開放" }));

const memory = new Map();
const pending = new Map(); // code -> {parentId, childId, expiresAt, stage}
const linkedParentToChild = new Map();
const linkedChildToParent = new Map();
const lastAlert = new Map();
const processedEvents = new Map();

function verifyLineSignature(req) {
  const signature = req.headers["x-line-signature"];
  if (!SECRET || typeof signature !== "string" || !req.rawBody) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(req.rawBody).digest();
  let received;
  try { received = Buffer.from(signature, "base64"); } catch { return false; }
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function cleanExpired() {
  const now = Date.now();
  for (const [code, request] of pending) if (request.expiresAt <= now) pending.delete(code);
  for (const [id, expires] of processedEvents) if (expires <= now) processedEvents.delete(id);
}

function demoReply(userId, text) {
  const history = memory.get(userId) || [];
  const previousUserText = history.filter(x => x.role === "user").slice(-3).map(x => x.text).join(" ");
  const mentionsSleep = /睡|失眠/.test(text);
  const previousSleep = /睡不好|失眠/.test(previousUserText);
  const mentionsDuration = /連續|已經|好幾|幾天|三天|[0-9０-９]+天/.test(text);
  let reply = "嗯嗯～我有在聽 😊 你再跟我說說看。";
  if (previousSleep && mentionsDuration) reply = "原來已經持續好幾天了。睡不好一定很累，你願意跟我說說，是比較難入睡，還是半夜容易醒來嗎？";
  else if (mentionsSleep) reply = "聽起來最近睡得不太好。這樣的情況持續多久了呢？";
  else if (/吃|飯|早餐|午餐|晚餐/.test(text)) reply = "今天吃了什麼？好不好吃？";
  else if (/痛|酸|不舒服|頭暈|胸|腳|肩膀/.test(text)) reply = "我知道了。這個不舒服多久了？現在還會嗎？";
  else if (/市場|買菜|菜|鄰居/.test(text)) reply = "最近市場還好逛嗎？今天有沒有買到想吃的？";
  else if (/天氣|下雨|冷|熱/.test(text)) reply = "最近天氣變化滿快的，你今天有出去嗎？";
  else if (/好|沒事|沒問題/.test(text)) reply = "那就好 ❤️ 今天過得還順利嗎？";
  history.push({ role: "user", text, at: new Date().toISOString() });
  history.push({ role: "assistant", text: reply, at: new Date().toISOString() });
  memory.set(userId, history.slice(-30));
  return reply;
}

async function lineRequest(endpoint, payload) {
  if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is missing");
  const response = await fetch(`https://api.line.me/v2/bot/message/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`LINE ${endpoint} failed: ${response.status} ${await response.text()}`);
}
const replyToLine = (replyToken, text) => lineRequest("reply", { replyToken, messages: [{ type: "text", text }] });
const pushToLine = (to, text) => lineRequest("push", { to, messages: [{ type: "text", text }] });

function newCode() {
  let code;
  do { code = String(crypto.randomInt(100000, 1000000)); } while (pending.has(code));
  return code;
}
async function saveFamilyLink(parentId, childId) {
  await db.query(
    `INSERT INTO family_links (parent_line_user_id, child_line_user_id)
     VALUES ($1, $2)`,
    [parentId, childId]
  );
}
async function loadFamilyLinks() {
  const result = await db.query(
    `SELECT parent_line_user_id, child_line_user_id
     FROM family_links`
  );

  linkedParentToChild.clear();
  linkedChildToParent.clear();

  for (const row of result.rows) {
    linkedParentToChild.set(
      row.parent_line_user_id,
      row.child_line_user_id
    );

    linkedChildToParent.set(
      row.child_line_user_id,
      row.parent_line_user_id
    );
  }

  console.log(`Loaded ${result.rows.length} family link(s) from database.`);
}

function unlink(userId) {
  const child = linkedParentToChild.get(userId);
  const parent = linkedChildToParent.get(userId);
  if (child) { linkedParentToChild.delete(userId); linkedChildToParent.delete(child); lastAlert.delete(userId); }
  if (parent) { linkedChildToParent.delete(userId); linkedParentToChild.delete(parent); lastAlert.delete(parent); }
  for (const [code, item] of pending) if (item.parentId === userId || item.childId === userId) pending.delete(code);
  return { otherId: child || parent || null, wasLinked: Boolean(child || parent) };
}

async function handleMessage(event) {
  const userId = event.source?.userId;
  if (!userId || event.source?.type !== "user") return;
  const text = event.message.text.trim();
  let reply;
  let notifyId = null;
  let notifyText = null;
  cleanExpired();

  if (text === "解除綁定") {
    const { otherId, wasLinked } = unlink(userId);
    reply = wasLinked ? "已解除家人綁定。之後不會再傳送測試提醒。" : "目前沒有已完成的家人綁定；相關待確認配對也已取消。";
    if (otherId) { notifyId = otherId; notifyText = "家人綁定已由另一方解除，後續不會再收到測試提醒。"; }
  } else if (text === "建立配對") {
    if (linkedParentToChild.has(userId) || linkedChildToParent.has(userId)) {
      reply = "你已有家人綁定。如需重新配對，請先傳「解除綁定」。";
    } else {
      for (const [code, item] of pending) if (item.parentId === userId) pending.delete(code);
      const code = newCode();
      pending.set(code, { parentId: userId, childId: null, stage: "waiting_child", expiresAt: Date.now() + PAIR_TTL_MS });
      reply = `測試配對碼：${code}\n10 分鐘內請由模擬孩子的 LINE 傳「加入配對 ${code}」。\n收到孩子申請後，你還需要親自確認。請只把配對碼交給你信任的測試帳號。`;
    }
  } else if (/^加入配對\s+[0-9]{6}$/.test(text)) {
    const code = text.match(/[0-9]{6}$/)[0];
    const request = pending.get(code);
    if (!request || request.stage !== "waiting_child" || request.parentId === userId) {
      reply = "配對碼無效、已過期，或不能用同一個帳號配對。";
    } else if (linkedParentToChild.has(userId) || linkedChildToParent.has(userId)) {
      reply = "你已有家人綁定，請先傳「解除綁定」。";
    } else {
      request.childId = userId;
      request.stage = "waiting_parent";
      reply = "配對申請已送出，等待模擬爸媽帳號確認。尚未建立綁定。";
      notifyId = request.parentId;
      notifyText = `收到一筆測試配對申請。若確定是你要配對的孩子帳號，請在 10 分鐘內回覆「確認配對 ${code}」；否則請忽略，配對會自動過期。`;
    }
  } else if (/^確認配對\s+[0-9]{6}$/.test(text)) {
    const code = text.match(/[0-9]{6}$/)[0];
    const request = pending.get(code);
    if (!request || request.stage !== "waiting_parent" || request.parentId !== userId) {
      reply = "找不到等待你確認的有效配對申請。";
    } else if (linkedParentToChild.has(userId) || linkedChildToParent.has(userId) || linkedParentToChild.has(request.childId) || linkedChildToParent.has(request.childId)) {
      pending.delete(code);
      reply = "其中一個帳號已有綁定，請先解除綁定再重新配對。";
    } else {
      await saveFamilyLink(userId, request.childId);

linkedParentToChild.set(userId, request.childId);
linkedChildToParent.set(request.childId, userId);

pending.delete(code);
      reply = "✅ 測試家人綁定完成。你傳送含有測試關鍵字的訊息時，孩子帳號會收到不含原文的提醒。傳「解除綁定」可隨時停止。";
      notifyId = request.childId;
      notifyText = "✅ 測試家人綁定完成。你可能收到關鍵字提醒；不會收到對話原文。傳「解除綁定」可隨時停止。";
    }
  } else if (text === "查看雷達") {
    const recent = (memory.get(userId) || []).filter(x => x.role === "user").slice(-10).map(x => x.text);
    reply = recent.length === 0 ? "親情雷達測試：目前沒有對話紀錄。" :
      /痛|酸|不舒服|睡不好|失眠|頭暈/.test(recent.join(" ")) ?
      "🟡 親情雷達測試\n最近對話曾提到身體不舒服或睡眠問題，值得進一步關心。\n\n這只是關鍵字測試，並非健康判斷。" :
      "⚪ 親情雷達測試\n最近 10 則訊息未命中目前設定的關鍵字；這不代表沒有需要關心的事情。";
  } else {
    reply = demoReply(userId, text);
    const childId = linkedParentToChild.get(userId);
    const last = lastAlert.get(userId) || 0;
    if (childId && /痛|酸|不舒服|睡不好|失眠|頭暈/.test(text) && Date.now() - last >= ALERT_COOLDOWN_MS) {
      notifyId = childId;
      notifyText = "🟡 親情防斷線測試提醒\n已綁定的家人最近訊息出現值得關心的關鍵字。請自行聯繫確認。\n這是規則式測試，不是健康判斷或緊急救援通知。";
      lastAlert.set(userId, Date.now());
    }
  }

  try { await replyToLine(event.replyToken, reply); } catch (err) { console.error("LINE reply error:", err); }
  if (notifyId) {
    try { await pushToLine(notifyId, notifyText); }
    catch (err) { console.error("LINE push error:", err); }
  }
}

app.post("/webhook", (req, res) => {
  if (!verifyLineSignature(req)) return res.status(401).send("invalid signature");
  res.sendStatus(200);
  for (const event of (req.body.events || [])) {
    if (event.type !== "message" || event.message?.type !== "text") continue;
    const eventId = event.webhookEventId;
    if (eventId) {
      cleanExpired();
      if (processedEvents.has(eventId)) continue;
      processedEvents.set(eventId, Date.now() + 24 * 60 * 60 * 1000);
    }
    void handleMessage(event).catch(err => console.error("Webhook processing error:", err));
  }
});

async function startServer() {
  try {
    await loadFamilyLinks();
    console.log("Family links loaded successfully.");
  } catch (err) {
    console.error("Failed to load family links:", err);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`親情防斷線 V0.4 running on port ${PORT}`);
  });
}

startServer();

