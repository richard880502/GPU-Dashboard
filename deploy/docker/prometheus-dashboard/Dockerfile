# Bakes in the scrape config + alert rules so a fresh machine just needs
# `docker pull` + `docker run` (or a bare docker-compose.yml referencing this
# image) -- no repo checkout needed for Prometheus's own config.
#
# Runtime flags (retention, data path) still come from docker-compose.yml's
# `command:`, not from this image, since those vary per deployment.
#
# Build from the REPO ROOT (not this directory), so the single source of
# truth for prometheus.yml/rules stays under prometheus/, not duplicated here:
#   docker build -f deploy/docker/prometheus-dashboard/Dockerfile -t ... .
FROM prom/prometheus:latest
COPY prometheus/prometheus.yml /etc/prometheus/prometheus.yml
COPY prometheus/rules /etc/prometheus/rules
