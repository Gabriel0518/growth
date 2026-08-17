const https = require('https');

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const SHEET_TOKEN = 'TVBxsh8kGhHqEBtgeI5c4x5On3V';
const SHEET_ID = '3YBe2k';  // AF收入 sheet
const API_BASE = 'https://open.feishu.cn/open-apis';

// Product order in sheet columns (after "时间"):
// GraceChat, Dora And, Dora iOS, Doni, Romi iOS, Luma, Jovia And, Romi And, 汇总
const PRODUCT_ORDER = [
  'GraceChat',
  'Dora And',
  'Dora iOS',
  'Doni',
  'Romi iOS',
  'Luma',
  'Jovia And',
  'Romi And',
];

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getToken() {
  const res = await request('POST', '/auth/v3/tenant_access_token/internal', {
    app_id: APP_ID,
    app_secret: APP_SECRET,
  });
  if (!res.tenant_access_token) throw new Error('Failed to get token: ' + JSON.stringify(res));
  return res.tenant_access_token;
}

function parseNumber(str) {
  if (!str || str === 'N/A' || str === 'Error') return 0;
  return parseFloat(String(str).replace(/[$,+]/g, '')) || 0;
}

function formatMoney(n) {
  const sign = n >= 0 ? '+$' : '-$';
  return sign + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function run() {
  const jsonData = JSON.parse(process.argv[2]);
  const timeLabel = process.argv[3];

  const token = await getToken();

  // Step 1: Read current row 3 (the previous latest data row).
  // Row 2 is blank; row 3 is most recent data; row 4 is diff.
  const readRes = await request('GET',
    `/sheets/v2/spreadsheets/${SHEET_TOKEN}/values/${SHEET_ID}!A3:S3`,
    null, token);

  let prevRow = null;
  if (readRes.code === 0 && readRes.data?.valueRange?.values?.[0]) {
    const r = readRes.data.valueRange.values[0];
    if (r[0] && String(r[0]) !== '增量' && r[0] !== null) {
      prevRow = r;
    }
  }

  // Step 2: Insert 3 blank rows at row 2
  const insertRes = await request('POST',
    `/sheets/v2/spreadsheets/${SHEET_TOKEN}/insert_dimension_range`,
    {
      dimension: {
        sheetId: SHEET_ID,
        majorDimension: 'ROWS',
        startIndex: 1,
        endIndex: 4,
      },
      inheritStyle: 'AFTER',
    }, token);

  if (insertRes.code !== 0) {
    console.error('Insert rows failed:', JSON.stringify(insertRes));
    process.exit(1);
  }
  console.log('Inserted 3 rows');

  // Step 3: Build data row
  // Filter out "Totals" row
  const productMap = {};
  for (const item of jsonData) {
    if (item.product === 'Totals') continue;
    productMap[item.product] = item;
  }

  let totalActual = 0;
  let totalLTV = 0;
  const newRow = [timeLabel];
  const newRowNums = [0];

  for (const name of PRODUCT_ORDER) {
    const item = productMap[name] || {};
    const actual = parseNumber(item.revenueActual);
    const ltv = parseNumber(item.revenueLTV);
    totalActual += actual;
    totalLTV += ltv;
    newRow.push(item.revenueActual || 'N/A');
    newRow.push(item.revenueLTV || 'N/A');
    newRowNums.push(actual);
    newRowNums.push(ltv);
  }

  newRow.push('$' + totalActual.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  newRow.push('$' + totalLTV.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  newRowNums.push(totalActual);
  newRowNums.push(totalLTV);

  // Step 4: Build diff row
  const diffRow = ['增量'];

  if (prevRow) {
    for (let i = 1; i < 19; i++) {
      const newVal = newRowNums[i];
      const prevVal = parseNumber(String(prevRow[i] || '0'));
      diffRow.push(formatMoney(newVal - prevVal));
    }
  } else {
    for (let i = 0; i < 18; i++) {
      diffRow.push('-');
    }
  }

  // Step 5: Write row 3 (data) and row 4 (diff). Row 2 stays blank.
  const writeRes = await request('PUT',
    `/sheets/v2/spreadsheets/${SHEET_TOKEN}/values`,
    {
      valueRange: {
        range: `${SHEET_ID}!A3:S4`,
        values: [newRow, diffRow],
      },
    }, token);

  if (writeRes.code !== 0) {
    console.error('Write failed:', JSON.stringify(writeRes));
    process.exit(1);
  }

  // Integrity check
  const verifyRes = await request('GET',
    `/sheets/v2/spreadsheets/${SHEET_TOKEN}/values/${SHEET_ID}!A5:A5`,
    null, token);

  if (verifyRes.code === 0 && verifyRes.data?.valueRange?.values?.[0]) {
    const row5Label = verifyRes.data.valueRange.values[0][0];
    if (prevRow && (!row5Label || String(row5Label).trim() === '')) {
      console.error('WARNING: Row 5 is empty! Previous data may have been lost.');
    } else {
      console.log('Integrity check passed: Row 5 =', row5Label);
    }
  }

  console.log('AF sheet updated successfully');
  console.log('Data row:', newRow.join(' | '));
  console.log('Diff row:', diffRow.join(' | '));
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
