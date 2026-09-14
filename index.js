const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// ==================== 環境變數讀取 ====================
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '';

// 氣象署熱帶氣旋 API
const CWA_TYPHOON_TRACK_API = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005?Authorization=CWB-172CF677-D022-4A92-B9C9-0AFADC2D08E5&format=XML";

// 台灣固定地圖經緯度配置
const LAT_START = 21.0; const LAT_END = 26.0; const LAT_STEP = 0.5;
const LON_START = 119.0; const LON_END = 123.0; const LON_STEP = 0.5;

const LATS = []; for (let lat = LAT_START; lat <= LAT_END; lat += LAT_STEP) { LATS.push(Number(lat.toFixed(1))); } LATS.reverse();
const LONS = []; for (let lon = LON_START; lon <= LON_END; lon += LON_STEP) { LONS.push(Number(lon.toFixed(1))); }

const GRID_SHEETS = ["溫度", "大氣壓力", "天氣狀況", "風速", "風向", "降雨機率", "更新時間", "惡劣天氣警告"];

// ==================== 核心主程式 ====================
async function main() {
  try {
    // 1. 初始化 Google 試算表連線
    const serviceAccountAuth = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    // 2. 初始化工作表
    await initTaiwanSheets(doc);
    await initMultiTyphoonTrackSheet(doc);

    const tSheet = doc.sheetsByTitle["颱風追蹤"];
    await tSheet.loadCells("A1:J25");

    const currentTimeString = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

    // 3. 抓取目前所有活耀颱風
    const typhoonPayload = await fetchAllActiveTyphoons();
    const activeTyphoons = typhoonPayload.allActiveTyphoons;
    const n = activeTyphoons.length;

    // 4. 無颱風時留守台灣
    if (n === 0) {
      tSheet.getCellByA1("B1").value = "NO";
      tSheet.getCellByA1("B2").value = "無";
      tSheet.getCellByA1("B3").value = "";
      tSheet.getCellByA1("B4").value = "";
      tSheet.getCellByA1("B7").value = 0;
      tSheet.getCellByA1("A6").value = "🏡 目前洋面安全，雷達全天候留守台灣本島大地圖。";
      await tSheet.saveUpdatedCells();

      await executeTaiwanGridSelection(doc, currentTimeString);
      console.log("任務完成：無颱風，已更新台灣本島氣象網格。");
      return;
    }

    // 5. 調度演算法 (2n : n 佇列)
    const totalSlots = 3 * n;
    let currentStep = parseInt(tSheet.getCellByA1("B7").value || 0, 10);
    if (currentStep >= totalSlots) { currentStep = 0; }

    tSheet.getCellByA1("B1").value = "YES";

    let currentTaskType = "";
    let targetTyphoonIdx = -1;

    if (currentStep < 2 * n) {
      targetTyphoonIdx = Math.floor(currentStep / 2);
      currentTaskType = (currentStep % 2 === 0) ? "TYPHOON_ROUND_1" : "TYPHOON_ROUND_2";
    } else {
      currentTaskType = "TAIWAN";
    }

    let nextStep = currentStep + 1;
    if (nextStep >= totalSlots) { nextStep = 0; }
    tSheet.getCellByA1("B7").value = nextStep;

    // 6. 執行分流
    if (currentTaskType === "TYPHOON_ROUND_1") {
      const typhoon = activeTyphoons[targetTyphoonIdx];
      tSheet.getCellByA1("B2").value = `${typhoon.name} (第1輪-觀測期)`;

      let savedCoord = getTyphoonDedicatedCoords(tSheet, typhoon.name, typhoon.lat, typhoon.lon);
      tSheet.getCellByA1("B3").value = savedCoord.lat;
      tSheet.getCellByA1("B4").value = savedCoord.lon;
      tSheet.getCellByA1("B5").value = typhoon.officialPressure;

      const gridCenterLat = Math.round(savedCoord.lat * 2) / 2;
      const gridCenterLon = Math.round(savedCoord.lon * 2) / 2;

      tSheet.getCellByA1("A6").value = `🛰️ [5x5全面搜索] 鎖定 🌀${typhoon.name}。專屬準星:(${savedCoord.lat}, ${savedCoord.lon}) -> 打點對齊:(${gridCenterLat}, ${gridCenterLon})`;

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
        let minPressure = 9999;
        collectedData.forEach(d => { if (d.pressure < minPressure) { minPressure = d.pressure; } });

        let candidates = collectedData.filter(d => Math.abs(d.pressure - minPressure) <= 1.5);
        let eyeGrid = candidates[0];
        let minWind = eyeGrid.windSpeed;
        candidates.forEach(c => { if (c.windSpeed < minWind) { minWind = c.windSpeed; eyeGrid = c; } });

        const estLat = Number(((gridCenterLat + eyeGrid.lat) / 2).toFixed(2));
        const estLon = Number(((gridCenterLon + eyeGrid.lon) / 2).toFixed(2));

        saveTyphoonDedicatedCoords(tSheet, typhoon.name, estLat, estLon);

        tSheet.getCellByA1("B3").value = estLat;
        tSheet.getCellByA1("B4").value = estLon;
        tSheet.getCellByA1("B6").value = `🎯 特徵識別成功！🌀${typhoon.name} 新中心：(${estLat}N, ${estLon}E)`;

        renderTyphoonRadar5x5View(tSheet, gridCenterLat, gridCenterLon, collectedData, currentTimeString);
        await tSheet.saveUpdatedCells();

        await recordTyphoonEyeHistory(tSheet, currentTimeString, typhoon.name, estLat, estLon, eyeGrid.pressure, eyeGrid.windSpeed, `官方位置:${typhoon.lat}N, ${typhoon.lon}E (${typhoon.officialPressure})`);
      }

    } else if (currentTaskType === "TYPHOON_ROUND_2") {
      const typhoon = activeTyphoons[targetTyphoonIdx];
      tSheet.getCellByA1("B2").value = `${typhoon.name} (第2輪-緩衝期)`;
      tSheet.getCellByA1("A6").value = `⏳ [緩衝休眠] ⚡ 觸發 🌀${typhoon.name} 的 API 緩衝保護機制。`;

      let savedCoord = getTyphoonDedicatedCoords(tSheet, typhoon.name, typhoon.lat, typhoon.lon);
      tSheet.getCellByA1("B3").value = savedCoord.lat;
      tSheet.getCellByA1("B4").value = savedCoord.lon;
      tSheet.getCellByA1("B5").value = typhoon.officialPressure;
      await tSheet.saveUpdatedCells();

    } else if (currentTaskType === "TAIWAN") {
      tSheet.getCellByA1("B2").value = `台灣本島智慧更新輪`;
      tSheet.getCellByA1("A6").value = `🏡 [守護台灣] 任務調度返回本島！進行智慧 16 點密集修補。`;
      await tSheet.saveUpdatedCells();

      await executeTaiwanGridSelection(doc, currentTimeString);
    }

    console.log("全套氣象任務執行完畢！");
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

    const records = jsonObj?.cwaopendata?.records;
    if (!records) return payload;

    let cyclones = records?.TropicalCyclones?.TropicalCyclone;
    if (!cyclones) return payload;

    if (!Array.isArray(cyclones)) cyclones = [cyclones];

    for (const cyclone of cyclones) {
      const analysisData = cyclone.AnalysisData;
      if (!analysisData) continue;

      let fixList = analysisData.Fix;
      if (!fixList) continue;
      if (!Array.isArray(fixList)) fixList = [fixList];

      const latestFix = fixList[fixList.length - 1];
      const lat = Number(latestFix.CoordinateLatitude);
      const lon = Number(latestFix.CoordinateLongitude);
      const pressure = latestFix.Pressure || "1000";
      const cwaName = cyclone.CwaTyphoonName || cyclone.TyphoonName;

      payload.allActiveTyphoons.push({ name: cwaName, lat, lon, officialPressure: pressure + " hPa" });
    }
  } catch (e) {
    console.log("CWA XML 解析異常:", e.message);
  }
  return payload;
}

