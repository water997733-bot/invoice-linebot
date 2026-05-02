/**
 * lineClient.js
 * 統一的 Line Client 實例，供各模組 import 使用
 * 避免多處各自建立 client 造成設定不一致
 */

const line = require('@line/bot-sdk');

const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

module.exports = client;
