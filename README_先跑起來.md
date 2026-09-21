# 親情防斷線 V0.1

這是第一個「真實 LINE 使用情境」測試版骨架。

## 這一版要驗證什麼

只驗證：

1. 爸媽收到 AI 主動關心後，願不願意回。
2. AI 對話會不會讓爸媽覺得自然。
3. 爸媽會不會覺得煩。
4. 爸媽是否願意隔天繼續聊。
5. 子女看到「親情雷達」摘要是否真的有幫助。

## 目前功能

- LINE Webhook
- LINE 回覆訊息
- 簡單對話記憶
- 基礎生活/不舒服關鍵訊號判斷
- 子女端測試 Dashboard
- Webhook signature verification

目前 AI 回覆是 DEMO_MODE，不會真的呼叫 LLM。
先用它測試 LINE 操作手感；確定爸媽喜歡，再接真正 AI。

## 跑法

需要 Node.js 18+。

1. 複製 `.env.example` 成 `.env`
2. 填入：
   - LINE_CHANNEL_ACCESS_TOKEN
   - LINE_CHANNEL_SECRET
3. `npm install`
4. `npm start`

本機網址：
`http://localhost:3000`

注意：LINE webhook 必須是公開 HTTPS 網址，因此正式接 LINE 時需要部署到可提供 HTTPS 的伺服器/雲端服務。

## LINE 設定

在 LINE Developers Console 建立 Messaging API channel，取得 channel access token 與 channel secret。

Webhook URL 設成：

`https://你的網域/webhook`

並啟用 webhook。

測試時，把官方帳號加入好友，直接傳訊息。

## 第一輪測試建議

不要告訴爸媽太多產品概念。

只告訴他們：

「這是我做的一個小幫手，你就像平常用 LINE 一樣跟它聊天，幫我試三天。」

Day 1：閒聊
Day 2：生活關心
Day 3：加入一個你希望 AI 幫忙留意的事情

測試後只問：

- 你覺得它像不像真的人在聊天？
- 會不會覺得煩？
- 明天還願不願意跟它聊？
- 如果我忙到沒辦法打電話，你覺得它先幫我關心你，好不好？

## 重要

這只是家庭內部 MVP，不是醫療產品。

不要在第一輪測試蒐集不必要的健康資料，也不要讓 AI 做診斷。
如果未來正式商用，需要補上隱私政策、資料保存/刪除、權限控管、資安與健康/緊急事件處理規則。
