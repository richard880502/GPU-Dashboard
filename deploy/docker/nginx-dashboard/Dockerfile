# Bakes in the reverse-proxy config so a fresh machine doesn't need this
# repo checked out for the routing rules.
#
# Build from the REPO ROOT:
#   docker build -f deploy/docker/nginx-dashboard/Dockerfile -t ... .
FROM nginx:latest
COPY nginx/nginx.conf /etc/nginx/nginx.conf
