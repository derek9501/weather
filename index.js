const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

// ==================== 設定與檔案路徑 ====================
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const CWA_TYPHOON_TRACK_API = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005?Authorization=CWB-172CF677-D022-4A92-B9C9-0AFADC2D08E5&format=XML";

const DATA_FILE = path.join(__dirname, 'weather_data.json');

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
    currentStatus: {},
    history: []
  };
}

function saveDatabase(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// ==================== 核心主程式 ====================
async function main() {
  try {
    console.log("🚀 [步驟 1/4] 開始執行颱風/熱帶氣旋追蹤程式...");
    const db = loadDatabase();
    const currentTimeString = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
    console.log(`⏰ 當前執行時間：${currentTimeString}`);

    // 1. 向中央氣象署查詢目前所有活動中的熱帶氣旋
    console.log("\n📡 [步驟 2/4] 正在連線至中央氣象署 (CWA) 取得最新熱帶氣旋資料...");
    const activeTyphoons = await fetchAllActiveTyphoons();

    // 2. 若完全沒有颱風或熱帶低壓
    if (activeTyphoons.length === 0) {
      console.log("🟢 檢查結果：目前洋面上沒有活躍的熱帶氣旋！");
      db.currentStatus = {
        hasTyphoon: "NO",
        updatedAt: currentTimeString,
        message: "🌊 當前洋面無活躍颱風或熱帶性低氣壓，系統進入休眠待命。"
      };
      saveDatabase(db);
      console.log("\n✅ [步驟 4/4] 狀態已更新至 weather_data.json，任務順利結束。");
      return;
    }

    // 3. 逐一掃描所有活躍熱帶氣旋並進行近心點定位
    console.log(`\n🚨 [步驟 3/4] 偵測到 ${activeTyphoons.length} 個活躍熱帶氣旋！開始進行 OpenWeather 5x5 精確定位...`);

    for (const typhoon of activeTyphoons) {
      console.log(`\n🔍 正在分析：【${typhoon.name}】...`);
      console.log(`📍 氣象署官方預報位置：北緯 ${typhoon.lat}° / 東經 ${typhoon.lon}°（中心氣壓：${typhoon.officialPressure}）`);

      let savedCoord = db.typhoonMemory[typhoon.name] || { lat: typhoon.lat, lon: typhoon.lon };
      const gridCenterLat = Math.round(savedCoord.lat * 2) / 2;
      const gridCenterLon = Math.round(savedCoord.lon * 2) / 2;

      console.log(`🌐 建立 5x5 雷達掃描陣列，以區域中心 (${gridCenterLat}, ${gridCenterLon}) 為軸心發送 API 請求...`);

      let collectedData = [];
      for (let r = 2; r >= -2; r--) {
        for (let c = -2; c <= 2; c++) {
          let pLat = Number((gridCenterLat + (r * 0.5)).toFixed(1));
          let pLon = Number((gridCenterLon + (c * 0.5)).toFixed(1));
          let weatherData = await fetchSingleOpenWeather(pLat, pLon);

          if (weatherData) {
            collectedData.push({ lat: pLat, lon: pLon, pressure: weatherData.pressure, windSpeed: weatherData.windSpeed });
          } else {
            collectedData.push({ lat: pLat, lon: pLon, pressure: 1013, windSpeed: 0 });
          }
        }
      }

      if (collectedData.length > 0) {
        let minPressure = Math.min(...collectedData.map(d => d.pressure));
        let candidates = collectedData.filter(d => Math.abs(d.pressure - minPressure) <= 1.5);
        candidates.sort((a, b) => a.windSpeed - b.windSpeed);
        let eyeGrid = candidates[0];

        const estLat = Number(((gridCenterLat + eyeGrid.lat) / 2).toFixed(2));
        const estLon = Number(((gridCenterLon + eyeGrid.lon) / 2).toFixed(2));

        db.typhoonMemory[typhoon.name] = { lat: estLat, lon: estLon };
        db.history.push({
          time: currentTimeString,
          name: typhoon.name,
          estLat, 
          estLon,
          pressure: `${eyeGrid.pressure} hPa`,
          wind: `${eyeGrid.windSpeed} m/s`,
          officialPos: `${typhoon.lat}N, ${typhoon.lon}E (${typhoon.officialPressure})`
        });

        console.log(`🎯 【${typhoon.name}】定位完成！`);
        console.log(`🌀 推算最新中心座標：北緯 ${estLat}° / 東經 ${estLon}°（最低氣壓：${eyeGrid.pressure} hPa）`);
      }
    }

    db.currentStatus = {
      hasTyphoon: "YES",
      count: activeTyphoons.length,
      updatedAt: currentTimeString,
      typhoons: activeTyphoons.map(t => t.name)
    };

    saveDatabase(db);
    console.log("\n✅ [步驟 4/4] 所有熱帶氣旋資料已成功寫入 weather_data.json！");

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
        pressure: res.data.main ? Number(res.data.main.pressure) : 1013,
        windSpeed: res.data.wind ? Number(res.data.wind.speed) : 0
      };
    }
  } catch (e) {
    console.log(`⚠️ 座標 (${lat}, ${lon}) 查詢失敗: ${e.message}`);
  }
  return null;
}

async function fetchAllActiveTyphoons() {
  const activeTyphoons = [];
  try {
    const res = await axios.get(CWA_TYPHOON_TRACK_API);
    const parser = new XMLParser({ ignoreAttributes: false });
    const jsonObj = parser.parse(res.data);
    
    // 多重相容提取路徑：確保能打中 XML 中的 TropicalCyclone
    const records = jsonObj?.dataset?.records || jsonObj?.records;
    const tropicalCyclones = records?.TropicalCyclones || records;
    let cyclones = tropicalCyclones?.TropicalCyclone;

    if (!cyclones) {
      console.log("ℹ️ 中央氣象署 API 回傳：當前無熱帶氣旋資料。");
      return activeTyphoons;
    }

    if (!Array.isArray(cyclones)) cyclones = [cyclones];

    for (const cyclone of cyclones) {
      const fixList = cyclone.AnalysisData?.Fix;
      if (!fixList) continue;
      const latestFix = Array.isArray(fixList) ? fixList[fixList.length - 1] : fixList;

      // 名稱選擇：颱風名 > 熱帶低壓TD編號 > 未命名
      const name = cyclone.CwaTyphoonName || cyclone.TyphoonName || (cyclone.CwaTdNo ? `熱帶低壓TD${cyclone.CwaTdNo}` : "未命名熱帶氣旋");

      activeTyphoons.push({
        name: name,
        lat: Number(latestFix.CoordinateLatitude),
        lon: Number(latestFix.CoordinateLongitude),
        officialPressure: (latestFix.Pressure || "1000") + " hPa"
      });
    }
    console.log(`📥 成功從氣象署取得 ${activeTyphoons.length} 個活躍熱帶氣旋的初始資料。`);
  } catch (e) {
    console.log("❌ 中央氣象署 XML 資料解析異常:", e.message);
  }
  return activeTyphoons;
}

main();
