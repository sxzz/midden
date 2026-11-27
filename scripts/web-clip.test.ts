import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { describe, test } from 'node:test'
import { uuid5, webClipProfile } from './web-clip.ts'

type Plist =
  string | number | boolean | Buffer | Plist[] | { [key: string]: Plist }

/**
 * A strict reader for the plist subset a profile uses: it throws on any
 * other element, a missing end tag or a key without a value, so a profile
 * it reads is well formed.
 */
function readPlist(xml: string): Plist {
  const body =
    /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist [^>]+>\n<plist version="1\.0">([\s\S]*)<\/plist>\n$/.exec(
      xml,
    )
  assert.ok(body, 'a plist document')
  const tokens = body[1]!.match(/<[^>]+>|[^<]+/g)!.filter((t) => t.trim())
  let at = 0
  const take = () => {
    const token = tokens[at++]
    assert.ok(token !== undefined, 'unexpected end')
    return token
  }
  const text = (tag: string) => {
    const content = tokens[at]!.startsWith('<') ? '' : take()
    assert.equal(take(), `</${tag}>`)
    return content
  }
  function value(): Plist {
    const tag = take()
    switch (tag) {
      case '<true/>':
        return true
      case '<false/>':
        return false
      case '<string>':
        return text('string')
      case '<integer>':
        return Number(text('integer'))
      case '<data>':
        return Buffer.from(text('data').replaceAll(/\s/g, ''), 'base64')
      case '<array>': {
        const items: Plist[] = []
        while (tokens[at] !== '</array>') items.push(value())
        take()
        return items
      }
      case '<dict>': {
        const dict: Record<string, Plist> = {}
        while (tokens[at] !== '</dict>') {
          assert.equal(take(), '<key>')
          const key = text('key')
          assert.ok(!(key in dict), `duplicate key ${key}`)
          dict[key] = value()
        }
        take()
        return dict
      }
      default:
        throw new Error(`unexpected ${tag}`)
    }
  }
  const root = value()
  assert.equal(at, tokens.length, 'one root value')
  return root
}

const ICON = Buffer.from('89504e470d0a1a0a', 'hex')
const UUID = /^[\dA-F]{8}-[\dA-F]{4}-5[\dA-F]{3}-[89AB][\dA-F]{3}-[\dA-F]{12}$/

describe('webClipProfile', () => {
  test('is a configuration with one web clip of the origin root', () => {
    const profile = readPlist(
      webClipProfile('https://midden.example.com/settings/account', ICON),
    ) as Record<string, Plist>
    const [clip, ...rest] = profile.PayloadContent as Record<string, Plist>[]
    assert.deepEqual(rest, [])
    assert.equal(profile.PayloadType, 'Configuration')
    assert.equal(profile.PayloadVersion, 1)
    assert.equal(profile.PayloadIdentifier, 'com.example.midden.midden')
    assert.equal(profile.PayloadRemovalDisallowed, false)
    assert.match(profile.PayloadUUID as string, UUID)
    assert.deepEqual(clip, {
      FullScreen: true,
      Icon: ICON,
      IsRemovable: true,
      Label: 'Midden',
      PayloadDisplayName: 'Midden',
      PayloadIdentifier: 'com.example.midden.midden.webclip',
      PayloadType: 'com.apple.webClip.managed',
      PayloadUUID: clip!.PayloadUUID,
      PayloadVersion: 1,
      Precomposed: true,
      URL: 'https://midden.example.com/',
    })
    assert.match(clip!.PayloadUUID as string, UUID)
    assert.notEqual(clip!.PayloadUUID, profile.PayloadUUID)
  })

  test('keeps its identifiers across builds, and per deployment', () => {
    const ids = (origin: string) => {
      const profile = readPlist(webClipProfile(origin, ICON)) as Record<
        string,
        Plist
      >
      const [clip] = profile.PayloadContent as Record<string, Plist>[]
      return [profile.PayloadUUID, clip!.PayloadUUID, clip!.PayloadIdentifier]
    }
    assert.deepEqual(
      ids('https://midden.example.com'),
      ids('https://midden.example.com/'),
    )
    const other = ids('https://other.example.com')
    ids('https://midden.example.com').forEach((id, i) =>
      assert.notEqual(id, other[i]),
    )
  })

  test('takes a port into the identifier and the address', () => {
    const profile = readPlist(
      webClipProfile('http://devbox:5176', ICON),
    ) as Record<string, Plist>
    const [clip] = profile.PayloadContent as Record<string, Plist>[]
    assert.equal(clip!.URL, 'http://devbox:5176/')
    assert.equal(clip!.PayloadIdentifier, 'devbox.5176.midden.webclip')
  })

  test('carries the committed home screen icon by default', () => {
    const profile = readPlist(
      webClipProfile('https://midden.example.com'),
    ) as Record<string, Plist>
    const [clip] = profile.PayloadContent as Record<string, Plist>[]
    const icon = clip!.Icon as Buffer
    assert.deepEqual(icon.subarray(0, 8), ICON)
    // Width and height from the PNG header: at least 180.
    assert.ok(icon.readUInt32BE(16) >= 180)
    assert.equal(icon.readUInt32BE(16), icon.readUInt32BE(20))
  })
})

test('uuid5 matches RFC 4122 version 5', () => {
  // Python's uuid.uuid5(uuid.NAMESPACE_URL, 'https://example.com/').
  assert.equal(
    uuid5('https://example.com/'),
    'DD2C1780-811A-5296-81C5-178A0EF488BC',
  )
})
