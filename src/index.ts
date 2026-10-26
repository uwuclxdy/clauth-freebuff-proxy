import { defineProxy, runCli } from "clauth-proxy-core";
import { adapter } from "./adapter.ts";

runCli(defineProxy(adapter));
