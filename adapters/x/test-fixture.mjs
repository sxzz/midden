import { createServer as createInstagramServer } from "../instagram/dist/server.js";
import { CaptureStrategy as InstagramStrategy } from "../instagram/dist/strategy.js";
import { createServer } from "./dist/server.js";
import { fetchPublic } from "./dist/provider.js";
import { CaptureStrategy } from "./dist/strategy.js";
import { normalizeProfile } from "./dist/profile.js";
import { ServerCredentials } from "@grpc/grpc-js";
import { readFileSync } from "node:fs";
import { sessionFixture } from "../instagram/test-fixtures.mjs";
import { shortcodeFromPk } from "../instagram/dist/resolve.js";
import { instagramShortcodeToPk } from "@fxembed/atmosphere/providers/instagram/shortcode";
const post = (id, signal) =>
  fetchPublic(id, signal, process.env.FIXTURE_ENDPOINT);
const strategy = new CaptureStrategy(post, async (id) =>
  normalizeProfile(
    {
      type: "profile",
      id,
      name: "Fixture",
      screen_name: "fixture",
      protected: false,
    },
    id,
    "fxtwitter",
  ),
);
const s = createServer("fixture", true, post, strategy);
s.bindAsync(
  "127.0.0.1:0",
  ServerCredentials.createSsl(
    null,
    [
      {
        cert_chain: readFileSync(process.env.FIXTURE_CERT),
        private_key: readFileSync(process.env.FIXTURE_KEY),
      },
    ],
    false,
  ),
  (e, p) => {
    if (e) process.exit(1);
    process.stdout.write(p + "\n");
    const user = {
      pk: "77",
      username: "fixture.name",
      full_name: "Instagram Fixture",
      is_private: false,
      biography: "bio",
      edge_owner_to_timeline_media: {
        edges: [],
        page_info: { has_next_page: false },
      },
    };
    const post = (id) => ({
      pk: id,
      code: shortcodeFromPk(id),
      media_type: 1,
      user,
      caption: {
        text: process.env.FIXTURE_REVISION_FILE
          ? readFileSync(process.env.FIXTURE_REVISION_FILE, "utf8")
          : id === "2"
            ? "Instagram account"
            : "Instagram private",
      },
      image_versions2: {
        candidates: [
          {
            url:
              process.env.FIXTURE_MEDIA_ENDPOINT ||
              "https://cdn.test/photo.jpg",
            width: 1080,
            height: 1080,
          },
        ],
      },
    });
    const mock = sessionFixture(
      async (input, init) => {
        const url = String(input),
          cookie = new Headers(init?.headers).get("cookie");
        if (
          new URLSearchParams(init?.body).get("fb_api_req_friendly_name") ===
          "PolarisProfilePageContentQuery"
        )
          return new Response(JSON.stringify({ data: { user } }));
        if (
          new URLSearchParams(init?.body)
            .get("fb_api_req_friendly_name")
            ?.startsWith("PolarisProfilePosts")
        ) {
          const variables = JSON.parse(
            new URLSearchParams(init?.body).get("variables"),
          );
          return new Response(
            JSON.stringify(
              variables.after
                ? { items: [post("4")], more_available: false }
                : {
                    items: [post("2"), post("3")],
                    more_available: true,
                    next_max_id: "fixture-next",
                  },
            ),
          );
        }
        if (url.includes("/p/"))
          return new Response(
            JSON.stringify({
              items: [
                post(
                  String(instagramShortcodeToPk(/\/p\/([^/]+)\//.exec(url)[1])),
                ),
              ],
            }),
          );
        return new Response("login", { status: 403 });
      },
      (cookie) => cookie === "sessionid=fixture-session",
    );
    const ig = createInstagramServer(
      "fixture",
      true,
      new InstagramStrategy(mock),
      mock,
    );
    ig.bindAsync(
      "127.0.0.1:0",
      ServerCredentials.createSsl(
        null,
        [
          {
            cert_chain: readFileSync(process.env.FIXTURE_CERT),
            private_key: readFileSync(process.env.FIXTURE_KEY),
          },
        ],
        false,
      ),
      (err, port) => {
        if (err) process.exit(1);
        process.stdout.write(port + "\n");
      },
    );
  },
);
