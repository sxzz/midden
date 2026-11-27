import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { deleteAll, deleteCollections } from '#library/delete.ts'
import { save, setup, stopWorld } from '#testing/updates-world.ts'
import { collectCollections } from './maintenance.ts'
import { resolveOptions } from './options.ts'
import { checkProgress } from './progress-check.ts'
import {
  adoptUpdates,
  progressKept,
  readOnlyProgress,
  settleProgress,
  verifyMembers,
} from './progress.ts'
import { retryRecordFailed } from './retries.ts'
import {
  continueTimeline,
  pauseUpdate,
  resumeUpdate,
  startUpdate,
  stopUpdate,
  updateRecord,
  verifyProgress,
} from './updates.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

afterEach(async () => {
  readOnlyProgress(false)
  await stopWorld()
})

/** Every update of the context, kept exact: what is kept equals a full count. */
function exact(ctx: AccountsContext) {
  // As the worker does each second.
  settleProgress(ctx.db)
  adoptUpdates(ctx.db, 100)
  const ids = ctx.db.all<{ id: string }>(sql`SELECT id FROM updates`)
  const problems = ids.flatMap(({ id }) =>
    verifyProgress(ctx.db, id).map((problem) => `${id}: ${problem}`),
  )
  expect(problems).toEqual([])
  return ids.length
}

const members = (ctx: AccountsContext, update: string) =>
  updateRecord(ctx.db, update).members!

