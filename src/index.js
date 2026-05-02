require('dotenv').config();

const express = require('express');
const line    = require('@line/bot-sdk');
const cron    = require('node-cron');
const { handleEvent }             = require('./lineHandler');
const { handleGroupEvent, sendSettlementReminders } = require('./groupHandler');
const { startScheduler }          = require('./syncService');

const app = express();

const lineConfig = {
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(lineConfig);

app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.post(
  '/webhook',
  line.middleware(lineConfig),
  async (req, res) => {
    res.status(200).json({ received: true });
    const events = req.body.events || [];
    await Promise.all(events.map(event => {
      // 群組 / 聊天室事件交給 groupHandler
      if (event.source.type === 'group' || event.source.type === 'room') {
        return handleGroupEvent(event, client);
      }
      // 個人聊天交給 lineHandler
      return handleEvent(event);
    }));
  }
);

app.use((err, req, res, next) => {
  console.error('[index] 未處理錯誤：', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server 啟動，監聽 port ${PORT}`);
  startScheduler();

  // 每天早上 9:00 發送未結算分帳提醒
  cron.schedule('0 0 9 * * *', () => {
    sendSettlementReminders(client).catch(console.error);
  }, { timezone: 'Asia/Taipei' });

  console.log('[scheduler] 結算提醒：每天 09:00');
});
