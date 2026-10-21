import { createPlatformProfile } from "../../../lib/server/platform-profile";

export const runtime = "nodejs";

export function GET(): Response {
  return Response.json(createPlatformProfile(), {
    headers: {
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