describe('an update’s progress is kept exact', () => {
  test('the same post on two profiles counts once, newest capture', async () => {
    const { ctx } = setup({
      timelines: { '100': [1, 2, 3, 4], '200': [3, 4, 5] },
    })
    const a = await save(ctx, 'https://fake.test/u/100')
    const b = await save(ctx, 'https://fake.test/u/200')
    const update = startUpdate(
      ctx,
      { target: 'many', ids: [a, b] },
      { options: resolveOptions({ count: 10 }) },
    )
    await ctx.queue.drain()
    // Two profiles and posts 1 to 5, the shared 3 and 4 once each.
    expect(members(ctx, update)).toMatchObject({
      total: 7,
      complete: 7,
      pending: 0,
      done: true,
    })
    exact(ctx)
  })

  test('a post updated as an item and listed on a profile is one member', async () => {
    const { ctx } = setup({ timelines: { '100': [1, 2, 3] } })
    const profile = await save(ctx, 'https://fake.test/u/100')
    const post = await save(ctx, 'https://fake.test/p/2')
    const update = startUpdate(
      ctx,
      { target: 'many', ids: [profile, post] },
      { options: resolveOptions({ count: 10 }) },
    )
    await ctx.queue.drain()
    expect(members(ctx, update)).toMatchObject({ total: 4, complete: 4 })
    exact(ctx)
  })

  test('new if any listing was new; updated otherwise', async () => {
    const { ctx } = setup({ timelines: { '100': [1, 2, 3, 4, 5] } })
    // Saving the profile saved its first page, posts 1 to 3; 4 and 5 are new.
    const profile = await save(ctx, 'https://fake.test/u/100')
    const update = startUpdate(
      ctx,
      { target: 'collection', id: profile },
      { options: resolveOptions({ count: 10 }) },
    )
    await ctx.queue.drain()
    expect(members(ctx, update)).toMatchObject({
      total: 6,
      added: 2,
      updated: 4,
    })
    exact(ctx)
  })

  test('items not reached yet and a paused update are in progress', async () => {
    const { ctx } = setup({ timelines: { '100': [1, 2, 3, 4] } })
    const a = await save(ctx, 'https://fake.test/u/100')
    const b = await save(ctx, 'https://fake.test/p/9')
    const update = startUpdate(
      ctx,
      { target: 'many', ids: [a, b] },
      { options: resolveOptions({ count: 10 }) },
    )
    pauseUpdate(ctx, update)
    exact(ctx)
    expect(updateRecord(ctx.db, update)).toMatchObject({ done: false })
    resumeUpdate(ctx, update)
    await ctx.queue.drain()
    expect(updateRecord(ctx.db, update)).toMatchObject({ done: true })
    exact(ctx)
  })

  test('failed members, retried, and a stopped update', async () => {
    const { ctx, state } = setup({
      timelines: { '100': [1, 2, 3, 4, 5, 6] },
    })
    const profile = await save(ctx, 'https://fake.test/u/100')
    state.broken.add('2')
    state.broken.add('5')
    const update = startUpdate(
      ctx,
      { target: 'collection', id: profile },
      { options: resolveOptions({ count: 10 }) },
    )
    await ctx.queue.drain()
    expect(members(ctx, update)).toMatchObject({ failed: 2, complete: 5 })
    expect(updateRecord(ctx.db, update).retryable).toBe(2)
    exact(ctx)
    state.broken.delete('2')
    retryRecordFailed(ctx, update)
    await ctx.queue.drain()
    expect(members(ctx, update)).toMatchObject({ failed: 1, complete: 6 })
    exact(ctx)
    stopUpdate(ctx, update)
    exact(ctx)
  })

  test('a timeline continued past its cap joins the same members', async () => {
    const { ctx, state } = setup({ pageSize: 4 }, { timelineCap: 10 })
    const profile = await save(ctx, 'https://fake.test/u/100')
    state.timelines['100'] = Array.from({ length: 40 }, (_, i) => i + 1)
    await save(ctx, 'https://fake.test/p/18')
    const update = startUpdate(
      ctx,
      { target: 'collection', id: profile },
      { options: resolveOptions({ posts: 'until_existing' }) },
    )
    await ctx.queue.drain()
    exact(ctx)
    const before = members(ctx, update).total
    continueTimeline(ctx, update, profile)
    exact(ctx)
    await ctx.queue.drain()
    expect(members(ctx, update).total).toBeGreaterThan(before)
    exact(ctx)
  })

  test('verified at every step while members are being captured', async () => {
    const { ctx, state } = setup({
      pageSize: 3,
      timelines: {
        '100': Array.from({ length: 20 }, (_, i) => i + 1),
        '200': Array.from({ length: 20 }, (_, i) => i + 10),
        '300': Array.from({ length: 12 }, (_, i) => i + 25),
      },
    })
    const ids = [
      await save(ctx, 'https://fake.test/u/100'),
      await save(ctx, 'https://fake.test/u/200'),
      await save(ctx, 'https://fake.test/u/300'),
    ]
    state.broken.add('12')
    state.broken.add('27')
    const update = startUpdate(
      ctx,
      { target: 'many', ids },
      { options: resolveOptions({ count: 30 }) },
    )
    // Between jobs, as they run side by side.
    for (let step = 0; step < 400; step++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
      exact(ctx)
      if (updateRecord(ctx.db, update).done) break
    }
    await ctx.queue.drain()
    expect(members(ctx, update)).toMatchObject({ failed: 2, done: true })
    exact(ctx)
  })

  test('random runs: updates, failures, retries, pauses and stops', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      let n = seed * 7919
      const random = (count: number) => {
        n = (n * 1_103_515_245 + 12_345) % 2_147_483_648
        return n % count
      }
      const posts = (from: number, length: number) =>
        Array.from({ length }, (_, i) => from + i)
      const { ctx, state } = setup({
        pageSize: 2 + random(3),
        timelines: {
          '100': posts(1, 4 + random(8)),
          '200': posts(3 + random(4), 4 + random(8)),
          '300': posts(8, 3 + random(6)),
        },
      })
      const profiles = [
        await save(ctx, 'https://fake.test/u/100'),
        await save(ctx, 'https://fake.test/u/200'),
        await save(ctx, 'https://fake.test/u/300'),
      ]
      for (let i = 0; i < random(4); i++)
        await save(ctx, `https://fake.test/p/${1 + random(14)}`)
      const started: string[] = []
      for (let step = 0; step < 8; step++) {
        const pick = random(7)
        if (pick === 0 || !started.length) {
          const chosen = profiles.filter(() => random(2) === 0)
          if (!chosen.length) chosen.push(profiles[random(3)]!)
          started.push(
            startUpdate(
              ctx,
              { target: 'many', ids: chosen },
              { options: resolveOptions({ count: 4 + random(10) }) },
            ),
          )
        } else
          switch (pick) {
            case 1: {
              state.broken.add(String(1 + random(14)))
              break
            }
            case 2: {
              state.broken.clear()
              break
            }
            case 3: {
              retryRecordFailed(ctx, started[random(started.length)]!)
              break
            }
            case 4: {
              try {
                pauseUpdate(ctx, started[random(started.length)]!)
              } catch {}

              break
            }
            case 5: {
              resumeUpdate(ctx, started[random(started.length)]!)
              break
            }
            default:
              stopUpdate(ctx, started[random(started.length)]!)
          }
        // Sometimes look in the middle, sometimes let everything run.
        if (random(2) === 0) await ctx.queue.drain()
        else await new Promise((resolve) => setTimeout(resolve, random(6)))
        exact(ctx)
      }
      for (const update of started) resumeUpdate(ctx, update)
      await ctx.queue.drain()
      exact(ctx)
      await stopWorld()
    }
  }, 60_000)
})

