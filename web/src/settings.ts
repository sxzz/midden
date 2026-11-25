import { date } from './presentation'

export const REPOSITORY = 'https://github.com/sxzz/midden'
const REVISION = /^([\da-f]{40})(-dirty)?$/

/**
 * 关于: the build's commit, short and linked as the bot's /start shows it
 * (anything else, such as `dev`, as it is), and when it was built.
 */
export function buildFacts(version: string, builtAt: string) {
  const match = REVISION.exec(version)
  return {
    version: match ? match[1]!.slice(0, 7) + (match[2] ?? '') : version,
    commitURL: match ? `${REPOSITORY}/commit/${match[1]}` : '',
    builtAt: date(builtAt),
  }
}
