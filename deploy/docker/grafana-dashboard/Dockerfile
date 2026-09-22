# Bakes in the datasource + dashboard provisioning (including our hand-built
# cluster-overview.json) so a fresh machine doesn't need this repo checked
# out to get the same dashboard.
#
# Admin password / anonymous-access / refresh-interval settings are NOT
# baked in here -- those stay as env vars in docker-compose.yml, since a
# password belongs in a runtime secret, not a public image.
#
# Build from the REPO ROOT:
#   docker build -f deploy/docker/grafana-dashboard/Dockerfile -t ... .
FROM grafana/grafana:latest
COPY grafana/provisioning /etc/grafana/provisioning
