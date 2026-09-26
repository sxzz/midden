import type { TwitterBuildHost } from './build-host.js';
interface TwitterFetchOptions {
  url: string; method?: 'GET' | 'POST'; headers?: Record<string,string>; body?: string;
  useElongator?: boolean; validateFunction?: (response: unknown) => boolean; elongatorRequired?: boolean;
}
export const twitterFetch = async (host: TwitterBuildHost, options: TwitterFetchOptions): Promise<unknown> => {
  if (!host.twitterProxy) throw new Error('Request-bound account transport required');
  const response = await host.twitterProxy.fetch(options.url, {method: options.method ?? 'GET', headers: options.headers, body: options.body});
  const data: unknown = await response.json();
  if (options.validateFunction && !options.validateFunction(data)) throw new Error('Invalid upstream response');
  return data;
};
