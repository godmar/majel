# Egress allowlist proxy: the only route off the cluster for agent pods.
# No dependencies beyond the Node standard library, so there is nothing to
# install and nothing to keep patched but the base image.
FROM node:24-slim

# The node images ship an unprivileged "node" user (uid 1000); there is
# already a "proxy" account, so do not try to add one.
USER node

COPY proxy.mjs /opt/egress-proxy/proxy.mjs

EXPOSE 3128
ENTRYPOINT ["node", "/opt/egress-proxy/proxy.mjs"]
