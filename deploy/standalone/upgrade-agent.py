#!/usr/bin/env python3
"""Recreate a host's beszel-agent container on a new image, keeping its settings.

For agents started with plain `docker run` (wingene-76..80). Hosts whose agent
runs from a compose file (e.g. wingene-82, ~/gpu-dashboard) are upgraded by
changing the image there and running `docker compose up -d beszel-agent`.

It reads the running container and keeps what was set on it (env on top of
the image's own, mounts, devices, GPUs, capabilities, network, restart
policy), and only adds:

  - the RAPL powercap mount used for CPU package power, when the host has
    /sys/devices/virtual/powercap (x86; Docker hides it unless mounted)
  - with --smart, NVMe devices plus the capabilities smartctl needs

Without --run it only prints the `docker run` command it would use.
With --run it pulls the image, keeps the old container stopped as
beszel-agent-old, starts the new one, and switches back to the old one if
the new one fails to start or exits within a few seconds. Remove
beszel-agent-old once the system shows up in the hub again.

Usage (on the host, or over ssh from anywhere with this file):

  ./upgrade-agent.py IMAGE [--smart /dev/nvme0,/dev/nvme1] [--run]
  ssh 192.168.1.77 "python3 - IMAGE --run" < deploy/standalone/upgrade-agent.py

  IMAGE e.g. ghcr.io/richard880502/gpu-dashboard/beszel-agent-nvidia:v2.8.0
  Find a host's disks for --smart with `lsblk -d`.
"""
import json
import os
import shlex
import subprocess
import sys
import time

NAME = "beszel-agent"
OLD = NAME + "-old"
POWERCAP = "/sys/devices/virtual/powercap"
SMART_CAPS = ["CAP_SYS_RAWIO", "CAP_SYS_ADMIN"]


def sh(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True)


def build_command(image, smart):
    c = json.loads(sh("docker", "inspect", NAME).stdout)[0]
    image_env = set(json.loads(sh("docker", "image", "inspect", c["Image"]).stdout)[0]["Config"]["Env"] or [])
    hc = c["HostConfig"]

    cmd = ["docker", "run", "-d", "--name", NAME]
    policy = hc["RestartPolicy"]["Name"]
    if policy and policy != "no":
        cmd += ["--restart", policy]
    if hc["NetworkMode"] and hc["NetworkMode"] != "default":
        cmd += ["--network", hc["NetworkMode"]]
    for e in c["Config"]["Env"] or []:
        # only what was set on the container; the new image brings its own defaults
        if e not in image_env:
            cmd += ["-e", e]
    destinations = set()
    for m in c["Mounts"]:
        src = m["Name"] if m["Type"] == "volume" else m["Source"]
        spec = f"{src}:{m['Destination']}"
        if m.get("Mode"):
            spec += f":{m['Mode']}"
        elif not m.get("RW", True):
            spec += ":ro"
        cmd += ["-v", spec]
        destinations.add(m["Destination"])
    if os.path.isdir(POWERCAP) and "/host/powercap" not in destinations:
        cmd += ["-v", f"{POWERCAP}:/host/powercap:ro"]
    devices = {d["PathOnHost"]: d for d in hc.get("Devices") or []}
    for d in smart:
        devices.setdefault(d, {"PathOnHost": d, "PathInContainer": d, "CgroupPermissions": "rwm"})
    for d in devices.values():
        cmd += ["--device", f"{d['PathOnHost']}:{d['PathInContainer']}:{d['CgroupPermissions']}"]
    for req in hc.get("DeviceRequests") or []:
        if ["gpu"] in (req.get("Capabilities") or []):
            cmd += ["--gpus", "all" if req.get("Count") == -1 else str(req.get("Count"))]
    caps = list(hc.get("CapAdd") or [])
    if smart:
        caps += [cap for cap in SMART_CAPS if cap not in caps]
    for cap in caps:
        cmd += ["--cap-add", cap]
    if hc.get("Privileged"):
        cmd += ["--privileged"]
    cmd.append(image)
    return cmd


def rollback(reason):
    print(f"{reason}; switching back to the old container")
    sh("docker", "rm", "-f", NAME, check=False)
    sh("docker", "rename", OLD, NAME)
    sh("docker", "start", NAME)
    sys.exit(1)


def main():
    args = sys.argv[1:]
    if not args or args[0].startswith("-"):
        sys.exit(__doc__)
    image = args[0]
    smart = []
    if "--smart" in args:
        smart = [d for d in args[args.index("--smart") + 1].split(",") if d]

    cmd = build_command(image, smart)
    print(" ".join(shlex.quote(x) for x in cmd))
    if "--run" not in args:
        return

    sh("docker", "pull", "-q", image)  # before stopping anything, to keep the gap short
    sh("docker", "rm", "-f", OLD, check=False)
    sh("docker", "rename", NAME, OLD)
    sh("docker", "stop", OLD)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        rollback("start failed: " + r.stderr.strip())
    time.sleep(5)
    if sh("docker", "inspect", "-f", "{{.State.Running}}", NAME).stdout.strip() != "true":
        logs = sh("docker", "logs", "--tail", "20", NAME, check=False)
        rollback("new container exited:\n" + (logs.stdout + logs.stderr).strip())
    print(f"started {r.stdout.strip()[:12]}; old container kept as {OLD}")


if __name__ == "__main__":
    main()
