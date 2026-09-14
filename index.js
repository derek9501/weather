const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

// ==================== 設定與檔案路徑 ====================
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const CWA_TYPHOON_TRACK_API = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005?Authorization=CWB-172CF677-D022-4A92-B9C9-0AFADC2D08E5&format=XML";

const DATA_FILE = path.join(__dirname, 'weather_data.json');
const HISTORY_DIR = path.join(__dirname, 'history');

if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

// ==================== 讀寫 JSON 資料庫 ====================
function loadDatabase() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.log("⚠️ 讀取歷史資料檔失敗，將重新初始化資料庫。");
    }
  }
  return {
    typhoonMemory: {},
    currentStatus: {}
  };
}

function saveDatabase(db) {
  // 強制刪除舊殘留的台灣網格欄位
  delete db.taiwanGrid;

  // 1. 更新根目錄的 weather_data.json
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');

  // 2. 格式化檔名：YYYY-MM-DD-HH-mm-ss.json (以台灣時間 UTC+8 為準)
  const now = new Date();
  const tzOffset = 8 * 60; // UTC+8
  const localTime = new Date(now.getTime() + (tzOffset + now.getTimezoneOffset()) * 60000);

  const year = localTime.getFullYear();
  const month = String(localTime.getMonth() + 1).padStart(2, '0');
  const day = String(localTime.getDate()).padStart(2, '0');
  const hours = String(localTime.getHours()).padStart(2, '0');
  const minutes = String(localTime.getMinutes()).padStart(2, '0');
  const seconds = String(localTime.getSeconds()).padStart(2, '0');

  const fileName = `${year}-${month}-${day}-${hours}-${minutes}-${seconds}.json`;
  const historyFilePath = path.join(HISTORY_DIR, fileName);

  // 3. 寫入歷史紀錄至外層 history/ 資料夾
  fs.writeFileSync(historyFilePath, JSON.stringify(db, null, 2), 'utf8');
  console.log(`📁 歷史紀錄已成功存檔至：history/${fileName}`);
}

// ==================== 核心主程式 ====================
async function main() {
  try {
    console.log("🚀 [步驟 1/4] 開始執行颱風/熱帶氣旋追蹤程式...");
    const db = loadDatabase();

    // 1. 向中央氣象署查詢目前所有活動中的熱帶氣旋與氣象署發布時間
    console.log("\n📡 [步驟 2/4] 正在連線至中央氣象署 (CWA) 取得最新熱帶氣旋資料...");
    const { activeTyphoons, cwaDataTime } = await fetchAllActiveTyphoons();

    // 2. 若完全沒有颱風或熱帶低壓
    if (activeTyphoons.length === 0) {
      console.log("🟢 檢查結果：目前洋面上沒有活躍的熱帶氣旋！");
      db.currentStatus = {
        hasTyphoon: "NO",
        updatedAt: cwaDataTime || "無發布資料",
        message: "🌊 當前洋面無活躍颱風或熱帶性低氣壓，系統進入休眠待命。"
      };
      db.radar5x5 = {};
      saveDatabase(db);
      console.log("\n✅ [步驟 4/4] 狀態已更新並備份至 history 資料夾，任務順利結束。");
      return;
    }

    // 3. 逐一掃描所有活躍熱帶氣旋並進行近心點定位
    console.log(`\n🚨 [步驟 3/4] 偵測到 ${activeTyphoons.length} 個活躍熱帶氣旋！開始進行 OpenWeather 5x5 精確定位...`);

    let typhoonResults = [];
    let radar5x5Data = {};

    for (const typhoon of activeTyphoons) {
      console.log(`\n🔍 正在分析：【${typhoon.name}】...`);
      console.log(`📍 氣象署官方預報位置：北緯 ${typhoon.lat}° / 東經 ${typhoon.lon}°（中心氣壓：${typhoon.officialPressure}）`);

      let savedCoord = db.typhoonMemory[typhoon.name] || { lat: typhoon.lat, lon: typhoon.lon };
      const gridCenterLat = Math.round(savedCoord.lat * 2) / 2;
      const gridCenterLon = Math.round(savedCoord.lon * 2) / 2;

      let collectedData = [];
      let currentRadarGrids = {};

      for (let r = 2; r >= -2; r--) {
        for (let c = -2; c <= 2; c++) {
          let pLat = Number((gridCenterLat + (r * 0.5)).toFixed(1));
          let pLon = Number((gridCenterLon + (c * 0.5)).toFixed(1));
          let weatherData = await fetchSingleOpenWeather(pLat, pLon);

          if (weatherData) {
            collectedData.push({ lat: pLat, lon: pLon, pressure: weatherData.pressure, windSpeed: weatherData.windSpeed });
            currentRadarGrids[`${pLat}_${pLon}`] = weatherData;
          } else {
            collectedData.push({ lat: pLat, lon: pLon, pressure: 1013, windSpeed: 0 });
            currentRadarGrids[`${pLat}_${pLon}`] = { temp: null, pressure: 1013, weather: "無資料", windSpeed: 0, windDeg: 0, rain: 0, updatedAt: typhoon.cwaTime };
          }
        }
      }

      radar5x5Data[typhoon.name] = currentRadarGrids;

      if (collectedData.length > 0) {
        let minPressure = Math.min(...collectedData.map(d => d.pressure));
        let candidates = collectedData.filter(d => Math.abs(d.pressure - minPressure) <= 1.5);
        candidates.sort((a, b) => a.windSpeed - b.windSpeed);
        let eyeGrid = candidates[0];

        const estLat = Number(((gridCenterLat + eyeGrid.lat) / 2).toFixed(2));
        const estLon = Number(((gridCenterLon + eyeGrid.lon) / 2).toFixed(2));

        db.typhoonMemory[typhoon.name] = { lat: estLat, lon: estLon };
        
        typhoonResults.push({
          time: typhoon.cwaTime,
          name: typhoon.name,
          estLat, 
          estLon,
          pressure: `${eyeGrid.pressure} hPa`,
          wind: `${eyeGrid.windSpeed} m/s`,
          officialPos: `${typhoon.lat}N, ${typhoon.lon}E (${typhoon.officialPressure})`
        });

        console.log(`🎯 【${typhoon.name}】定位完成！`);
      }
    }

    db.currentStatus = {
      hasTyphoon: "YES",
      count: activeTyphoons.length,
      updatedAt: cwaDataTime,
      typhoons: typhoonResults
    };

    db.radar5x5 = radar5x5Data;

    saveDatabase(db);
    console.log("\n✅ [步驟 4/4] 所有颱風追蹤與 5x5 雷達網格資料已成功寫入！");

  } catch (err) {
    console.error("❌ 執行過程中發生未預期錯誤:", err);
    process.exit(1);
  }
}

