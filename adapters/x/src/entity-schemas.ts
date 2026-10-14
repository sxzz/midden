export const entitySchemas = {
  "x.post": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["text"],
    properties: {
      text: {
        type: "string",
      },
      replies: { type: "integer", minimum: 0 },
      reposts: { type: "integer", minimum: 0 },
      likes: { type: "integer", minimum: 0 },
      bookmarks: { type: "integer", minimum: 0 },
      quotes: { type: "integer", minimum: 0 },
      published_at: {
        type: "string",
        format: "date-time",
      },
      edited_at: {
        type: "string",
        format: "date-time",
      },
      edited_at_source: {
        type: "string",
      },
      edit_ids: {
        type: "array",
        items: {
          type: "string",
        },
      },
    },
    additionalProperties: false,
  },
  "x.profile": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["username", "name", "metadata"],
    properties: {
      username: {
        type: "string",
      },
      name: {
        type: "string",
      },
      avatar_url: {
        type: "string",
      },
      metadata: {
        type: "object",
      },
    },
    additionalProperties: false,
  },
};
// Counts are observations, not content: the core keeps them with each capture
// and leaves them out of versions.
const metricPaths: Record<string, string[]> = {
  "x.post": ["/replies", "/reposts", "/likes", "/bookmarks", "/quotes"],
  "x.profile": [
    "/metadata/followers",
    "/metadata/following",
    "/metadata/statuses",
    "/metadata/media_count",
    "/metadata/likes",
  ],
};
export const entityTypes = Object.entries(entitySchemas).map(
  ([name, schema]) => ({
    name,
    jsonSchema: Buffer.from(JSON.stringify(schema)),
    metricPaths: metricPaths[name] ?? [],
  }),
);
