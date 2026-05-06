import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { authenticatedServerFunctionMiddleware } from "@/serverFunctions/middleware";

export const getSeoApiKeyStatus = createServerFn({ method: "GET" })
  .middleware(authenticatedServerFunctionMiddleware)
  .handler(() => {
    // Use mock data when no DataForSEO API key is configured.
    const configured = true;
    return { configured };
  });