// ==================== 輔助 API 工具 ====================
async function fetchSingleOpenWeather(lat, lon) {
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OPENWEATHER_API_KEY}&units=metric&lang=zh_tw`;
    const res = await axios.get(url);
    if (res.status === 200) {
      return {
        temp: res.data.main ? res.data.main.temp : null,
        pressure: res.data.main ? Number(res.data.main.pressure) : 1013,
        weather: res.data.weather && res.data.weather[0] ? res.data.weather[0].description : "未知",
        windSpeed: res.data.wind ? Number(res.data.wind.speed) : 0,
        windDeg: res.data.wind ? Number(res.data.wind.deg) : 0,
        rain: res.data.rain ? (res.data.rain['1h'] || res.data.rain['3h'] || 0) : 0
      };
    }
  } catch (e) {
    console.log(`⚠️ 座標 (${lat}, ${lon}) 查詢失敗: ${e.message}`);
  }
  return null;
}

function formatToTWTime(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  return d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
}

async function fetchAllActiveTyphoons() {
  const activeTyphoons = [];
  let cwaDataTime = "";

  try {
    const res = await axios.get(CWA_TYPHOON_TRACK_API);
    const parser = new XMLParser({ ignoreAttributes: false });
    const jsonObj = parser.parse(res.data);
    
    const records = jsonObj?.dataset?.records || jsonObj?.records;
    const tropicalCyclones = records?.TropicalCyclones || records;
    let cyclones = tropicalCyclones?.TropicalCyclone;

    if (!cyclones) {
      console.log("ℹ️ 中央氣象署 API 回傳：當前無熱帶氣旋資料。");
      return { activeTyphoons, cwaDataTime };
    }

    if (!Array.isArray(cyclones)) cyclones = [cyclones];

    for (const cyclone of cyclones) {
      const fixList = cyclone.AnalysisData?.Fix;
      if (!fixList) continue;
      const latestFix = Array.isArray(fixList) ? fixList[fixList.length - 1] : fixList;

      const rawFixTime = latestFix.FixTime || latestFix.DateTime || cyclone.AnalysisData?.IssueTime || records?.datasetInfo?.issueTime;
      const formattedFixTime = formatToTWTime(rawFixTime);

      if (!cwaDataTime) cwaDataTime = formattedFixTime;

      const name = cyclone.CwaTyphoonName || cyclone.TyphoonName || (cyclone.CwaTdNo ? `熱帶低壓TD${cyclone.CwaTdNo}` : "未命名熱帶氣旋");

      activeTyphoons.push({
        name: name,
        lat: Number(latestFix.CoordinateLatitude),
        lon: Number(latestFix.CoordinateLongitude),
        officialPressure: (latestFix.Pressure || "1000") + " hPa",
        cwaTime: formattedFixTime
      });
    }
    console.log(`📥 成功從氣象署取得 ${activeTyphoons.length} 個熱帶氣旋資料，氣象署最新發布時間：${cwaDataTime}`);
  } catch (e) {
    console.log("❌ 中央氣象署 XML 資料解析異常:", e.message);
  }
  return { activeTyphoons, cwaDataTime };
}

main();