async function executeTaiwanGridSelection(doc, currentTimeString) {
  const timeSheet = doc.sheetsByTitle["更新時間"];
  const weatherSheet = doc.sheetsByTitle["天氣狀況"];

  await timeSheet.loadCells();
  await weatherSheet.loadCells();

  const now = new Date().getTime();
  const candidates = [];

  for (let r = 0; r < LATS.length; r++) {
    for (let c = 0; c < LONS.length; c++) {
      const lat = LATS[r]; const lon = LONS[c];
      const lastUpdateCell = timeSheet.getCell(r + 1, c + 1).value;
      const lastUpdateTime = lastUpdateCell ? new Date(lastUpdateCell).getTime() : 0;
      const timeDiffMinutes = (now - lastUpdateTime) / (1000 * 60);

      const lastWeatherCell = weatherSheet.getCell(r + 1, c + 1).value || "";

      let score = timeDiffMinutes * 1.0;
      if (lat >= 23.0 && lat <= 24.5 && lon >= 120.5 && lon <= 121.5) { score += 1; } else { score += 5; }
      if (String(lastWeatherCell).match(/(雨|雷|暴|風|雪|霾|霧)/i)) { score += 50; }

      candidates.push({ lat, lon, rowIdx: r + 1, colIdx: c + 1, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const targetPoints = candidates.slice(0, 16);

  for (const point of targetPoints) {
    let data = await fetchSingleOpenWeather(point.lat, point.lon);
    if (data) {
      const tempSheet = doc.sheetsByTitle["溫度"];
      const pressureSheet = doc.sheetsByTitle["大氣壓力"];
      const weatherSheetObj = doc.sheetsByTitle["天氣狀況"];
      const windSpeedSheet = doc.sheetsByTitle["風速"];
      const windDegSheet = doc.sheetsByTitle["風向"];
      const rainSheet = doc.sheetsByTitle["降雨機率"];
      const alertSheet = doc.sheetsByTitle["惡劣天氣警告"];

      await Promise.all([
        tempSheet.loadCells(), pressureSheet.loadCells(), weatherSheetObj.loadCells(),
        windSpeedSheet.loadCells(), windDegSheet.loadCells(), rainSheet.loadCells(),
        timeSheet.loadCells(), alertSheet.loadCells()
      ]);

      tempSheet.getCell(point.rowIdx, point.colIdx).value = data.temp;
      pressureSheet.getCell(point.rowIdx, point.colIdx).value = data.pressure;
      weatherSheetObj.getCell(point.rowIdx, point.colIdx).value = data.weather;
      windSpeedSheet.getCell(point.rowIdx, point.colIdx).value = data.windSpeed;
      windDegSheet.getCell(point.rowIdx, point.colIdx).value = data.windDeg;
      rainSheet.getCell(point.rowIdx, point.colIdx).value = data.rain;
      timeSheet.getCell(point.rowIdx, point.colIdx).value = currentTimeString;

      if (data.isAlert) {
        alertSheet.getCell(point.rowIdx, point.colIdx).value = data.fullAlertText;
      } else {
        alertSheet.getCell(point.rowIdx, point.colIdx).value = "";
      }

      await Promise.all([
        tempSheet.saveUpdatedCells(), pressureSheet.saveUpdatedCells(), weatherSheetObj.saveUpdatedCells(),
        windSpeedSheet.saveUpdatedCells(), windDegSheet.saveUpdatedCells(), rainSheet.saveUpdatedCells(),
        timeSheet.saveUpdatedCells(), alertSheet.saveUpdatedCells()
      ]);
    }
  }
}

function getTyphoonDedicatedCoords(sheet, name, fallbackLat, fallbackLon) {
  for (let r = 1; r < 10; r++) {
    let nameCell = sheet.getCell(r, 7).value; // H 欄 (Index 7)
    if (nameCell === name) {
      let lat = Number(sheet.getCell(r, 8).value);
      let lon = Number(sheet.getCell(r, 9).value);
      if (!isNaN(lat) && !isNaN(lon) && lat !== 0) {
        return { lat, lon };
      }
    }
  }
  saveTyphoonDedicatedCoords(sheet, name, fallbackLat, fallbackLon);
  return { lat: fallbackLat, lon: fallbackLon };
}

function saveTyphoonDedicatedCoords(sheet, name, lat, lon) {
  for (let r = 1; r < 10; r++) {
    let nameCell = sheet.getCell(r, 7).value;
    if (nameCell === name || !nameCell) {
      sheet.getCell(r, 7).value = name;
      sheet.getCell(r, 8).value = lat;
      sheet.getCell(r, 9).value = lon;
      break;
    }
  }
}

function renderTyphoonRadar5x5View(sheet, gridCenterLat, gridCenterLon, collectedData, timeStr) {
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

  lons.forEach((lon, idx) => { sheet.getCell(9, idx + 1).value = lon + "°E"; });
  lats.forEach((lat, idx) => { sheet.getCell(idx + 10, 0).value = lat + "°N"; });

  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      let match = collectedData.find(d => d.lat === lats[r] && d.lon === lons[c]);
      let cell = sheet.getCell(r + 10, c + 1);
      if (match) {
        cell.value = `${match.pressure}hPa\n風:${match.windSpeed}m/s`;
      } else {
        cell.value = "---";
      }
    }
  }
  sheet.getCellByA1("B16").value = timeStr;
}

async function recordTyphoonEyeHistory(sheet, timeStr, name, estLat, estLon, eyePressure, eyeWind, remarks) {
  await sheet.addRow([
    timeStr, name, estLat, estLon, `${eyePressure} hPa`, `${eyeWind} m/s`, remarks
  ]);
}

async function initTaiwanSheets(doc) {
  for (const name of GRID_SHEETS) {
    let sheet = doc.sheetsByTitle[name];
    if (!sheet) {
      sheet = await doc.addSheet({ title: name });
    }
    await sheet.loadCells("A1:I15");
    if (!sheet.getCell(0, 0).value) {
      sheet.getCell(0, 0).value = "緯度 ＼ 經度";
      LONS.forEach((lon, idx) => { sheet.getCell(0, idx + 1).value = lon; });
      LATS.forEach((lat, idx) => { sheet.getCell(idx + 1, 0).value = lat; });
      await sheet.saveUpdatedCells();
    }
  }
}

async function initMultiTyphoonTrackSheet(doc) {
  let sheet = doc.sheetsByTitle["颱風追蹤"];
  if (!sheet) {
    sheet = await doc.addSheet({ title: "颱風追蹤" });
    await sheet.loadCells("A1:J25");

    sheet.getCellByA1("A1").value = "是否有颱風活動:"; sheet.getCellByA1("B1").value = "NO";
    sheet.getCellByA1("A2").value = "當前雷達獵殺目標:"; sheet.getCellByA1("B2").value = "無";
    sheet.getCellByA1("A3").value = "自主推估中心緯度(高精度):"; sheet.getCellByA1("B3").value = "";
    sheet.getCellByA1("A4").value = "自主推估中心經度(高精度):"; sheet.getCellByA1("B4").value = "";
    sheet.getCellByA1("A5").value = "官方公告參考氣壓:"; sheet.getCellByA1("B5").value = "";
    sheet.getCellByA1("A6").value = "🛰️ 雷達物理特徵與追蹤結果:"; sheet.getCellByA1("B6").value = "";
    sheet.getCellByA1("A7").value = "佇列記憶體-目前執行 Slot 步數:"; sheet.getCellByA1("B7").value = "0";

    sheet.getCellByA1("H1").value = "🌀 多颱風獨立記憶體(隔離用)";
    sheet.getCellByA1("I1").value = "記憶緯度";
    sheet.getCellByA1("J1").value = "記憶經度";

    sheet.getCellByA1("A9").value = "🛰️ 颱風中心周圍 5x5 全面搜索雷達監視窗（對齊 0.0/.5 網格）";
    sheet.getCellByA1("A10").value = "緯度 ＼ 經度";
    sheet.getCellByA1("A16").value = "行動雷達最後刷新時間:";

    sheet.getCellByA1("A19").value = "--- 全局多軌熱帶氣旋大氣特徵科學觀測長效歷史紀錄 ---";
    await sheet.saveUpdatedCells();

    await sheet.setHeaderRow(["觀測時間", "氣旋名稱", "推估中心緯度", "推估中心經度", "實測中心氣壓", "實測眼區風速", "探針追蹤備註"], 20);
  }
}

main();
