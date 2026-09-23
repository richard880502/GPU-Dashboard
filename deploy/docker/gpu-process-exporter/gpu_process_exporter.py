#!/usr/bin/env python3
"""Maps each GPU-using PID to the Docker container it runs in (or "host" if none).

Same label set as nvitop-exporter's process_* metrics (hostname, index, pid,
username, uuid) plus container_name, so Grafana can merge this into the
existing "GPU Processes" table by those shared labels.

Also tries Kubernetes attribution (via containerd's CRI socket, over
crictl) for any PID Docker doesn't recognize -- a k8s node's pods aren't
visible on the Docker socket at all when the runtime is containerd/CRI-O
directly rather than dockershim, which is the normal setup on any
reasonably current cluster. Set CRI_SOCKET_PATH (and bind-mount that socket
into this container) to enable; harmless no-op otherwise, since Docker-only
hosts just don't set it.
"""
import json
import os
import pwd
import re
import subprocess
import time

import docker
from prometheus_client import start_http_server
from prometheus_client.core import REGISTRY, GaugeMetricFamily

CGROUP_ID_RE = re.compile(r"([0-9a-f]{64})")


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=False).stdout


def gpu_uuid_index_map():
    out = sh(["nvidia-smi", "--query-gpu=uuid,index", "--format=csv,noheader"])
    mapping = {}
    for line in out.strip().splitlines():
        if not line.strip():
            continue
        uuid, idx = (part.strip() for part in line.split(","))
        mapping[uuid] = idx
    return mapping


def gpu_compute_apps():
    out = sh(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid", "--format=csv,noheader"])
    apps = []
    for line in out.strip().splitlines():
        if not line.strip():
            continue
        uuid, pid = (part.strip() for part in line.split(","))
        apps.append((uuid, pid))
    return apps


def username_for_pid(pid):
    # Falls back to the raw UID string when the name isn't in this
    # container's own /etc/passwd — matches nvitop-exporter's own fallback,
    # since the two metrics must agree exactly for Grafana to merge them.
    try:
        uid = os.stat(f"/proc/{pid}").st_uid
    except OSError:
        return "unknown"
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


def container_name_for_pid(pid, docker_client, cri_pid_map):
    try:
        with open(f"/proc/{pid}/cgroup") as f:
            content = f.read()
    except OSError:
        return "host"
    match = CGROUP_ID_RE.search(content)
    if match:
        try:
            return docker_client.containers.get(match.group(1)).name
        except docker.errors.NotFound:
            pass
    return cri_pid_map.get(str(pid), "host")


def cri_pid_map(cri_socket):
    """Maps PID -> "k8s:<namespace>/<pod>/<container>" for every container
    currently known to containerd's CRI plugin, by shelling out to crictl
    (a single static binary -- avoids hand-rolling a CRI gRPC/protobuf
    client just for this). Rebuilt once per collection cycle, same as
    gpu_uuid_index_map(), since crictl has no "give me just this PID" query.
    """
    if not cri_socket or not os.path.exists(cri_socket):
        return {}
    endpoint = f"unix://{cri_socket}"
    ids = sh(["crictl", "--runtime-endpoint", endpoint, "ps", "-q"]).split()
    result = {}
    for container_id in ids:
        raw = sh(["crictl", "--runtime-endpoint", endpoint, "inspect", container_id])
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        info = data.get("info", {})
        pid = info.get("pid")
        labels = info.get("config", {}).get("labels", {})
        pod = labels.get("io.kubernetes.pod.name")
        container = labels.get("io.kubernetes.container.name")
        if not pid or not pod or not container:
            continue
        namespace = labels.get("io.kubernetes.pod.namespace", "default")
        result[str(pid)] = f"k8s:{namespace}/{pod}/{container}"
    return result


class GPUProcessContainerCollector:
    def __init__(self, hostname):
        self.hostname = hostname
        self.docker_client = docker.from_env()
        self.cri_socket = os.environ.get("CRI_SOCKET_PATH", "")

    def collect(self):
        metric = GaugeMetricFamily(
            "gpu_process_container_info",
            "Maps a GPU process to the container it runs in (value is always 1)",
            labels=["hostname", "index", "pid", "username", "uuid", "container_name"],
        )
        uuid2idx = gpu_uuid_index_map()
        cri_map = cri_pid_map(self.cri_socket)
        for uuid, pid in gpu_compute_apps():
            metric.add_metric(
                [
                    self.hostname,
                    uuid2idx.get(uuid, "?"),
                    pid,
                    username_for_pid(pid),
                    uuid,
                    container_name_for_pid(pid, self.docker_client, cri_map),
                ],
                1,
            )
        yield metric


if __name__ == "__main__":
    REGISTRY.register(GPUProcessContainerCollector(os.environ["EXPORTER_HOSTNAME"]))
    start_http_server(5052)
    while True:
        time.sleep(3600)
