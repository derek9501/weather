const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

// ==================== 環境變數與設定 ====================
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const CWA_TYPHOON_TRACK_API = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005?Authorization=CWB-172CF677-D022-4A92-B9C9-0AFADC2D08E5&format=XML";

const DATA_FILE = path.join(__dirname, 'weather_data.json');

// 台灣固定地圖經緯度配置
const LAT_START = 21.0; const LAT_END = 26.0; const LAT_STEP = 0.5;
const LON_START = 119.0; const LON_END = 123.0; const LON_STEP = 0.5;

const LATS = []; for (let lat = LAT_START; lat <= LAT_END; lat += LAT_STEP) { LATS.push(Number(lat.toFixed(1))); } LATS.reverse();
const LONS = []; for (let lon = LON_START; lon <= LON_END; lon += LON_STEP) { LONS.push(Number(lon.toFixed(1))); }

// ==================== JSON 資料庫讀寫 ====================
function loadDatabase() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.log("讀取資料檔失敗，重置資料庫。");
    }
  }
  return {
    step: 0,
    typhoonMemory: {},
    currentStatus: {},
    radar5x5: {},
    taiwanGrid: {},
    history: []
  };
}

function saveDatabase(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// ==================== 核心主程式 ====================
async function main() {
  try {
    const db = loadDatabase();
    const currentTimeString = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

    // 1. 抓取目前所有活躍颱風
    const typhoonPayload = await fetchAllActiveTyphoons();
    const activeTyphoons = typhoonPayload.allActiveTyphoons;
    const n = activeTyphoons.length;

    // 2. 無颱風時留守台灣
    if (n === 0) {
      db.currentStatus = {
        hasTyphoon: "NO",
        target: "無",
        lat: "",
        lon: "",
        pressure: "",
        message: "🏡 目前洋面安全，雷達全天候留守台灣本島大地圖。"
      };
      db.step = 0;
      await executeTaiwanGridSelection(db, currentTimeString);
      saveDatabase(db);
      console.log("任務完成：無颱風，已更新台灣本島氣象網格。");
      return;
    }

    // 3. 調度演算法 (2n : n 佇列)
    const totalSlots = 3 * n;
    let currentStep = db.step || 0;
    if (currentStep >= totalSlots) { currentStep = 0; }

    let currentTaskType = "";
    let targetTyphoonIdx = -1;

    if (currentStep < 2 * n) {
      targetTyphoonIdx = Math.floor(currentStep / 2);
      currentTaskType = (currentStep % 2 === 0) ? "TYPHOON_ROUND_1" : "TYPHOON_ROUND_2";
    } else {
      currentTaskType = "TAIWAN";
    }

    db.step = (currentStep + 1) >= totalSlots ? 0 : currentStep + 1;

    // 4. 執行任務分流
    if (currentTaskType === "TYPHOON_ROUND_1") {
      const typhoon = activeTyphoons[targetTyphoonIdx];
      let savedCoord = db.typhoonMemory[typhoon.name] || { lat: typhoon.lat, lon: typhoon.lon };

      const gridCenterLat = Math.round(savedCoord.lat * 2) / 2;
      const gridCenterLon = Math.round(savedCoord.lon * 2) / 2;

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
        db.currentStatus = {
          hasTyphoon: "YES",
          target: `${typhoon.name} (第1輪-觀測期)`,
          lat: estLat,
          lon: estLon,
          officialPressure: typhoon.officialPressure,
          message: `🎯 特徵識別成功！🌀${typhoon.name} 新中心：(${estLat}N, ${estLon}E)`
        };

        db.radar5x5 = {
          centerLat: gridCenterLat,
          centerLon: gridCenterLon,
          updatedAt: currentTimeString,
          data: collectedData
        };

        db.history.push({
          time: currentTimeString,
          name: typhoon.name,
          estLat, estLon,
          pressure: `${eyeGrid.pressure} hPa`,
          wind: `${eyeGrid.windSpeed} m/s`,
          remarks: `官方位置:${typhoon.lat}N, ${typhoon.lon}E (${typhoon.officialPressure})`
        });
      }

    } else if (currentTaskType === "TYPHOON_ROUND_2") {
      const typhoon = activeTyphoons[targetTyphoonIdx];
      let savedCoord = db.typhoonMemory[typhoon.name] || { lat: typhoon.lat, lon: typhoon.lon };
      db.currentStatus = {
        hasTyphoon: "YES",
        target: `${typhoon.name} (第2輪-緩衝期)`,
        lat: savedCoord.lat,
        lon: savedCoord.lon,
        officialPressure: typhoon.officialPressure,
        message: `⏳ [緩衝休眠] ⚡ 觸發 🌀${typhoon.name} 的 API 緩衝保護機制。`
      };

    } else if (currentTaskType === "TAIWAN") {
      db.currentStatus = {
        hasTyphoon: "YES",
        target: "台灣本島智慧更新輪",
        message: "🏡 [守護台灣] 任務調度返回本島！進行智慧 16 點密集修補。"
      };
      await executeTaiwanGridSelection(db, currentTimeString);
    }

    saveDatabase(db);
    console.log("任務執行完成，已寫入 weather_data.json！");
  } catch (err) {
    console.error("執行過程發生錯誤:", err);
    process.exit(1);
  }
}

