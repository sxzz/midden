import { execFileSync } from "node:child_process";
for (const adapter of ["x", "instagram"]) {
  execFileSync(
    "protoc",
    [
      "--plugin=protoc-gen-ts_proto=./node_modules/.bin/protoc-gen-ts_proto",
      `--ts_proto_out=adapters/${adapter}/src/generated`,
      "--ts_proto_opt=outputServices=grpc-js,env=node,forceLong=string,useExactTypes=false",
      "api/adapter/v1/adapter.proto",
    ],
    { stdio: "inherit" },
  );
}
