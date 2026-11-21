# The agent image as an agent's Cloudflare Container runs it: the normal agent image, plus the
# cf-workspace-server that the container starts with. It restores /workspace, which starts empty
# there, then runs gamut-start (../objects/cloudflare-agent.ts). `npm run deploy:cf` builds the
# normal image under this tag first.
ARG AGENT_IMAGE=superagent-container:linux-amd64
FROM ${AGENT_IMAGE}

COPY --chown=claude:claude cf-workspace-server.mjs cf-workspace-service.mjs workspace-scan.mjs /opt/gamut/cloudflare/

# Container.start() cannot pick a user, so the image starts as root: gamut-start opens /dev/fuse
# for FUSE mounts, then drops to claude.
USER root
