FROM python:3.11-slim
ARG TARGETARCH
# crictl: talks to containerd's CRI socket to attribute GPU processes to
# Kubernetes pods/containers, which aren't visible on the Docker socket at
# all under the (normal, current) containerd/CRI-O runtime setup.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && CRICTL_VERSION=v1.31.1 \
    && curl -fsSL "https://github.com/kubernetes-sigs/cri-tools/releases/download/${CRICTL_VERSION}/crictl-${CRICTL_VERSION}-linux-${TARGETARCH}.tar.gz" \
       | tar -xz -C /usr/local/bin \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir prometheus-client docker
COPY gpu_process_exporter.py /app/gpu_process_exporter.py
ENTRYPOINT ["python3", "/app/gpu_process_exporter.py"]
