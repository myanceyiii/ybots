# The silo's gate: Sheldon's only way out (an HTTPS allow-list proxy) and the only way in
# (the agent's API and the live view, published on the host's loopback by compose.yaml).
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends tinyproxy socat tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10102 --user-group --no-create-home --shell /usr/sbin/nologin gate \
 && install -d -m 0755 /etc/silo
# COPY makes a missing parent folder with the builder's umask (0700 on Host2), which the gate user can't enter.
COPY --chmod=0755 entrypoint.sh /usr/local/bin/gate-entrypoint
COPY --chmod=0644 denylist /etc/silo/denylist
USER gate
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/gate-entrypoint"]
