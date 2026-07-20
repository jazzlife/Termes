FROM nousresearch/hermes-agent@sha256:2633f69c5fc332b6ed1140bf05643a271e5c3246142997ed2f0b78d153e00af9

ARG HERMES_SOURCE_REPOSITORY=https://github.com/realfishsam/hermes-agent.git
ARG HERMES_SOURCE_COMMIT=7fb875451bcef8c379ece6779c6b147eef42c05d
ARG CODEX_VERSION=0.144.1
ARG CODEX_INSTALL_REVISION=2

# The published image is only a system-dependency/bootstrap layer. Replace all
# application source and language dependencies with the exact repository commit
# that Termes manifests and reducers were generated from.
RUN set -eux; \
    mv /opt/hermes/.playwright /tmp/hermes-playwright; \
    cd /; \
    rm -rf /opt/hermes; \
    git clone --filter=blob:none --no-checkout "${HERMES_SOURCE_REPOSITORY}" /opt/hermes; \
    cd /opt/hermes; \
    git fetch --depth 1 origin "${HERMES_SOURCE_COMMIT}"; \
    git checkout --detach "${HERMES_SOURCE_COMMIT}"; \
    test "$(git rev-parse HEAD)" = "${HERMES_SOURCE_COMMIT}"; \
    rm -rf .git; \
    mv /tmp/hermes-playwright /opt/hermes/.playwright; \
    uv sync --frozen --extra all --extra messaging --extra anthropic --extra bedrock --extra azure-identity --extra hindsight --extra matrix; \
    npm install --prefer-offline --no-audit; \
    cd /opt/hermes/web; \
    npm run build; \
    cd /opt/hermes/ui-tui; \
    npm run build; \
    cd /opt/hermes; \
    uv pip install --no-cache-dir --no-deps -e .; \
    rm -rf /etc/s6-overlay/s6-rc.d; \
    cp -a docker/s6-rc.d /etc/s6-overlay/s6-rc.d; \
    install -m 0755 docker/cont-init.d/015-supervise-perms /etc/cont-init.d/015-supervise-perms; \
    install -m 0755 docker/cont-init.d/02-reconcile-profiles /etc/cont-init.d/02-reconcile-profiles; \
    printf '#!/command/with-contenv sh\nexec /opt/hermes/docker/stage2-hook.sh\n' > /etc/cont-init.d/01-hermes-setup; \
    chmod 0755 /etc/cont-init.d/01-hermes-setup; \
    mkdir -p /opt/hermes/bin; \
    install -m 0755 /opt/hermes/docker/hermes-exec-shim.sh /opt/hermes/bin/hermes; \
    printf '%s\n' "${HERMES_SOURCE_COMMIT}" > /opt/hermes/.hermes_build_sha; \
    printf 'docker\n' > /opt/hermes/.install_method

RUN npm install -g "@openai/codex@${CODEX_VERSION}" && npm cache clean --force
RUN test -s /usr/local/lib/node_modules/@openai/codex/package.json && \
    test "$(codex --version)" = "codex-cli ${CODEX_VERSION}" && \
    test -n "${CODEX_INSTALL_REVISION}"
COPY infra/hermes-agent/patch_codex_runtime.py /tmp/patch_codex_runtime.py
RUN python /tmp/patch_codex_runtime.py && rm /tmp/patch_codex_runtime.py
COPY infra/hermes-agent/014-termes-codex-home /etc/cont-init.d/014-termes-codex-home
RUN chmod 0755 /etc/cont-init.d/014-termes-codex-home
RUN mkdir -p /etc/s6-overlay/s6-rc.d/user/contents.d /etc/s6-overlay/s6-rc.d/user2/contents.d && \
    printf 'bundle\n' > /etc/s6-overlay/s6-rc.d/user/type && \
    printf 'bundle\n' > /etc/s6-overlay/s6-rc.d/user2/type

ENV HOME=/opt/data
ENV CODEX_HOME=/opt/data/.codex
ENV HERMES_HOME=/opt/data
ENV HERMES_CODEX_APP_SERVER_INIT_TIMEOUT_SECONDS=90
