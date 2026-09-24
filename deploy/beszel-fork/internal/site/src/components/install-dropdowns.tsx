import { i18n } from "@lingui/core"
import { memo } from "react"
import { copyToClipboard, getHubURL } from "@/lib/utils"
import { DropdownMenuContent, DropdownMenuItem } from "./ui/dropdown-menu"

// const isbeta = beszel.hub_version.includes("beta")
// const imagetag = isbeta ? ":edge" : ""

/**
 * Get the URL of the script to install the agent.
 * @param path - The path to the script (e.g. "/brew").
 * @returns The URL for the script.
 */
const getScriptUrl = (path: string = "") => {
	return `https://get.beszel.dev${path}`
	// no beta for now
	// const url = new URL("https://get.beszel.dev")
	// url.pathname = path
	// if (isBeta) {
	// 	url.searchParams.set("beta", "1")
	// }
	// return url.toString()
}

// gpu-monitoring fork addition: upstream's install snippets pointed at
// henrygd/beszel-agent (no GPU support at all -- our GPU support comes
// from this fork's own image, not the plain upstream binary/image). Point
// these at our own GHCR image instead, with --gpus all so it can actually
// see the GPU. GPU_COLLECTOR/SMART_DEVICE_1 are left as placeholders the
// user fills in per host (device paths and unified-memory chips like GB10
// vary per machine -- see deploy/standalone/monitored-node-compose.yml
// for the full reference with SMART/CRI env vars too). Doesn't depend on
// this repo's NFS-shared checkout at all -- copy/paste runs anywhere.
const AGENT_IMAGE = "ghcr.io/richard880502/gpu-dashboard/beszel-agent-nvidia:v2.7.4"

export function copyDockerCompose(port = "45876", publicKey: string, token: string) {
	copyToClipboard(`services:
  beszel-agent:
    image: ${AGENT_IMAGE}
    container_name: beszel-agent
    restart: unless-stopped
    network_mode: host
    gpus: all
    # SMART disk monitoring: map the base device (not partition), e.g.
    # /dev/nvme0, plus SYS_RAWIO (SATA/ATA) / SYS_ADMIN (NVMe) below.
    # cap_add:
    #   - SYS_RAWIO
    #   - SYS_ADMIN
    # devices:
    #   - /dev/nvme0:/dev/nvme0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./beszel_agent_data:/var/lib/beszel-agent
      # monitor other disks / partitions by mounting a folder in /extra-filesystems
      # - /mnt/disk/.beszel:/extra-filesystems/sda1:ro
    environment:
      LISTEN: ${port}
      KEY: '${publicKey}'
      TOKEN: ${token}
      HUB_URL: ${getHubURL()}
      # nvidia-smi is required, not NVML -- see docs/beszel-integration-research.md.
      # Unified-memory arm64 chips (e.g. GB10) need GPU_COLLECTOR: nvml,nvidia-smi instead.
      GPU_COLLECTOR: nvidia-smi`)
}

export function copyDockerRun(port = "45876", publicKey: string, token: string) {
	copyToClipboard(
		`docker run -d --name beszel-agent --network host --restart unless-stopped --gpus all -v /var/run/docker.sock:/var/run/docker.sock:ro -v beszel_agent_data:/var/lib/beszel-agent -e KEY="${publicKey}" -e LISTEN=${port} -e TOKEN="${token}" -e HUB_URL="${getHubURL()}" -e GPU_COLLECTOR=nvidia-smi ${AGENT_IMAGE}`
	)
}

export function copyLinuxCommand(port = "45876", publicKey: string, token: string, brew = false) {
	let cmd = `curl -sL ${getScriptUrl(
		brew ? "/brew" : ""
	)} -o /tmp/install-agent.sh && chmod +x /tmp/install-agent.sh && /tmp/install-agent.sh -p ${port} -k "${publicKey}" -t "${token}" -url "${getHubURL()}"`
	// brew script does not support --china-mirrors
	if (!brew && (i18n.locale + navigator.language).includes("zh-CN")) {
		cmd += ` --china-mirrors`
	}
	copyToClipboard(cmd)
}

export function copyWindowsCommand(port = "45876", publicKey: string, token: string) {
	copyToClipboard(
		`& iwr -useb ${getScriptUrl()} -OutFile "$env:TEMP\\install-agent.ps1"; & Powershell -ExecutionPolicy Bypass -File "$env:TEMP\\install-agent.ps1" -Key "${publicKey}" -Port ${port} -Token "${token}" -Url "${getHubURL()}"`
	)
}

export interface DropdownItem {
	text: string
	onClick?: () => void
	url?: string
	icons?: React.ComponentType<React.SVGProps<SVGSVGElement>>[]
}

export const InstallDropdown = memo(({ items }: { items: DropdownItem[] }) => {
	return (
		<DropdownMenuContent align="end">
			{items.map((item, index) => {
				const className = "cursor-pointer flex items-center gap-1.5"
				return item.url ? (
					<DropdownMenuItem key={index} asChild>
						<a href={item.url} className={className} target="_blank" rel="noopener noreferrer">
							{item.text}{" "}
							{item.icons?.map((Icon, iconIndex) => (
								<Icon key={iconIndex} className="size-4" />
							))}
						</a>
					</DropdownMenuItem>
				) : (
					<DropdownMenuItem key={index} onClick={item.onClick} className={className}>
						{item.text}{" "}
						{item.icons?.map((Icon, iconIndex) => (
							<Icon key={iconIndex} className="size-4" />
						))}
					</DropdownMenuItem>
				)
			})}
		</DropdownMenuContent>
	)
})
