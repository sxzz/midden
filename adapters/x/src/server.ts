import { CaptureStrategy } from "./strategy.js";
import { resolveTarget } from "./resolve.js";
import { decodeCredential, prepareCredential } from "./credential.js";
import { entityTypes } from "./entity-schemas.js";
import {
  Server,
  ServerCredentials,
  status,
  type ServerUnaryCall,
  type sendUnaryData,
  type ServiceError,
} from "@grpc/grpc-js";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import protobuf from "protobufjs";
import {
  AdapterService,
  type AdapterServer,
  Visibility,
} from "./generated/api/adapter/v1/adapter.js";
import { fetchPublic, ProviderError } from "./provider.js";
import { checkSession } from "./session.js";

export function createServer(
  secret: string,
  tls = false,
  publicFetcher = fetchPublic,
  strategy = new CaptureStrategy(publicFetcher),
): Server {
  if (!secret) throw new Error("ADAPTER_TOKEN is required");
  const server = new Server({
    "grpc.max_receive_message_length": 64 * 1024,
    "grpc.max_send_message_length": 8 * 1024 * 1024,
  });
  const auth = (call: ServerUnaryCall<any, any>) => {
    const values = call.metadata.get("authorization");
    const actual = Buffer.from(typeof values[0] === "string" ? values[0] : "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (
      values.length !== 1 ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new ProviderError(
        status.UNAUTHENTICATED,
        "invalid adapter authentication",
      );
  };
  const unary =
    (fn: (req: any, signal: AbortSignal) => Promise<any>) =>
    async (call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) => {
      const abort = new AbortController();
      const cancelled = () => abort.abort();
      call.on("cancelled", cancelled);
      const timer = setTimeout(() => abort.abort(), 40000);
      try {
        auth(call);
        callback(null, await fn(call.request, abort.signal));
      } catch (error) {
        const safe =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                abort.signal.aborted
                  ? status.DEADLINE_EXCEEDED
                  : status.UNAVAILABLE,
                "provider request failed",
              );
        callback(safe as ServiceError, null);
      } finally {
        clearTimeout(timer);
        call.off("cancelled", cancelled);
      }
    };
  const handlers = {
    describe: unary(async () => ({
      protocolVersion: "1.0",
      adapterId: "x",
      displayName: "X",
      version: "0.4.0",
      hosts: [
        "x.com",
        "twitter.com",
        "www.x.com",
        "www.twitter.com",
        "mobile.x.com",
        "mobile.twitter.com",
      ],
      entityTypes,
      providers: [
        {
          id: "fxtwitter",
          defaultProvider: true,
          authentication: "none",
          entityTypes: entityTypes.map((t) => t.name),
          capabilities: [
            "capture.fetch",
            "capture.related",
            "capture.page",
            "capture.canonical",
            "content.text",
            "entity.graph",
            "source.raw",
            "media.image",
            "media.video",
          ].map((name) => ({ name, major: 1, minor: 0 })),
          visibilities: [Visibility.VISIBILITY_PUBLIC],
        },
        {
          id: "x-session",
          defaultProvider: true,
          credentialHelp: "Base64 Cookie，需包含 auth_token 和 ct0。",
          authentication: "session",
          entityTypes: entityTypes.map((t) => t.name),
          capabilities: [
            "capture.fetch",
            "capture.related",
            "capture.page",
            "capture.canonical",
            "connection.check",
            "credential.prepare",
            "content.text",
            "entity.graph",
            "source.raw",
            "media.image",
            "media.video",
          ].map((name) => ({ name, major: 1, minor: 0 })),
          visibilities: [
            Visibility.VISIBILITY_PUBLIC,
            Visibility.VISIBILITY_PRIVATE,
          ],
        },
      ],
    })),
    resolve: unary(async (req) => resolveTarget(req.url)),
    prepareCredential: unary(async (req) => {
      if (!tls)
        throw new ProviderError(
          status.FAILED_PRECONDITION,
          "credential import requires TLS",
        );
      if (req.providerId !== "x-session")
        throw new ProviderError(
          status.UNIMPLEMENTED,
          "credential import unsupported",
        );
      return { credential: prepareCredential(req.input) };
    }),
    fetch: unary(async (req, signal) => {
      const target = resolveTarget(req.url);
      if (
        target.externalId !== req.externalId ||
        target.platform !== req.platform ||
        target.kind !== req.kind ||
        target.objectScope !== req.objectScope
      )
        throw new ProviderError(
          status.INVALID_ARGUMENT,
          "invalid target identity",
        );
      if (
        req.providerId === "fxtwitter" &&
        !req.connectionId &&
        req.accessScope === "public" &&
        !req.credential
      )
        return strategy.fetch(req, signal);
      if (
        req.providerId !== "x-session" ||
        !req.connectionId ||
        req.accessScope !== `connection:${req.connectionId}`
      )
        throw new ProviderError(
          status.INVALID_ARGUMENT,
          "invalid provider or connection",
        );
      if (!tls)
        throw new ProviderError(
          status.FAILED_PRECONDITION,
          "account execution requires TLS",
        );
      return strategy.fetch(req, signal, decodeCredential(req.credential));
    }),
    checkConnection: unary(async (req, signal) => {
      if (!tls)
        throw new ProviderError(
          status.FAILED_PRECONDITION,
          "account execution requires TLS",
        );
      if (req.providerId !== "x-session")
        throw new ProviderError(
          status.INVALID_ARGUMENT,
          "unsupported account provider",
        );
      return checkSession(decodeCredential(req.credential), signal);
    }),
  } satisfies Pick<AdapterServer, "describe"> & Partial<AdapterServer>;
  server.addService(AdapterService, handlers);
  const root = protobuf.parse(
    'syntax="proto3"; message HealthCheckRequest { string service=1; } message HealthCheckResponse { int32 status=1; }',
  ).root;
  const request = root.lookupType("HealthCheckRequest"),
    response = root.lookupType("HealthCheckResponse");
  server.addService(
    {
      check: {
        path: "/grpc.health.v1.Health/Check",
        requestStream: false,
        responseStream: false,
        requestSerialize: (v: any) => Buffer.from(request.encode(v).finish()),
        requestDeserialize: (b: Buffer) => request.decode(b),
        responseSerialize: (v: any) => Buffer.from(response.encode(v).finish()),
        responseDeserialize: (b: Buffer) => response.decode(b),
      },
    },
    {
      check: unary(async (req) => {
        if (req.service && req.service !== "adapter.v1.Adapter")
          throw new ProviderError(status.NOT_FOUND, "unknown service");
        return { status: 1 };
      }),
    },
  );
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const cert = process.env.ADAPTER_TLS_CERT,
    key = process.env.ADAPTER_TLS_KEY;
  const server = createServer(
    process.env.ADAPTER_TOKEN ?? "",
    Boolean(cert && key),
  );
  const credentials =
    cert && key
      ? ServerCredentials.createSsl(
          null,
          [{ cert_chain: readFileSync(cert), private_key: readFileSync(key) }],
          false,
        )
      : ServerCredentials.createInsecure();
  server.bindAsync(
    process.env.ADAPTER_LISTEN ?? "0.0.0.0:9091",
    credentials,
    (error) => {
      if (error) {
        process.stderr.write("Adapter startup failed\n");
        process.exitCode = 1;
      } else process.stdout.write("X adapter listening\n");
    },
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => server.tryShutdown(() => process.exit(0)));
}
