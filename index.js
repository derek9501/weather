const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

// ==================== 環境變數讀取 ====================
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const CWA_TYPHOON_TRACK_API = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005?Authorization=CWB-172CF677-D022-4A92-B9C9-0AFADC2D08E5&format=XML";

// 【台灣固定大地圖經緯度配置】
const LAT_START = 21.0; const LAT_END = 26.0; const LAT_STEP = 0.5;
const LON_START = 119.0; const LON_END = 123.0; const LON_STEP = 0.5;

const LATS = []; for (let lat = LAT_START; lat <= LAT_END; lat += LAT_STEP) { LATS.push(Number(lat.toFixed(1))); } LATS.reverse();
const LONS = []; for (let lon = LON_START; lon <= LON_END; lon += LON_STEP) { LONS.push(Number(lon.toFixed(1))); }

const DATA_FILE_PATH = path.join(__dirname, 'data', 'weather_data.json');

// 讀取/初始化 JSON 資料庫
function loadDatabase() {
  if (!fs.existsSync(path.dirname(DATA_FILE_PATH))) {
    fs.mkdirSync(path.dirname(DATA_FILE_PATH), { recursive: true });
  }
  if (fs.existsSync(DATA_FILE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE_PATH, 'utf-8'));
    } catch (e) {
      console.error("資料庫讀取失敗，初始化新資料庫");
    }
  }
  return {
    queue: { currentStep: 0 },
    typhoonMemory: {},
    typhoonStatus: { active: false, target: "無", currentCoords: { lat: null, lon: null }, statusText: "" },
    radar5x5: { center: { lat: null, lon: null }, lats: [], lons: [], grid: [], lastUpdate: "" },
    historyLogs: [],
    taiwanGrid: {
      temperature: {}, pressure: {}, weather: {}, windSpeed: {}, windDeg: {}, rain: {}, updateTime: {}, alert: {}
    }
  };
}

function saveDatabase(db) {
  fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

/**
 * 主執行函式
 */
async function updateTaiwanWeatherSystem() {
  const db = loadDatabase();
  const currentTimeString = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

  const typhoonPayload = await fetchAllActiveTyphoons();
  const activeTyphoons = typhoonPayload.allActiveTyphoons;
  const n = activeTyphoons.length;

  if (n === 0) {
    db.typhoonStatus = {
      active: false,
      target: "無",
      currentCoords: { lat: null, lon: null },
      statusText: "🏡 目前洋面安全，雷達全天候留守台灣本島大地圖。"
    };
    db.queue.currentStep = 0;
    await executeTaiwanGridSelection(db, currentTimeString);
    saveDatabase(db);
    return;
  }

  // 任務佇列調度演算法
  const totalSlots = 3 * n;
  let currentStep = db.queue.currentStep || 0;
  if (currentStep >= totalSlots) currentStep = 0;

  let currentTaskType = "";
  let targetTyphoonIdx = -1;

  if (currentStep < 2 * n) {
    targetTyphoonIdx = Math.floor(currentStep / 2);
    currentTaskType = (currentStep % 2 === 0) ? "TYPHOON_ROUND_1" : "TYPHOON_ROUND_2";
  } else {
    currentTaskType = "TAIWAN";
  }

  db.queue.currentStep = (currentStep + 1) >= totalSlots ? 0 : currentStep + 1;
  db.typhoonStatus.active = true;

  if (currentTaskType === "TYPHOON_ROUND_1") {
    const typhoon = activeTyphoons[targetTyphoonIdx];
    let savedCoord = getTyphoonDedicatedCoords(db, typhoon.name, typhoon.lat, typhoon.lon);

    const gridCenterLat = Math.round(savedCoord.lat * 2) / 2;
    const gridCenterLon = Math.round(savedCoord.lon * 2) / 2;

    db.typhoonStatus.target = `${typhoon.name} (第1輪-觀測期)`;
    db.typhoonStatus.currentCoords = savedCoord;
    db.typhoonStatus.officialPressure = typhoon.officialPressure;
    db.typhoonStatus.statusText = `🛰️ [5x5全面搜索] 正在鎖定 🌀${typhoon.name}。專屬記憶準星:(${savedCoord.lat}, ${savedCoord.lon}) -> 打點對齊:(${gridCenterLat}, ${gridCenterLon})`;

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
      let eyeGrid = candidates.reduce((min, c) => c.windSpeed < min.windSpeed ? c : min, candidates[0]);

      const estLat = Number(((gridCenterLat + eyeGrid.lat) / 2).toFixed(2));
      const estLon = Number(((gridCenterLon + eyeGrid.lon) / 2).toFixed(2));

      saveTyphoonDedicatedCoords(db, typhoon.name, estLat, estLon);
      db.typhoonStatus.currentCoords = { lat: estLat, lon: estLon };
      db.typhoonStatus.statusText = `🎯 特徵識別成功！🌀${typhoon.name} 新中心：(${estLat}N, ${estLon}E)`;

      // 儲存 5x5 雷達觀察檔
      renderTyphoonRadar5x5View(db, gridCenterLat, gridCenterLon, collectedData, currentTimeString);

      // 追加歷史記錄
      db.historyLogs.push({
        time: currentTimeString,
        name: typhoon.name,
        estLat, estLon,
        eyePressure: `${eyeGrid.pressure} hPa`,
        eyeWind: `${eyeGrid.windSpeed} m/s`,
        remarks: `官方位置:${typhoon.lat}N, ${typhoon.lon}E (${typhoon.officialPressure})`
      });
    }

  } else if (currentTaskType === "TYPHOON_ROUND_2") {
    const typhoon = activeTyphoons[targetTyphoonIdx];
    let savedCoord = getTyphoonDedicatedCoords(db, typhoon.name, typhoon.lat, typhoon.lon);

    db.typhoonStatus.target = `${typhoon.name} (第2輪-緩衝期)`;
    db.typhoonStatus.currentCoords = savedCoord;
    db.typhoonStatus.officialPressure = typhoon.officialPressure;
    db.typhoonStatus.statusText = `⏳ [緩衝休眠] ⚡ 觸發 🌀${typhoon.name} 的 API 緩衝保護機制。本輪雷達靜默。`;

  } else if (currentTaskType === "TAIWAN") {
    db.typhoonStatus.target = `台灣本島智慧更新輪`;
    db.typhoonStatus.statusText = `🏡 [守護台灣] 任務調度返回本島！對全島大地圖進行智慧 16 點密集修補。`;
    await executeTaiwanGridSelection(db, currentTimeString);
  }

  saveDatabase(db);
}

