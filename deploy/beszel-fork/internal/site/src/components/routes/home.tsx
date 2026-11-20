import { useLingui } from "@lingui/react/macro"
import { memo, Suspense, useEffect, useMemo } from "react"
import SystemsTable from "@/components/systems-table/systems-table"
import { GpuSection } from "@/components/gpu-section"
import { FooterRepoLink } from "@/components/footer-repo-link"

export default memo(() => {
	const { t } = useLingui()

	useEffect(() => {
		document.title = `${t`All Systems`} / Beszel`
	}, [t])

	// GPU polling state lives inside GpuSection, so its refreshes never
	// re-render this tree (and with it the systems table).
	return useMemo(
		() => (
			<>
				<div className="flex flex-col gap-4">
					<GpuSection />
					<Suspense>
						<SystemsTable />
					</Suspense>
				</div>
				<FooterRepoLink />
			</>
		),
		[]
	)
})
