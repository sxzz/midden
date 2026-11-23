// Shared by Instagram tests: wraps fixed fixtures in the authenticated web
// wire format.
export const fixtureUser = { pk: '77', username: 'fixture.name' }

export function sessionPage(viewer = fixtureUser, profileId = '77'): string {
  return `<script type="application/json" data-sjs>${JSON.stringify({
    define: [
      ['PolarisViewer', [], { data: viewer }, 0],
      ['DTSGInitialData', [], { token: 'fixture-dtsg' }, 0],
      ['LSD', [], { token: 'fixture-lsd' }, 0],
    ],
    initialRouteInfo: {
      route: {
        rootView: {
          props: {
            id: profileId,
            page_logging: { params: { profile_id: profileId } },
          },
        },
      },
    },
  })}</script>`
}

export const mediaPage = (node: unknown): string =>
  `<script type="application/json" data-sjs>${JSON.stringify({
    data: { xdt_api__v1__media__shortcode__web_info: { items: [node] } },
  })}</script>`

/** Turns fixed media/profile fixtures into the authenticated web wire format. */
export function sessionFixture(
  fetcher: typeof fetch,
  verify: (cookie: string | null) => boolean = () => true,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input))
    const cookie = new Headers(init?.headers).get('cookie')
    if (init?.method !== 'POST' && !url.pathname.startsWith('/p/'))
      return new Response(sessionPage(), {
        status: verify(cookie) ? 200 : 401,
      })
    const response = await fetcher(input, init)
    if (!response.ok) return response
    let data: any
    try {
      data = await response.clone().json()
    } catch {
      return response
    }
    if (data.status === 'fail' || data.errors || data.error || data.challenge)
      return response
    if (url.pathname.startsWith('/p/') && data.items?.[0])
      return new Response(mediaPage(data.items[0]), {
        headers: { 'content-type': 'text/html' },
      })
    const name = new URLSearchParams(init?.body as string | undefined).get(
      'fb_api_req_friendly_name',
    )
    if (name === 'PolarisProfilePageContentQuery')
      data = { data: { user: data.user ?? data.data?.user } }
    else if (name?.startsWith('PolarisProfilePosts'))
      data = {
        data: {
          xdt_api__v1__feed__user_timeline_graphql_connection: {
            edges: data.items?.map((node: unknown) => ({ node })),
            page_info: {
              has_next_page: !!data.more_available,
              end_cursor: data.next_max_id ?? null,
            },
          },
        },
      }
    return Response.json(data)
  }
}
