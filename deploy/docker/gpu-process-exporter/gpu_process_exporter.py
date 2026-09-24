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

Some hosts run their whole k8s node nested inside another Docker container
(e.g. a self-contained k3s-in-docker sandbox) rather than directly on the
host -- there, the CRI socket lives in that container's own /run and can't
be bind-mounted out normally. Set CRI_EXEC_CONTAINER to that container's
name instead of bind-mounting: crictl then runs via `docker exec` into it
(over the docker.sock already mounted here).

Container attribution (Docker and CRI both) matches by container id
parsed out of /proc/<pid>/cgroup, not by pid: crictl/the Docker API only
ever report a container's own entrypoint pid, but a GPU-using pid is
often a worker process that entrypoint forked after startup (e.g. vLLM's
tensor-parallel workers) -- pid-based matching misses those entirely,
since they never appear in either API's own pid field, even though they
share their parent's cgroup and so still carry the right container id.
A cgroup path can contain more than one 64-hex id (e.g. a k8s pod's
cgroup nested inside CRI_EXEC_CONTAINER's own wrapping container), listed
outermost-first -- the innermost (last) one is the actual container.
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


def container_name_for_pid(pid, docker_client, cri_map):
    try:
        with open(f"/proc/{pid}/cgroup") as f:
            content = f.read()
    except OSError:
        return "host"
    ids = CGROUP_ID_RE.findall(content)
    if not ids:
        return "host"
    # Docker: try every id found (there's normally just one) against the
    # Docker API.
    for cid in ids:
        try:
            return docker_client.containers.get(cid).name
        except docker.errors.NotFound:
            continue
    # CRI/k8s: match against crictl's container map. cgroup paths list
    # outermost container first -- walk from the end so a pod nested
    # inside CRI_EXEC_CONTAINER's own wrapping container resolves to the
    # pod's own (innermost) id, not the wrapper's.
    for cid in reversed(ids):
        if cid in cri_map:
            return cri_map[cid]
    return "host"


def cri_container_map(cri_socket, exec_container, docker_client):
    """Maps container id -> "k8s:<namespace>/<pod>/<container>" for every
    container currently known to containerd's CRI plugin, by shelling out
    to crictl (a single static binary -- avoids hand-rolling a CRI
    gRPC/protobuf client just for this). Rebuilt once per collection
    cycle, same as gpu_uuid_index_map().

    Keyed by container id (matched directly against the id parsed out of
    /proc/<pid>/cgroup) rather than pid -- see the module docstring for
    why pid-based matching misses worker processes a container's
    entrypoint forks after startup.
    """
    if not cri_socket:
        return {}
    endpoint = f"unix://{cri_socket}"
    if exec_container:
        try:
            target = docker_client.containers.get(exec_container)
        except docker.errors.NotFound:
            return {}
        run = lambda cmd: target.exec_run(cmd).output.decode(errors="replace")
    else:
        if not os.path.exists(cri_socket):
            return {}
        run = sh
    ids = run(["crictl", "--runtime-endpoint", endpoint, "ps", "-q"]).split()
    result = {}
    for container_id in ids:
        raw = run(["crictl", "--runtime-endpoint", endpoint, "inspect", container_id])
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        labels = data.get("info", {}).get("config", {}).get("labels", {})
        pod = labels.get("io.kubernetes.pod.name")
        container = labels.get("io.kubernetes.container.name")
        if not pod or not container:
            continue
        namespace = labels.get("io.kubernetes.pod.namespace", "default")
        result[container_id] = f"k8s:{namespace}/{pod}/{container}"
    return result


class GPUProcessContainerCollector:
    def __init__(self, hostname):
        self.hostname = hostname
        self.docker_client = docker.from_env()
        self.cri_socket = os.environ.get("CRI_SOCKET_PATH", "")
        self.cri_exec_container = os.environ.get("CRI_EXEC_CONTAINER", "")

    def collect(self):
        metric = GaugeMetricFamily(
            "gpu_process_container_info",
            "Maps a GPU process to the container it runs in (value is always 1)",
            labels=["hostname", "index", "pid", "username", "uuid", "container_name"],
        )
        uuid2idx = gpu_uuid_index_map()
        cri_map = cri_container_map(self.cri_socket, self.cri_exec_container, self.docker_client)
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