/**
 * 台灣大地圖更新邏輯
 */
async function executeTaiwanGridSelection(db, currentTimeString) {
  const now = new Date().getTime();
  const candidates = [];

  for (let r = 0; r < LATS.length; r++) {
    for (let c = 0; c < LONS.length; c++) {
      const lat = LATS[r]; const lon = LONS[c];
      const key = `${lat},${lon}`;
      const lastUpdateStr = db.taiwanGrid.updateTime[key] || 0;
      const lastUpdateTime = lastUpdateStr ? new Date(lastUpdateStr).getTime() : 0;
      const timeDiffMinutes = (now - lastUpdateTime) / (1000 * 60);
      const lastWeather = db.taiwanGrid.weather[key] || "";

      let score = timeDiffMinutes * 1.0;
      if (lat >= 23.0 && lat <= 24.5 && lon >= 120.5 && lon <= 121.5) { score += 1; } else { score += 5; }
      if (lastWeather.match(/(雨|雷|暴|風|雪|霾|霧)/i)) { score += 50; }

      candidates.push({ lat, lon, key, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const targetPoints = candidates.slice(0, 16);

  for (const point of targetPoints) {
    let data = await fetchSingleOpenWeather(point.lat, point.lon);
    if (data) {
      const k = point.key;
      db.taiwanGrid.temperature[k] = data.temp;
      db.taiwanGrid.pressure[k] = data.pressure;
      db.taiwanGrid.weather[k] = data.weather;
      db.taiwanGrid.windSpeed[k] = data.windSpeed;
      db.taiwanGrid.windDeg[k] = data.windDeg;
      db.taiwanGrid.rain[k] = data.rain;
      db.taiwanGrid.updateTime[k] = currentTimeString;
      db.taiwanGrid.alert[k] = data.isAlert ? data.fullAlertText : "";
    }
  }
}

async function fetchSingleOpenWeather(lat, lon) {
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OPENWEATHER_API_KEY}&units=metric&lang=zh_tw`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const temp = data.main ? data.main.temp : "";
      const pressure = data.main ? data.main.pressure : 1013;
      const weather = (data.weather && data.weather[0]) ? data.weather[0].description : "";
      const weatherMainId = (data.weather && data.weather[0]) ? data.weather[0].id : 800;
      const windSpeed = data.wind ? data.wind.speed : 0;
      const windDeg = data.wind ? data.wind.deg : "";
      const rain = (data.rain && data.rain['1h']) ? data.rain['1h'] : 0;

      let isAlert = false; let alertMsg = [];
      if (weatherMainId >= 200 && weatherMainId < 300) { isAlert = true; alertMsg.push("【雷雨】"); }
      if (weatherMainId >= 500 && weatherMainId < 600 && rain > 5) { isAlert = true; alertMsg.push(`【大雨:${rain}mm】`); }
      if (windSpeed > 10.8) { isAlert = true; alertMsg.push(`【強風:${windSpeed}m/s】`); }

      return {
        temp, pressure: Number(pressure), weather, windSpeed: Number(windSpeed),
        windDeg, rain, isAlert, fullAlertText: alertMsg.join("") + weather
      };
    }
  } catch (e) {
    console.error(`座標 (${lat}, ${lon}) 查詢異常: `, e);
  }
  return null;
}

async function fetchAllActiveTyphoons() {
  const payload = { allActiveTyphoons: [] };
  try {
    const res = await fetch(CWA_TYPHOON_TRACK_API);
    if (!res.ok) return payload;
    const xmlText = await res.text();

    const parser = new XMLParser({ ignoreAttributes: false });
    const jsonObj = parser.parse(xmlText);

    const records = jsonObj?.cwaopendata?.records;
    if (!records) return payload;

    let cyclones = records?.TropicalCyclones?.TropicalCyclone;
    if (!cyclones) return payload;
    if (!Array.isArray(cyclones)) cyclones = [cyclones];

    for (const cyclone of cyclones) {
      let fixes = cyclone?.AnalysisData?.Fix;
      if (!fixes) continue;
      if (!Array.isArray(fixes)) fixes = [fixes];

      const latestFix = fixes[fixes.length - 1];
      const lat = Number(latestFix.CoordinateLatitude);
      const lon = Number(latestFix.CoordinateLongitude);
      const pressure = latestFix.Pressure || "1000";
      const cwaName = cyclone.CwaTyphoonName || cyclone.TyphoonName;

      payload.allActiveTyphoons.push({ name: cwaName, lat, lon, officialPressure: pressure + " hPa" });
    }
  } catch (e) {
    console.error("XML 解析異常: ", e);
  }
  return payload;
}

function getTyphoonDedicatedCoords(db, name, fallbackLat, fallbackLon) {
  if (db.typhoonMemory[name]) {
    return db.typhoonMemory[name];
  }
  db.typhoonMemory[name] = { lat: fallbackLat, lon: fallbackLon };
  return db.typhoonMemory[name];
}

function saveTyphoonDedicatedCoords(db, name, lat, lon) {
  db.typhoonMemory[name] = { lat, lon };
}

function renderTyphoonRadar5x5View(db, gridCenterLat, gridCenterLon, collectedData, timeStr) {
  const lats = [
    Number((gridCenterLat + 1.0).toFixed(1)),
    Number((gridCenterLat + 0.5).toFixed(1)),
    gridCenterLat,
    Number((gridCenterLat - 0.5).toFixed(1)),
    Number((gridCenterLat - 1.0).toFixed(1))
  ];
  const lons = [
    Number((gridCenterLon - 1.0).toFixed(1)),
    Number((gridCenterLon - 0.5).toFixed(1)),
    gridCenterLon,
    Number((gridCenterLon + 0.5).toFixed(1)),
    Number((gridCenterLon + 1.0).toFixed(1))
  ];

  const gridMatrix = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) {
      let match = collectedData.find(d => d.lat === lats[r] && d.lon === lons[c]);
      row.push(match ? { pressure: match.pressure, windSpeed: match.windSpeed } : null);
    }
    gridMatrix.push(row);
  }

  db.radar5x5 = {
    center: { lat: gridCenterLat, lon: gridCenterLon },
    lats,
    lons,
    grid: gridMatrix,
    lastUpdate: timeStr
  };
}

updateTaiwanWeatherSystem().catch(console.error);
