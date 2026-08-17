const https = require('https');

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const SHEET_TOKEN = 'TVBxsh8kGhHqEBtgeI5c4x5On3V';
const SHEET_ID = '2wOGK4';  // XMP消耗 sheet
const API_BASE = 'https://open.feishu.cn/open-apis';

// Product order in sheet columns (after "时间"):
// GraceChat, Dora And, Dora iOS, Doni, Romi iOS, Luma, Jovia And, Romi And, 汇总
const PRODUCT_ORDER = [
  'GraceChat',
  'Dora And',
  'Dora',        // displayed as Dora iOS
  'Doni',
  'Romi',        // displayed as Romi iOS
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
  return parseFloat(String(str).replace(/[$,+USD\s]/g, '')) || 0;
}

function formatMoney(n) {
  const sign = n >= 0 ? '+$' : '-$';
  return sign + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCost(n) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function run() {
  const jsonData = JSON.parse(process.argv[2]);
  const timeLabel = process.argv[3];

  const token = await getToken();

  // Step 1: Read current row 3 (previous latest data)
  // Row 2 is blank; row 3 is most recent data; row 4 is diff.
  const readRes = await request('GET',
    `/sheets/v2/spreadsheets/${SHEET_TOKEN}/values/${SHEET_ID}!A3:J3`,
    null, token);

  let prevRow = null;
  if (readRes.code === 0 && readRes.data?.valueRange?.values?.[0]) {
    const r = readRes.data.valueRange.values[0];
    if (r[0] && String(r[0]) !== '增量' && r[0] !== null) {
      prevRow = r;
    }
  }

  // Step 2: Insert 3 blank rows at row 2
  // New structure: Row2=blank, Row3=new data, Row4=diff, Row5+=previous data
  const insertRes = await request('POST',
    `/sheets/v2/spreadsheets/${SHEET_TOKEN}/insert_dimension_range`,
    {
      dimension: {
        sheetId: SHEET_ID,
        majorDimension: 'ROWS',
        startIndex: 1,  // 0-based: after header
        endIndex: 4,    // insert 3 rows
      },
      inheritStyle: 'AFTER',
    }, token);

  if (insertRes.code !== 0) {
    console.error('Insert rows failed:', JSON.stringify(insertRes));
    process.exit(1);
  }
  console.log('Inserted 3 rows');

  // Step 3: Build data row
  const productMap = {};
  for (const item of jsonData) {
    productMap[item.product] = item;
  }

  let totalCost = 0;
  const newRow = [timeLabel];
  const newRowNums = [0];

  for (const name of PRODUCT_ORDER) {
    const item = productMap[name] || {};
    const cost = parseNumber(item.cost);
    totalCost += cost;
    newRow.push(formatCost(cost));
    newRowNums.push(cost);
  }

  newRow.push(formatCost(totalCost));
  newRowNums.push(totalCost);

  // Step 4: Build diff row
  const diffRow = ['增量'];

  if (prevRow) {
    for (let i = 1; i <= 9; i++) {
      const newVal = newRowNums[i];
      const prevVal = parseNumber(String(prevRow[i] || '0'));
      diffRow.push(formatMoney(newVal - prevVal));
    }
  } else {
    for (let i = 0; i < 9; i++) {
      diffRow.push('-');
    }
  }

  // Step 5: Write row 3 (data) and row 4 (diff). Row 2 stays blank.
  // IMPORTANT: Only write to A3:J4 - the newly inserted rows.
  const writeRes = await request('PUT',
    `/sheets/v2/spreadsheets/${SHEET_TOKEN}/values`,
    {
      valueRange: {
        range: `${SHEET_ID}!A3:J4`,
        values: [newRow, diffRow],
      },
    }, token);

  if (writeRes.code !== 0) {
    console.error('Write failed:', JSON.stringify(writeRes));
    process.exit(1);
  }

  // Integrity check: verify row 5 still has previous data
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

  console.log('XMP sheet updated successfully');
  console.log('Data row:', newRow.join(' | '));
  console.log('Diff row:', diffRow.join(' | '));
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