// ==================== 輔助函式 ====================
async function fetchSingleOpenWeather(lat, lon) {
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OPENWEATHER_API_KEY}&units=metric&lang=zh_tw`;
    const res = await axios.get(url);
    if (res.status === 200) {
      const data = res.data;
      return {
        temp: data.main ? data.main.temp : "",
        pressure: data.main ? Number(data.main.pressure) : 1013,
        weather: (data.weather && data.weather[0]) ? data.weather[0].description : "",
        windSpeed: data.wind ? Number(data.wind.speed) : 0,
        windDeg: data.wind ? data.wind.deg : "",
        rain: (data.rain && data.rain['1h']) ? data.rain['1h'] : 0
      };
    }
  } catch (e) {
    console.log(`座標 (${lat}, ${lon}) 查詢異常:`, e.message);
  }
  return null;
}

async function fetchAllActiveTyphoons() {
  const payload = { allActiveTyphoons: [] };
  try {
    const res = await axios.get(CWA_TYPHOON_TRACK_API);
    const parser = new XMLParser({ ignoreAttributes: false });
    const jsonObj = parser.parse(res.data);
    let cyclones = jsonObj?.cwaopendata?.records?.TropicalCyclones?.TropicalCyclone;
    if (!cyclones) return payload;
    if (!Array.isArray(cyclones)) cyclones = [cyclones];

    for (const cyclone of cyclones) {
      const fixList = cyclone.AnalysisData?.Fix;
      if (!fixList) continue;
      const latestFix = Array.isArray(fixList) ? fixList[fixList.length - 1] : fixList;
      payload.allActiveTyphoons.push({
        name: cyclone.CwaTyphoonName || cyclone.TyphoonName,
        lat: Number(latestFix.CoordinateLatitude),
        lon: Number(latestFix.CoordinateLongitude),
        officialPressure: (latestFix.Pressure || "1000") + " hPa"
      });
    }
  } catch (e) {
    console.log("CWA XML 解析異常:", e.message);
  }
  return payload;
}

async function executeTaiwanGridSelection(db, currentTimeString) {
  const now = new Date().getTime();
  const candidates = [];

  for (let r = 0; r < LATS.length; r++) {
    for (let c = 0; c < LONS.length; c++) {
      const lat = LATS[r]; const lon = LONS[c];
      const key = `${lat}_${lon}`;
      const lastData = db.taiwanGrid[key] || {};
      const lastUpdateTime = lastData.updatedAt ? new Date(lastData.updatedAt).getTime() : 0;
      const timeDiffMinutes = (now - lastUpdateTime) / (1000 * 60);

      let score = timeDiffMinutes * 1.0;
      if (lat >= 23.0 && lat <= 24.5 && lon >= 120.5 && lon <= 121.5) { score += 1; } else { score += 5; }
      if (String(lastData.weather || "").match(/(雨|雷|暴|風|雪|霾|霧)/i)) { score += 50; }

      candidates.push({ lat, lon, key, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const targetPoints = candidates.slice(0, 16);

  for (const point of targetPoints) {
    let data = await fetchSingleOpenWeather(point.lat, point.lon);
    if (data) {
      db.taiwanGrid[point.key] = {
        ...data,
        updatedAt: currentTimeString
      };
    }
  }
}

main();