describe('what is removed', () => {
  test('members deleted from the library and collected leave the update', async () => {
    const { ctx } = setup({ timelines: { '100': [1, 2, 3, 4] } })
    const profile = await save(ctx, 'https://fake.test/u/100')
    const update = startUpdate(
      ctx,
      { target: 'collection', id: profile },
      { options: resolveOptions({ count: 10 }) },
    )
    await ctx.queue.drain()
    expect(members(ctx, update).total).toBe(5)
    exact(ctx)
    const posts = ctx.db.all<{ id: string }>(
      sql`SELECT id FROM collections WHERE kind = 'post'`,
    )
    deleteCollections(
      ctx.db,
      posts.slice(0, 2).map((post) => post.id),
    )
    exact(ctx)
    expect(await collectCollections(ctx)).toBe(2)
    expect(members(ctx, update).total).toBe(3)
    exact(ctx)
    // The update itself goes with its rows.
    deleteAll(ctx.db)
    expect(
      ctx.db.all(sql`SELECT 1 FROM update_members WHERE update_id = ${update}`),
    ).toEqual([])
  })
})

describe('how it is kept', () => {
  test('a read thread reads what was settled, a writer settles first', async () => {
    const { ctx } = setup({ timelines: { '100': [1, 2, 3] } })
    const profile = await save(ctx, 'https://fake.test/u/100')
    const update = startUpdate(
      ctx,
      { target: 'collection', id: profile },
      { options: resolveOptions({ count: 10 }) },
    )
    await ctx.queue.drain()
    // A writer settles before it reads.
    expect(members(ctx, update)).toMatchObject({ total: 4, complete: 4 })
    // A read thread does not: what changed since is not in yet.
    ctx.db.run(
      sql`UPDATE captures SET state = 'failed' WHERE id IN
        (SELECT capture_id FROM update_members WHERE update_id = ${update} LIMIT 1)`,
    )
    readOnlyProgress()
    expect(members(ctx, update)).toMatchObject({ complete: 4, failed: 0 })
    readOnlyProgress(false)
    expect(members(ctx, update)).toMatchObject({ complete: 3, failed: 1 })
    exact(ctx)
  })

  test('updates from before it was kept are taken up, running ones first', async () => {
    const { ctx } = setup({ timelines: { '100': [1, 2, 3] } })
    const profile = await save(ctx, 'https://fake.test/u/100')
    const update = startUpdate(
      ctx,
      { target: 'collection', id: profile },
      { options: resolveOptions({ count: 10 }) },
    )
    await ctx.queue.drain()
    exact(ctx)
    ctx.db.run(sql`DELETE FROM update_members`)
    ctx.db.run(sql`DELETE FROM update_pages`)
    ctx.db.run(sql`DELETE FROM update_progress`)
    expect(progressKept(ctx.db, update)).toBe(false)
    expect(adoptUpdates(ctx.db)).toBe(1)
    expect(progressKept(ctx.db, update)).toBe(true)
    exact(ctx)
  })

  test('a row that is not what the sources say is found', async () => {
    const { ctx } = setup({ timelines: { '100': [1, 2] } })
    const profile = await save(ctx, 'https://fake.test/u/100')
    const update = startUpdate(
      ctx,
      { target: 'collection', id: profile },
      { options: resolveOptions({ count: 10 }) },
    )
    await ctx.queue.drain()
    exact(ctx)
    ctx.db.run(
      sql`UPDATE update_members SET state = 'failed' WHERE update_id = ${update}
        AND rowid = (SELECT min(rowid) FROM update_members WHERE update_id = ${update})`,
    )
    expect(verifyMembers(ctx.db, update)).toHaveLength(1)
  })

  test('the check finds a mismatch, logs it and keeps the update again', async () => {
    const { ctx } = setup({ timelines: { '100': [1, 2] } })
    const profile = await save(ctx, 'https://fake.test/u/100')
    const update = startUpdate(
      ctx,
      { target: 'collection', id: profile },
      { options: resolveOptions({ count: 10 }) },
    )
    await ctx.queue.drain()
    exact(ctx)
    expect(checkProgress(ctx, 5)).toEqual([])
    ctx.db.run(
      sql`UPDATE update_progress SET complete = complete + 1 WHERE update_id = ${update}`,
    )
    expect(checkProgress(ctx, 5)).toEqual([update])
    expect(checkProgress(ctx, 5)).toEqual([])
    exact(ctx)
  })

  test('a deleted update takes its rows with it', async () => {
    const { ctx } = setup({ timelines: { '100': [1, 2] } })
    const profile = await save(ctx, 'https://fake.test/u/100')
    const update = startUpdate(ctx, { target: 'collection', id: profile })
    await ctx.queue.drain()
    exact(ctx)
    ctx.db.run(sql`DELETE FROM updates WHERE id = ${update}`)
    expect(
      ctx.db.all(sql`SELECT 1 FROM update_members WHERE update_id = ${update}`),
    ).toEqual([])
    expect(
      ctx.db.all(
        sql`SELECT 1 FROM update_progress WHERE update_id = ${update}`,
      ),
    ).toEqual([])
  })
})
