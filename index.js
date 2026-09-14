const fs = require('fs');
const path = require('path');

// 1. 確保 history 資料夾存在，若不存在則自動建立
const historyDir = path.join(__dirname, 'history');
if (!fs.existsSync(historyDir)) {
  fs.mkdirSync(historyDir, { recursive: true });
}

// 2. 取得今天的日期字串 (格式：YYYY-MM-DD)
// 註：依需求可以改用台灣時區或加上時間 (如 YYYY-MM-DD_HH-mm)
const today = new Date().toISOString().split('T')[0];
const filePath = path.join(historyDir, `${today}.json`);

// 假設這是你抓到的天氣資料物件
const weatherData = {
  date: today,
  location: "Taipei",
  description: "Sunny",
  updatedAt: new Date().toISOString()
};

// 3. 將資料轉成 JSON 字串並寫入歷史紀錄檔案
fs.writeFileSync(filePath, JSON.stringify(weatherData, null, 2), 'utf-8');

console.log(`天氣資料已成功儲存至: ${filePath}`);
