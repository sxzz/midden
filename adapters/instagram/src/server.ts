import { CaptureStrategy } from "./strategy.js";
import { resolveTarget } from "./resolve.js";
import { decodeCredential, prepareCredential } from "./credential.js";
import { InstagramClient } from "./client.js";
import { entityTypes, version } from "./entities.js";
import { hosts } from "./resolve.js";
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
import { ProviderError } from "./errors.js";

export function createServer(
  secret: string,
  tls = false,
  strategy = new CaptureStrategy(),
  fetcher: typeof fetch = fetch,
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
      adapterId: "instagram",
      displayName: "Instagram",
      version,
      hosts,
      entityTypes,
      providers: [
        {
          id: "instagram-session",
          defaultProvider: true,
          credentialHelp:
            "Base64 浏览器 Cookie，需包含 sessionid；保留 csrftoken、ds_user_id、mid 和 ig_did。",
          authentication: "session",
          entityTypes: entityTypes.map((t) => t.name),
          capabilities: [
            "capture.fetch",
            "capture.related",
            "capture.page",
            "capture.canonical",
            "capture.access",
            "connection.check",
            "credential.prepare",
            "credential.deferred",
            "content.text",
            "entity.graph",
            "source.raw",
            "media.image",
            "media.video",
          ].map((name) => ({ name, major: 1, minor: 0 })),
          visibilities: [Visibility.VISIBILITY_PRIVATE],
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
      if (req.providerId !== "instagram-session")
        throw new ProviderError(
          status.UNIMPLEMENTED,
          "credential import unsupported",
        );
      return { credential: prepareCredential(req.input) };
    }),
    fetch: unary(async (req, signal) => {
      const target = resolveTarget(req.url);
      if (
        (target.externalId !== req.externalId &&
          !(target.kind === "profile" && /^\d+$/.test(req.externalId))) ||
        target.platform !== req.platform ||
        target.kind !== req.kind ||
        target.objectScope !== req.objectScope
      )
        throw new ProviderError(
          status.INVALID_ARGUMENT,
          "invalid target identity",
        );
      if (
        req.providerId !== "instagram-session" ||
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
      return strategy.fetch(
        req,
        signal,
        req.credentialDeferred && !req.credential
          ? undefined
          : decodeCredential(req.credential),
      );
    }),
    checkAccess: unary(async (req, signal) => {
      const target = resolveTarget(req.url);
      if (
        !["post", "profile"].includes(target.kind) ||
        (target.externalId !== req.target?.externalId &&
          !(
            target.kind === "profile" &&
            /^\d+$/.test(req.target?.externalId ?? "")
          )) ||
        target.platform !== req.target?.platform ||
        target.kind !== req.target?.kind ||
        target.objectScope !== req.target?.objectScope
      )
        throw new ProviderError(
          status.INVALID_ARGUMENT,
          "invalid target identity",
        );
      if (
        req.providerId !== "instagram-session" ||
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
      return strategy.checkAccess(
        req,
        signal,
        decodeCredential(req.credential),
      );
    }),
    checkConnection: unary(async (req, signal) => {
      if (!tls)
        throw new ProviderError(
          status.FAILED_PRECONDITION,
          "account execution requires TLS",
        );
      if (req.providerId !== "instagram-session")
        throw new ProviderError(
          status.INVALID_ARGUMENT,
          "unsupported account provider",
        );
      return new InstagramClient(
        signal,
        decodeCredential(req.credential),
        fetcher,
      ).checkConnection();
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
    process.env.ADAPTER_LISTEN ?? "0.0.0.0:9092",
    credentials,
    (error) => {
      if (error) {
        process.stderr.write("Adapter startup failed\n");
        process.exitCode = 1;
      } else process.stdout.write("Instagram adapter listening\n");
    },
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => server.tryShutdown(() => process.exit(0)));
}
