// The configuration profile that puts the web app on an iPhone's or iPad's
// home screen (设置 → 账号 → 添加到桌面 in Safari): one Web Clip payload,
// opening the app's root full screen. The deploy writes it beside the app
// (scripts/prepare-web-assets.ts); the dev server makes it for the address
// it is opened at (web/vite.config.ts).
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Where the app links to it, as web/src/composables/useInstall.ts says. */
export const PROFILE_PATH = '/midden.mobileconfig'
/** What iOS opens a downloaded profile as. */
export const PROFILE_TYPE = 'application/x-apple-aspen-config'
/** The home screen icon: the same as Safari's own 添加到主屏幕 takes. */
export const PROFILE_ICON = new URL(
  '../web/public/apple-touch-icon.png',
  import.meta.url,
)

// RFC 4122's namespace for URLs.
const URL_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')
/** A name-based (version 5) UUID: the same name, the same UUID. */
export function uuid5(name: string) {
  const hash = createHash('sha1')
    .update(URL_NAMESPACE)
    .update(name)
    .digest()
    .subarray(0, 16)
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ]
    .join('-')
    .toUpperCase()
}

const escapeXML = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * The profile for the app at `origin` (`https://midden.example.com`). Its
 * identifiers come from the host, so every build for one deployment makes
 * the same profile and installing it again replaces the one installed,
 * while another deployment's stays beside it.
 */
export function webClipProfile(
  origin: string,
  icon: Buffer = readFileSync(PROFILE_ICON),
) {
  const url = new URL(origin)
  const root = `${url.origin}/`
  // Reverse DNS, as profile identifiers are: midden.example.com:5173
  // becomes com.example.midden.5173.
  const id = [
    ...url.hostname.split('.').toReversed(),
    ...(url.port ? [url.port] : []),
  ]
    .map((part) => part.replaceAll(/[^\w-]/g, '-'))
    .join('.')
  const base64 = icon.toString('base64').replaceAll(/.{1,68}/g, '\t\t\t$&\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>FullScreen</key>
			<true/>
			<key>Icon</key>
			<data>
${base64}			</data>
			<key>IsRemovable</key>
			<true/>
			<key>Label</key>
			<string>Midden</string>
			<key>PayloadDisplayName</key>
			<string>Midden</string>
			<key>PayloadIdentifier</key>
			<string>${escapeXML(id)}.midden.webclip</string>
			<key>PayloadType</key>
			<string>com.apple.webClip.managed</string>
			<key>PayloadUUID</key>
			<string>${uuid5(`${root}#webclip`)}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>Precomposed</key>
			<true/>
			<key>URL</key>
			<string>${escapeXML(root)}</string>
		</dict>
	</array>
	<key>PayloadDisplayName</key>
	<string>Midden</string>
	<key>PayloadIdentifier</key>
	<string>${escapeXML(id)}.midden</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${uuid5(`${root}#profile`)}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`
}
