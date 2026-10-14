// Use Changesets' own parser and package validation without `changeset status`'s
// separate changed-package policy, which would reject consumed release PRs.
import getReleasePlan from '@changesets/get-release-plan'

const plan = await getReleasePlan(process.cwd())
console.log(`Validated ${plan.changesets.length} changeset(s), ${plan.releases.length} release(s).`)
