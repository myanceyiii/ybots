# Sheldon's silo: one bot's Hermes agent, screen, browser and files in an unprivileged container.
# Design and rules: docs/sheldon-silo.md. Built and started by compose.yaml next to this file.
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
# microsoft-edge (default), google-chrome or none. The ChatGPT desktop app for Linux is added by hand later (see the doc).
ARG BROWSER=microsoft-edge
# Hermes release to install: empty = the latest stable release. Pin it to match the rest of the team.
ARG HERMES_COMMIT=
ARG HERMES_INSTALLER=https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh
ARG SILO_UID=10101

# Extra CA certificates for a build behind a TLS-inspecting proxy (ca/*.crt; none in the repo).
COPY ca/ /usr/local/share/ca-certificates/silo/

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 python3-yaml tini libatomic1 openssl \
      xvfb x11vnc openbox xterm x11-utils xauth dbus-x11 \
      fonts-dejavu fonts-liberation fonts-noto-color-emoji \
      gnupg procps less nano \
 && update-ca-certificates \
 && case "$BROWSER" in \
      google-chrome) \
        curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
        && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
        && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable ;; \
      microsoft-edge) \
        curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft-edge.gpg \
        && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-edge.gpg] https://packages.microsoft.com/repos/edge stable main" > /etc/apt/sources.list.d/microsoft-edge.list \
        && apt-get update && apt-get install -y --no-install-recommends microsoft-edge-stable ;; \
      none) ;; \
      *) echo "unknown BROWSER=$BROWSER (microsoft-edge, google-chrome or none)" >&2; exit 1 ;; \
    esac \
 && rm -rf /var/lib/apt/lists/*

# The bot's own account. No sudo, no password, no extra groups.
RUN useradd --uid "$SILO_UID" --user-group --home-dir /data/home --no-create-home --shell /bin/bash sheldon \
 && mkdir -p /opt/hermes && chown sheldon:sheldon /opt/hermes

# Hermes' code and runtimes live in the image (owned by the bot's user, because Hermes keeps
# lock and state files beside its install); its home, with memory, skills and sign-ins, lives
# on the encrypted volume at /data/hermes.
USER sheldon
ENV HOME=/opt/hermes \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    UV_NATIVE_TLS=1
RUN curl -fsSL "$HERMES_INSTALLER" -o /tmp/hermes-install.sh \
 && bash /tmp/hermes-install.sh --non-interactive --skip-browser \
      --dir /opt/hermes/hermes-agent --hermes-home /opt/hermes/home-template \
      ${HERMES_COMMIT:+--commit "$HERMES_COMMIT"} \
 && rm -rf /tmp/hermes-install.sh /opt/hermes/home-template/cache /opt/hermes/home-template/logs/* \
 && /opt/hermes/.local/bin/hermes --version

USER root
COPY --chmod=0755 entrypoint.sh /usr/local/bin/silo-entrypoint
COPY --chmod=0644 openbox-menu.xml /etc/xdg/openbox/menu.xml
# The app's approval gate for Hermes' own tools (server/hermes-plugins/cleft-bot-gate), passed in
# as the named build context "gate-plugin" (compose.yaml does this).
COPY --from=gate-plugin plugin.yaml __init__.py /opt/cleft-bot-gate/
RUN chmod 0755 /opt/cleft-bot-gate && chmod 0644 /opt/cleft-bot-gate/*

USER sheldon
ENV HOME=/data/home \
    HERMES_HOME=/data/hermes \
    PATH=/opt/hermes/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DISPLAY=:1 \
    LANG=C.UTF-8
WORKDIR /tmp
EXPOSE 8642 5900
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/silo-entrypoint"]
