# `agx gateway` in a container: the published CLI, run as an unprivileged
# user, with the profile — identity, API keys, subscriptions, inbox state — on
# a volume. See README.md here for setup.
#
#   docker build -t agx-gateway deploy/gateway
#
# Put a TLS proxy in front (compose.yaml does, with Caddy): the gateway itself
# speaks plain HTTP.

ARG BASE_IMAGE=node:22-alpine
FROM ${BASE_IMAGE}

# The CLI release to install; kept equal to packages/cli's version by its tests.
ARG AGX_PACKAGE=@nostr-agx/cli@0.6.0

RUN npm install --global --omit=dev --no-audit --no-fund "${AGX_PACKAGE}" \
	&& npm cache clean --force \
	&& mkdir -p /data \
	&& chown node:node /data

ENV AGX_HOME=/data \
	NODE_ENV=production

USER node
VOLUME ["/data"]
EXPOSE 8787

# Healthy once the gateway has polled its relays lately (see /v1/health).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:8787/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# `agx` itself, so one-off commands run in the same image:
#   docker compose run --rm gateway identity new
ENTRYPOINT ["agx"]
CMD ["gateway", "--host", "0.0.0.0", "--port", "8787"]
