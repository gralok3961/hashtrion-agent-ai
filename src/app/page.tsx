import { cookies } from "next/headers";
import { isAuthenticatedSession, SESSION_COOKIE_NAME } from "@/lib/server/auth";
import Chat from "./chat";
import Login from "./login";

export const runtime = "nodejs";

export default async function Home() {
  const cookieStore = await cookies();
  return isAuthenticatedSession(cookieStore.get(SESSION_COOKIE_NAME)?.value)
    ? <Chat />
    : <Login />;
}
