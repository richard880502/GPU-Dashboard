import { useLingui } from "@lingui/react/macro"
import { memo, Suspense, useEffect, useMemo } from "react"
import SystemsTable from "@/components/systems-table/systems-table"
import { GpuClusterOverview } from "@/components/gpu-cluster-overview"
import { GpuStatusTable, useGpuRows } from "@/components/gpu-status-table"
import { FooterRepoLink } from "@/components/footer-repo-link"

export default memo(() => {
	const { t } = useLingui()
	const gpuRows = useGpuRows()

	useEffect(() => {
		document.title = `${t`All Systems`} / Beszel`
	}, [t])

	return (
			<>
				<div className="flex flex-col gap-4">
					<GpuClusterOverview rows={gpuRows} />
					<GpuStatusTable rows={gpuRows} />
					<Suspense>
						<SystemsTable />
					</Suspense>
				</div>
				<FooterRepoLink />
			</>
		)
})
