/**
 * Mastodon REST API entity shapes (public endpoints).
 * @see https://docs.joinmastodon.org/entities/Status/
 */

/** @see https://docs.joinmastodon.org/entities/CustomEmoji/ */
interface MastodonCustomEmoji {
  shortcode: string;
  url: string;
  static_url: string;
  visible_in_picker?: boolean;
}

interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  locked: boolean;
  bot: boolean;
  discoverable?: boolean;
  group: boolean;
  created_at: string;
  note: string;
  url: string;
  avatar: string;
  avatar_static: string;
  header: string;
  header_static: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  last_status_at?: string | null;
  emojis?: MastodonCustomEmoji[];
  fields?: { name: string; value: string; verified_at?: string | null }[];
  noindex?: boolean;
  /** Some instances / forks */
  verified?: boolean;
}

interface MastodonMediaAttachment {
  id: string;
  type: 'unknown' | 'image' | 'gifv' | 'video' | 'audio';
  url: string;
  preview_url: string;
  remote_url: string | null;
  text_url?: string | null;
  meta?: {
    original?: { width?: number; height?: number; duration?: number; frame_rate?: string };
    small?: { width?: number; height?: number };
  };
  description: string | null;
  blurhash?: string | null;
}

interface MastodonMention {
  id: string;
  username: string;
  url: string;
  acct: string;
}

interface MastodonStatusTag {
  name: string;
  url: string;
}

interface MastodonCard {
  url: string;
  title: string;
  description: string;
  type: string;
  author_name?: string;
  author_url?: string;
  provider_name?: string;
  provider_url?: string;
  html?: string;
  width?: number;
  height?: number;
  image?: string | null;
  embed_url?: string;
  blurhash?: string | null;
}

/** Partial; extend as needed for quote posts on forks */
interface MastodonStatus {
  id: string;
  uri: string;
  created_at: string;
  account: MastodonAccount;
  content: string;
  visibility: string;
  sensitive: boolean;
  spoiler_text: string;
  media_attachments: MastodonMediaAttachment[];
  application?: { name: string; website: string | null };
  mentions: MastodonMention[];
  tags: MastodonStatusTag[];
  emojis?: MastodonCustomEmoji[];
  reblogs_count: number;
  favourites_count: number;
  replies_count: number;
  url: string | null;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  reblog: MastodonStatus | null;
  poll?: unknown;
  card: MastodonCard | null;
  language: string | null;
  text?: string | null;
  favourited?: boolean;
  reblogged?: boolean;
  muted?: boolean;
  bookmarked?: boolean;
  pinned?: boolean;
  filtered?: unknown[];
  /** Glitch / forks */
  quoted_status?: MastodonStatus | null;
  /** Some instances omit `quoted_status` but expose the id when the quote is unavailable. */
  quoted_status_id?: string | null;
}

interface MastodonContext {
  ancestors: MastodonStatus[];
  descendants: MastodonStatus[];
}

interface MastodonSearchResponse {
  accounts: MastodonAccount[];
  statuses: MastodonStatus[];
  hashtags: unknown[];
}
