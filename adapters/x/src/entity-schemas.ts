export const entitySchemas = {
  "x.post": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["text"],
    properties: {
      text: {
        type: "string",
      },
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
export const entityTypes = Object.entries(entitySchemas).map(
  ([name, schema]) => ({
    name,
    jsonSchema: Buffer.from(JSON.stringify(schema)),
  }),
);
