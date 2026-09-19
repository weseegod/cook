import { fileRead } from "../catalog";
import { state } from "../state";
import type { MethodHandler } from "./registry";

export const workspaceHandlers: Record<string, MethodHandler> = {
  "x.ai/fs/read_file": ({ p, respond }) => {
    return respond(fileRead(String(p.path ?? "")));
  },
  "x.ai/fs/exists": ({ p, respond }) => {
    return respond({ result: { exists: state.files[String(p.path ?? "")] !== undefined } });
  },
  "x.ai/fs/write_file": ({ p, respond }) => {
    state.files[String(p.path ?? "")] = String(p.content ?? "");
    return respond({ result: {} });
  },
};
